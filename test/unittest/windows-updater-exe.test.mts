/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  WINDOWS_STAGE_READY_MARKER,
  getWindowsStagePaths,
  resolveBundledWindowsUpdaterExe,
  type WindowsUpdaterPlan
} from '../../electron/main/windows-update-staging.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const CS_SOURCE_PATH = join(REPO_ROOT, 'resources', 'updater', 'win32', 'OnwardUpdater.cs')

function readPeSubsystem(exePath: string): number {
  const buf = readFileSync(exePath)
  const peOffset = buf.readUInt32LE(0x3c)
  const optionalHeaderOffset = peOffset + 4 + 20
  return buf.readUInt16LE(optionalHeaderOffset + 68)
}

function findCscExe(): string {
  const winDir = process.env.WINDIR || 'C:\\Windows'
  const candidates = [
    join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(winDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('csc.exe not found on Windows host')
}

function compileWinExe(cscPath: string, sourceCode: string, outExePath: string): void {
  const csPath = `${outExePath}.cs`
  writeFileSync(csPath, sourceCode, 'utf-8')
  const res = spawnSync(
    cscPath,
    ['/nologo', '/target:winexe', '/optimize+', `/out:${outExePath}`, csPath],
    { encoding: 'utf-8', windowsHide: true }
  )
  if (res.status !== 0) {
    throw new Error(`Failed compiling ${outExePath}: ${res.stdout}\n${res.stderr}`)
  }
}

async function waitForFile(filePath: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(filePath)) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Timed out waiting for file: ${filePath}`)
}

function runUpdaterWorkerSync(updaterExePath: string, planPath: string): { status: number | null } {
  const res = spawnSync(updaterExePath, ['--worker', '--plan', planPath], {
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 30_000
  })
  return { status: res.status }
}

describe('onward-updater.exe native Windows GUI helper', () => {
  it('ships OnwardUpdater.cs source in repository', () => {
    assert.equal(existsSync(CS_SOURCE_PATH), true)
  })

  it(
    'applies silent quit updates, relaunches with env, and atomically rolls back on FileShare.None locks',
    { skip: process.platform !== 'win32' },
    async () => {
      // Ensure the helper binary is up-to-date first
      const buildRes = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'ensure-windows-updater.js')], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        windowsHide: true
      })
      assert.equal(buildRes.status, 0, buildRes.stderr || buildRes.stdout)

      const updaterExe = resolveBundledWindowsUpdaterExe(null)
      assert.ok(updaterExe && existsSync(updaterExe), 'onward-updater.exe must exist')
      assert.equal(
        readPeSubsystem(updaterExe),
        2,
        'onward-updater.exe must use IMAGE_SUBSYSTEM_WINDOWS_GUI (2) so zero console window ever appears'
      )

      const root = mkdtempSync(join(tmpdir(), 'onward-ut-winexe-'))
      let lockChild: ReturnType<typeof spawn> | null = null

      try {
        const cscPath = findCscExe()
        const helperBinDir = join(root, 'helpers')
        mkdirSync(helperBinDir, { recursive: true })

        const dummyAppTemplateExe = join(helperBinDir, 'TestApp.exe')
        compileWinExe(
          cscPath,
          `
using System;
using System.IO;
internal static class Program {
  [STAThread]
  private static int Main(string[] args) {
    string marker = Environment.GetEnvironmentVariable("TEST_LAUNCH_MARKER");
    if (!string.IsNullOrEmpty(marker)) {
      string baseDir = AppDomain.CurrentDomain.BaseDirectory;
      string verFile = Path.Combine(baseDir, "version.txt");
      string ver = File.Exists(verFile) ? File.ReadAllText(verFile).Trim() : "unknown";
      string dataDir = Environment.GetEnvironmentVariable("ONWARD_USER_DATA_DIR") ?? "";
      File.WriteAllText(marker, ver + "|" + dataDir);
    }
    return 0;
  }
}
`,
          dummyAppTemplateExe
        )

        const lockHolderExe = join(helperBinDir, 'LockHolder.exe')
        compileWinExe(
          cscPath,
          `
using System;
using System.IO;
using System.Threading;
internal static class Program {
  [STAThread]
  private static int Main(string[] args) {
    string targetFile = args[0];
    string readyFile = args[1];
    string releaseFile = args[2];
    using (var fs = new FileStream(targetFile, FileMode.Open, FileAccess.Read, FileShare.Read)) {
      File.WriteAllText(readyFile, "locked");
      var sw = System.Diagnostics.Stopwatch.StartNew();
      while (!File.Exists(releaseFile) && sw.ElapsedMilliseconds < 20000) {
        Thread.Sleep(40);
      }
    }
    return 0;
  }
}
`,
          lockHolderExe
        )

        // ------------------------------------------------------------------
        // Case 1: Normal graceful quit (relaunch: false)
        // ------------------------------------------------------------------
        const case1Dir = join(root, 'case1-install')
        const case1Updates = join(root, 'case1-updates')
        const case1DownloadCache = join(case1Updates, '2.1.0')
        const case1Paths = getWindowsStagePaths(case1Dir)
        mkdirSync(join(case1Dir, 'resources'), { recursive: true })
        mkdirSync(join(case1Paths.stageDir, 'resources'), { recursive: true })
        mkdirSync(case1DownloadCache, { recursive: true })

        writeFileSync(join(case1Dir, 'TestApp.exe'), readFileSync(dummyAppTemplateExe))
        writeFileSync(join(case1Dir, 'version.txt'), '1.0.0', 'utf-8')
        writeFileSync(join(case1Dir, 'resources', 'old-only.txt'), 'old', 'utf-8')
        writeFileSync(join(case1Dir, 'Uninstall TestApp.exe'), 'nsis-uninstaller', 'utf-8')
        writeFileSync(join(case1Dir, 'unins000.dat'), 'unins-data', 'utf-8')

        writeFileSync(join(case1Paths.stageDir, 'TestApp.exe'), readFileSync(dummyAppTemplateExe))
        writeFileSync(join(case1Paths.stageDir, 'version.txt'), '2.1.0', 'utf-8')
        writeFileSync(join(case1Paths.stageDir, 'resources', 'new-only.txt'), 'new', 'utf-8')
        writeFileSync(join(case1Paths.stageDir, WINDOWS_STAGE_READY_MARKER), '{"schemaVersion":1}', 'utf-8')
        writeFileSync(join(case1DownloadCache, 'update.zip'), 'cached-zip', 'utf-8')

        const case1Marker = join(case1Updates, 'pending-update.json')
        writeFileSync(case1Marker, '{}', 'utf-8')
        const case1LaunchSignal = join(root, 'case1-launched.txt')
        const case1Log = join(case1Updates, 'install.log')
        const case1PlanPath = join(root, 'case1-plan.json')

        const case1Plan: WindowsUpdaterPlan = {
          installDir: case1Dir,
          stageDir: case1Paths.stageDir,
          backupDir: case1Paths.backupDir,
          execPath: join(case1Dir, 'TestApp.exe'),
          parentPid: 0,
          relaunch: false,
          targetVersion: '2.1.0',
          logPath: case1Log,
          markerPath: case1Marker,
          lockPath: join(case1Updates, 'install.lock'),
          errorReportPath: join(case1Updates, 'last-install-error.json'),
          cleanupPaths: [case1DownloadCache],
          waitGraceMs: 1000,
          moveRetryMs: 1000,
          killLingeringProcesses: false,
          env: [{ key: 'TEST_LAUNCH_MARKER', value: case1LaunchSignal }]
        }
        writeFileSync(case1PlanPath, JSON.stringify(case1Plan, null, 2), 'utf-8')

        const res1 = runUpdaterWorkerSync(updaterExe, case1PlanPath)
        assert.equal(res1.status, 0)
        assert.equal(readFileSync(join(case1Dir, 'version.txt'), 'utf-8'), '2.1.0')
        assert.equal(existsSync(join(case1Dir, 'resources', 'new-only.txt')), true)
        assert.equal(existsSync(join(case1Dir, 'resources', 'old-only.txt')), false)
        assert.equal(readFileSync(join(case1Dir, 'Uninstall TestApp.exe'), 'utf-8'), 'nsis-uninstaller')
        assert.equal(readFileSync(join(case1Dir, 'unins000.dat'), 'utf-8'), 'unins-data')
        assert.equal(existsSync(case1Paths.stageDir), false, '_ must be consumed')
        assert.equal(existsSync(case1Paths.backupDir), false, '_old must be removed')
        assert.equal(existsSync(case1Marker), false, 'pending-update.json must be removed')
        assert.equal(existsSync(case1DownloadCache), false, 'cached zip dir must be removed')
        assert.equal(existsSync(case1LaunchSignal), false, 'relaunch=false must NOT start the app')
        assert.match(readFileSync(case1Log, 'utf-8'), /Update installed successfully\./)

        // ------------------------------------------------------------------
        // Case 2: Restart-to-update (relaunch: true) + env forwarding
        // ------------------------------------------------------------------
        const case2Dir = join(root, 'case2-install')
        const case2Updates = join(root, 'case2-updates')
        const case2Paths = getWindowsStagePaths(case2Dir)
        mkdirSync(case2Dir, { recursive: true })
        mkdirSync(case2Paths.stageDir, { recursive: true })
        mkdirSync(case2Updates, { recursive: true })

        writeFileSync(join(case2Dir, 'TestApp.exe'), readFileSync(dummyAppTemplateExe))
        writeFileSync(join(case2Dir, 'version.txt'), '1.0.0', 'utf-8')
        writeFileSync(join(case2Paths.stageDir, 'TestApp.exe'), readFileSync(dummyAppTemplateExe))
        writeFileSync(join(case2Paths.stageDir, 'version.txt'), '2.2.0', 'utf-8')
        writeFileSync(join(case2Paths.stageDir, WINDOWS_STAGE_READY_MARKER), '{"schemaVersion":1}', 'utf-8')

        const case2LaunchSignal = join(root, 'case2-launched.txt')
        const case2PlanPath = join(root, 'case2-plan.json')
        const case2Plan: WindowsUpdaterPlan = {
          installDir: case2Dir,
          stageDir: case2Paths.stageDir,
          backupDir: case2Paths.backupDir,
          execPath: join(case2Dir, 'TestApp.exe'),
          parentPid: 0,
          relaunch: true,
          targetVersion: '2.2.0',
          logPath: join(case2Updates, 'install.log'),
          markerPath: join(case2Updates, 'pending-update.json'),
          lockPath: join(case2Updates, 'install.lock'),
          errorReportPath: join(case2Updates, 'last-install-error.json'),
          cleanupPaths: [],
          waitGraceMs: 1000,
          moveRetryMs: 1000,
          killLingeringProcesses: false,
          env: [
            { key: 'TEST_LAUNCH_MARKER', value: case2LaunchSignal },
            { key: 'ONWARD_USER_DATA_DIR', value: 'D:\\Sandbox\\UserData' }
          ]
        }
        writeFileSync(case2PlanPath, JSON.stringify(case2Plan, null, 2), 'utf-8')

        const res2 = runUpdaterWorkerSync(updaterExe, case2PlanPath)
        assert.equal(res2.status, 0)
        await waitForFile(case2LaunchSignal)
        assert.equal(readFileSync(case2LaunchSignal, 'utf-8'), '2.2.0|D:\\Sandbox\\UserData')

        // ------------------------------------------------------------------
        // Case 3: FileShare.None lock fault injection -> rollback -> retry
        // ------------------------------------------------------------------
        const case3Dir = join(root, 'case3-install')
        const case3Updates = join(root, 'case3-updates')
        const case3Paths = getWindowsStagePaths(case3Dir)
        mkdirSync(case3Dir, { recursive: true })
        mkdirSync(case3Paths.stageDir, { recursive: true })
        mkdirSync(case3Updates, { recursive: true })

        // "00-early.txt" sorts before "zz-locked.dll" so it moves into _old first,
        // proving partial moves are rolled back completely when a subsequent file fails.
        writeFileSync(join(case3Dir, '00-early.txt'), 'early-v1', 'utf-8')
        writeFileSync(join(case3Dir, 'TestApp.exe'), readFileSync(dummyAppTemplateExe))
        writeFileSync(join(case3Dir, 'version.txt'), '1.0.0', 'utf-8')
        const lockedDllPath = join(case3Dir, 'zz-locked.dll')
        writeFileSync(lockedDllPath, 'dll-v1', 'utf-8')

        writeFileSync(join(case3Paths.stageDir, '00-early.txt'), 'early-v2', 'utf-8')
        writeFileSync(join(case3Paths.stageDir, 'TestApp.exe'), readFileSync(dummyAppTemplateExe))
        writeFileSync(join(case3Paths.stageDir, 'version.txt'), '2.3.0', 'utf-8')
        writeFileSync(join(case3Paths.stageDir, 'zz-locked.dll'), 'dll-v2', 'utf-8')
        writeFileSync(join(case3Paths.stageDir, WINDOWS_STAGE_READY_MARKER), '{"schemaVersion":1}', 'utf-8')

        const lockReadySignal = join(root, 'lock-ready.txt')
        const lockReleaseSignal = join(root, 'lock-release.txt')
        lockChild = spawn(lockHolderExe, [lockedDllPath, lockReadySignal, lockReleaseSignal], {
          stdio: 'ignore',
          windowsHide: true
        })
        await waitForFile(lockReadySignal)

        const rollbackRelaunchSignal = join(root, 'case3-rollback-relaunch.txt')
        const errorReportPath = join(case3Updates, 'last-install-error.json')
        const case3PlanPath = join(root, 'case3-plan.json')
        const case3Plan: WindowsUpdaterPlan = {
          installDir: case3Dir,
          stageDir: case3Paths.stageDir,
          backupDir: case3Paths.backupDir,
          execPath: join(case3Dir, 'TestApp.exe'),
          parentPid: 0,
          relaunch: true,
          targetVersion: '2.3.0',
          logPath: join(case3Updates, 'install.log'),
          markerPath: join(case3Updates, 'pending-update.json'),
          lockPath: join(case3Updates, 'install.lock'),
          errorReportPath,
          cleanupPaths: [],
          waitGraceMs: 500,
          moveRetryMs: 500,
          killLingeringProcesses: false,
          env: [
            { key: 'TEST_LAUNCH_MARKER', value: rollbackRelaunchSignal },
            { key: 'ONWARD_USER_DATA_DIR', value: 'rollback-run' }
          ]
        }
        writeFileSync(case3PlanPath, JSON.stringify(case3Plan, null, 2), 'utf-8')

        const failedRes = runUpdaterWorkerSync(updaterExe, case3PlanPath)
        assert.equal(failedRes.status, 1, 'locked swap must fail cleanly with exit code 1')

        // Live installation must be 100% rolled back to v1
        assert.equal(readFileSync(join(case3Dir, '00-early.txt'), 'utf-8'), 'early-v1')
        assert.equal(readFileSync(join(case3Dir, 'version.txt'), 'utf-8'), '1.0.0')
        assert.equal(readFileSync(lockedDllPath, 'utf-8'), 'dll-v1')
        assert.equal(existsSync(case3Paths.backupDir), false, '_old must be restored and removed')

        // Staged "_" must remain intact for instant retry without re-downloading
        assert.equal(existsSync(case3Paths.stageDir), true, '_ must be preserved on rollback')
        assert.equal(existsSync(join(case3Paths.stageDir, WINDOWS_STAGE_READY_MARKER)), true)
        assert.equal(readFileSync(join(case3Paths.stageDir, 'version.txt'), 'utf-8'), '2.3.0')

        // Error report written + rolled-back v1 relaunched
        assert.equal(existsSync(errorReportPath), true)
        const errJson = JSON.parse(readFileSync(errorReportPath, 'utf-8'))
        assert.equal(errJson.rolledBack, true)
        assert.equal(errJson.targetVersion, '2.3.0')
        await waitForFile(rollbackRelaunchSignal)
        assert.equal(readFileSync(rollbackRelaunchSignal, 'utf-8'), '1.0.0|rollback-run')

        // Release external lock and retry using the preserved "_"
        writeFileSync(lockReleaseSignal, 'release', 'utf-8')
        await new Promise<void>((resolveExit) => {
          if (!lockChild || lockChild.exitCode !== null) {
            resolveExit()
            return
          }
          lockChild.once('exit', () => resolveExit())
        })
        lockChild = null

        const retryLaunchSignal = join(root, 'case3-retry-relaunch.txt')
        case3Plan.env = [
          { key: 'TEST_LAUNCH_MARKER', value: retryLaunchSignal },
          { key: 'ONWARD_USER_DATA_DIR', value: 'retry-run' }
        ]
        writeFileSync(case3PlanPath, JSON.stringify(case3Plan, null, 2), 'utf-8')

        const retryRes = runUpdaterWorkerSync(updaterExe, case3PlanPath)
        assert.equal(retryRes.status, 0)
        assert.equal(readFileSync(join(case3Dir, 'version.txt'), 'utf-8'), '2.3.0')
        assert.equal(readFileSync(lockedDllPath, 'utf-8'), 'dll-v2')
        assert.equal(existsSync(case3Paths.stageDir), false)
        await waitForFile(retryLaunchSignal)
        assert.equal(readFileSync(retryLaunchSignal, 'utf-8'), '2.3.0|retry-run')
      } finally {
        if (lockChild && lockChild.exitCode === null) {
          try {
            lockChild.kill()
          } catch {
            // ignore
          }
        }
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
