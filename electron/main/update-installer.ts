/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { execSync, spawn } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

export interface UpdateInstallInput {
  archivePath: string
}

const RELAUNCH_ENV_KEYS = [
  'ONWARD_USER_DATA_DIR',
  'ONWARD_DEBUG',
  'ONWARD_UPDATE_CHECK_INTERVAL_MS',
  'ONWARD_UPDATE_BASE_URL',
  'ONWARD_AUTOTEST',
  'ONWARD_AUTOTEST_CWD',
  'ONWARD_AUTOTEST_EXIT',
  'ONWARD_DEBUG_CAPTURE'
] as const

export function canInstallUpdatesOnCurrentPlatform(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
}

export function resolveUpdateLogPath(): string {
  return join(app.getPath('userData'), 'updates', 'install.log')
}

export function installDownloadedUpdateOnQuit(input: UpdateInstallInput): boolean {
  if (process.platform === 'darwin') {
    return installDownloadedUpdateOnQuitMacOS(input)
  }
  if (process.platform === 'win32') {
    return installDownloadedUpdateOnQuitWindows(input)
  }
  return false
}

function resolveCurrentInstallPath(): string | null {
  const exePath = app.getPath('exe')
  if (process.platform === 'darwin') {
    return dirname(dirname(dirname(exePath)))
  }
  if (process.platform === 'win32') {
    return dirname(exePath)
  }
  return null
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function powershellEscape(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function installDownloadedUpdateOnQuitMacOS(input: UpdateInstallInput): boolean {
  const bundlePath = resolveCurrentInstallPath()
  if (!bundlePath) return false

  const stagingRoot = join(tmpdir(), `onward-update-${Date.now()}`)
  mkdirSync(stagingRoot, { recursive: true })
  const scriptPath = join(stagingRoot, 'install-update.sh')
  const logPath = resolveUpdateLogPath()
  const relaunchEnvAssignments = RELAUNCH_ENV_KEYS
    .map((key) => {
      const value = process.env[key]
      if (!value) return null
      return `${key}=${shellEscape(value)}`
    })
    .filter((value): value is string => Boolean(value))
    .join(' ')

  const scriptContent = [
    '#!/bin/sh',
    'set -eu',
    `APP_PATH=${shellEscape(bundlePath)}`,
    `EXEC_PATH=${shellEscape(app.getPath('exe'))}`,
    `ARCHIVE_PATH=${shellEscape(input.archivePath)}`,
    `PARENT_PID=${process.pid}`,
    `STAGING_ROOT=${shellEscape(stagingRoot)}`,
    `LOG_PATH=${shellEscape(logPath)}`,
    `RELAUNCH_ENV_ASSIGNMENTS=${shellEscape(relaunchEnvAssignments)}`,
    'EXTRACT_ROOT="$STAGING_ROOT/extracted"',
    'BACKUP_PATH="$APP_PATH.onward-backup"',
    'mkdir -p "$(dirname "$LOG_PATH")"',
    'log() {',
    '  printf "%s %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$1" >> "$LOG_PATH"',
    '}',
    'restore_backup() {',
    '  if [ ! -d "$APP_PATH" ] && [ -d "$BACKUP_PATH" ]; then',
    '    mv "$BACKUP_PATH" "$APP_PATH"',
    '  fi',
    '}',
    'handle_error() {',
    '  local exit_code=$?',
    '  log "Update install failed: exit code $exit_code (last command at line $1)"',
    '  restore_backup',
    '}',
    'trap \'handle_error $LINENO\' EXIT',
    'log "Starting update install helper."',
    'for _ in $(seq 1 120); do',
    '  if ! kill -0 "$PARENT_PID" 2>/dev/null; then',
    '    log "Detected parent process exit."',
    '    break',
    '  fi',
    '  sleep 1',
    'done',
    'rm -rf "$EXTRACT_ROOT" "$BACKUP_PATH"',
    'mkdir -p "$EXTRACT_ROOT"',
    'log "Extracting update archive."',
    'ditto -x -k "$ARCHIVE_PATH" "$EXTRACT_ROOT"',
    'NEW_APP_PATH="$(find "$EXTRACT_ROOT" -maxdepth 1 -name \'*.app\' -print -quit)"',
    'if [ -z "$NEW_APP_PATH" ]; then',
    '  log "No .app bundle found in extracted archive."',
    '  exit 1',
    'fi',
    'log "Replacing app bundle with downloaded update."',
    'mv "$APP_PATH" "$BACKUP_PATH"',
    'mv "$NEW_APP_PATH" "$APP_PATH"',
    'trap - EXIT',
    'rm -rf "$BACKUP_PATH" "$EXTRACT_ROOT"',
    'log "Update installed successfully."',
    'log "Relaunching updated app."',
    'if [ -n "$RELAUNCH_ENV_ASSIGNMENTS" ]; then',
    '  eval "/usr/bin/env $RELAUNCH_ENV_ASSIGNMENTS \\"$EXEC_PATH\\"" >/dev/null 2>&1 &',
    'else',
    '  open -n "$APP_PATH"',
    'fi',
    'rm -f "$ARCHIVE_PATH" "$0"',
    'rmdir "$STAGING_ROOT" 2>/dev/null || true'
  ].join('\n')

  writeFileSync(scriptPath, `${scriptContent}\n`, { encoding: 'utf-8', mode: 0o755 })
  spawn('/bin/sh', [scriptPath], {
    detached: true,
    stdio: 'ignore'
  }).unref()
  return true
}

function installDownloadedUpdateOnQuitWindows(input: UpdateInstallInput): boolean {
  const installDir = resolveCurrentInstallPath()
  if (!installDir) return false

  const stagingId = Date.now().toString(36)
  const stagingRoot = join(process.env.TEMP || tmpdir(), `ou-${stagingId}`)
  mkdirSync(stagingRoot, { recursive: true })
  const scriptPath = join(stagingRoot, 'up.ps1')
  const logPath = resolveUpdateLogPath()
  const execPath = app.getPath('exe')

  const envSetStatements = RELAUNCH_ENV_KEYS
    .map((key) => {
      const value = process.env[key]
      if (!value) return null
      return `$env:${key} = ${powershellEscape(value)}`
    })
    .filter((value): value is string => Boolean(value))
    .join('\n')

  const scriptContent = [
    '$ErrorActionPreference = "Stop"',
    `$installDir = ${powershellEscape(installDir)}`,
    `$execPath = ${powershellEscape(execPath)}`,
    `$archivePath = ${powershellEscape(input.archivePath)}`,
    `$parentPid = ${process.pid}`,
    `$stagingRoot = ${powershellEscape(stagingRoot)}`,
    `$logPath = ${powershellEscape(logPath)}`,
    '$extractRoot = Join-Path $stagingRoot "e"',
    '$backupPath = "${installDir}.bak"',
    '',
    'function Write-Log($msg) {',
    '    $dir = Split-Path $logPath -Parent',
    '    if (-not (Test-Path $dir)) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }',
    '    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"',
    '    Add-Content -Path $logPath -Value "$ts $msg" -ErrorAction SilentlyContinue',
    '}',
    '',
    'try {',
    '    Write-Log "Starting Windows update install helper."',
    '',
    '    try {',
    '        $proc = Get-Process -Id $parentPid -ErrorAction SilentlyContinue',
    '        if ($proc) {',
    '            Write-Log "Waiting for parent process ($parentPid) to exit."',
    '            $proc.WaitForExit(120000) | Out-Null',
    '        }',
    '    } catch { }',
    '    Write-Log "Parent process exited."',
    '',
    '    if (Test-Path $extractRoot) { Remove-Item $extractRoot -Recurse -Force }',
    '    if (Test-Path $backupPath) { Remove-Item $backupPath -Recurse -Force }',
    '',
    '    Write-Log "Extracting update archive."',
    '    Expand-Archive -Path $archivePath -DestinationPath $extractRoot -Force',
    '',
    '    $extractedItems = Get-ChildItem $extractRoot',
    '    if ($extractedItems.Count -eq 1 -and $extractedItems[0].PSIsContainer) {',
    '        $sourceDir = $extractedItems[0].FullName',
    '    } else {',
    '        $sourceDir = $extractRoot',
    '    }',
    '',
    '    Write-Log "Backing up current installation."',
    '    Rename-Item -Path $installDir -NewName (Split-Path $backupPath -Leaf) -Force',
    '',
    '    Write-Log "Installing update."',
    '    if ($sourceDir -ne $extractRoot) {',
    '        Move-Item -Path $sourceDir -Destination $installDir -Force',
    '    } else {',
    '        New-Item -Path $installDir -ItemType Directory -Force | Out-Null',
    '        Get-ChildItem $extractRoot | Move-Item -Destination $installDir -Force',
    '    }',
    '',
    '    Write-Log "Relaunching updated app."',
    envSetStatements,
    '    Start-Process -FilePath $execPath',
    '',
    '    Remove-Item $backupPath -Recurse -Force -ErrorAction SilentlyContinue',
    '    Remove-Item $extractRoot -Recurse -Force -ErrorAction SilentlyContinue',
    '    Remove-Item $archivePath -Force -ErrorAction SilentlyContinue',
    '',
    '    Write-Log "Update installed successfully."',
    '} catch {',
    '    Write-Log "Update install failed: $_"',
    '    if (-not (Test-Path $installDir) -and (Test-Path $backupPath)) {',
    '        Rename-Item -Path $backupPath -NewName (Split-Path $installDir -Leaf) -Force',
    '        Write-Log "Restored backup after failure."',
    '    }',
    '}'
  ].join('\n')

  writeFileSync(scriptPath, scriptContent, { encoding: 'utf-8' })

  const psPath = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const batPath = join(stagingRoot, 'up.bat')
  const batContent = `@echo off\r\nstart "" /min "${psPath}" -ExecutionPolicy Bypass -File "${scriptPath}"\r\n`
  writeFileSync(batPath, batContent, { encoding: 'utf-8' })

  try {
    execSync(`"${batPath}"`, { windowsHide: true, stdio: 'ignore', timeout: 5000 })
  } catch {
    const child = spawn(psPath, ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.on('error', () => {})
    child.unref()
  }

  return true
}
