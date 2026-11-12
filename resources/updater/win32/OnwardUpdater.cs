/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure Windows GUI-subsystem (/target:winexe) background update applier.
 * Swaps a pre-extracted staging directory ("_") into the live installation
 * directory with atomic backup ("_old") and automatic rollback on file locks.
 * Never allocates a console window (PE subsystem = WINDOWS_GUI).
 */

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading;

namespace OnwardUpdater
{
    [DataContract]
    public sealed class EnvEntry
    {
        [DataMember(Name = "key")]
        public string Key { get; set; }

        [DataMember(Name = "value")]
        public string Value { get; set; }
    }

    [DataContract]
    public sealed class UpdatePlan
    {
        [DataMember(Name = "installDir")]
        public string InstallDir { get; set; }

        [DataMember(Name = "stageDir")]
        public string StageDir { get; set; }

        [DataMember(Name = "backupDir")]
        public string BackupDir { get; set; }

        [DataMember(Name = "execPath")]
        public string ExecPath { get; set; }

        [DataMember(Name = "parentPid")]
        public int ParentPid { get; set; }

        [DataMember(Name = "relaunch")]
        public bool Relaunch { get; set; }

        [DataMember(Name = "targetVersion")]
        public string TargetVersion { get; set; }

        [DataMember(Name = "logPath")]
        public string LogPath { get; set; }

        [DataMember(Name = "markerPath")]
        public string MarkerPath { get; set; }

        [DataMember(Name = "lockPath")]
        public string LockPath { get; set; }

        [DataMember(Name = "errorReportPath")]
        public string ErrorReportPath { get; set; }

        [DataMember(Name = "cleanupPaths")]
        public List<string> CleanupPaths { get; set; }

        [DataMember(Name = "waitGraceMs")]
        public int WaitGraceMs { get; set; }

        [DataMember(Name = "moveRetryMs")]
        public int MoveRetryMs { get; set; }

        [DataMember(Name = "killLingeringProcesses")]
        public bool KillLingeringProcesses { get; set; }

        [DataMember(Name = "env")]
        public List<EnvEntry> Env { get; set; }
    }

    [DataContract]
    public sealed class InstallErrorReport
    {
        [DataMember(Name = "timestamp")]
        public long Timestamp { get; set; }

        [DataMember(Name = "targetVersion")]
        public string TargetVersion { get; set; }

        [DataMember(Name = "error")]
        public string Error { get; set; }

        [DataMember(Name = "rolledBack")]
        public bool RolledBack { get; set; }
    }

    internal sealed class MovedEntry
    {
        public string SourcePath;
        public string DestinationPath;
        public bool IsDirectory;
    }

    internal static class NativeMethods
    {
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
        public const uint CREATE_NO_WINDOW = 0x08000000;
        public const uint DETACHED_PROCESS = 0x00000008;
        public const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool QueryFullProcessImageName(
            IntPtr hProcess,
            int dwFlags,
            StringBuilder lpExeName,
            ref int lpdwSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcess(
            string lpApplicationName,
            StringBuilder lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation);

        public static string TryGetProcessImagePath(int pid)
        {
            IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (handle == IntPtr.Zero)
            {
                return null;
            }

            try
            {
                int capacity = 2048;
                StringBuilder buffer = new StringBuilder(capacity);
                if (QueryFullProcessImageName(handle, 0, buffer, ref capacity))
                {
                    return buffer.ToString(0, capacity);
                }
                return null;
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        public static bool TrySpawnBreakawayWorker(string exePath, string planPath)
        {
            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            PROCESS_INFORMATION pi;

            string cmd = "\"" + exePath.Replace("\"", "\\\"") + "\" --worker --plan \"" + planPath.Replace("\"", "\\\"") + "\"";
            StringBuilder cmdLine = new StringBuilder(cmd);
            uint flags = CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;

            bool created = CreateProcess(
                exePath,
                cmdLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                flags,
                IntPtr.Zero,
                Path.GetDirectoryName(exePath),
                ref si,
                out pi);

            if (!created)
            {
                return false;
            }

            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            return true;
        }
    }

    public static class Program
    {
        private const string StageReadyMarkerFileName = ".onward-stage-ready.json";

        [STAThread]
        public static int Main(string[] args)
        {
            string planPath = null;
            bool isWorker = false;

            for (int i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], "--worker", StringComparison.Ordinal))
                {
                    isWorker = true;
                }
                else if (string.Equals(args[i], "--plan", StringComparison.Ordinal) && i + 1 < args.Length)
                {
                    planPath = args[i + 1];
                    i++;
                }
            }

            if (string.IsNullOrEmpty(planPath) || !File.Exists(planPath))
            {
                return 2;
            }

            UpdatePlan plan;
            try
            {
                plan = ReadPlan(planPath);
            }
            catch
            {
                return 3;
            }

            if (!isWorker)
            {
                try
                {
                    string selfPath = Process.GetCurrentProcess().MainModule.FileName;
                    if (NativeMethods.TrySpawnBreakawayWorker(selfPath, planPath))
                    {
                        WriteLog(plan.LogPath, "Updater bootstrap spawned breakaway worker.");
                        return 0;
                    }
                }
                catch
                {
                    // Fall through and execute directly in the current process if breakaway is disallowed.
                }
            }

            return RunWorker(plan);
        }

        private static UpdatePlan ReadPlan(string planPath)
        {
            using (FileStream stream = new FileStream(planPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(UpdatePlan));
                return (UpdatePlan)serializer.ReadObject(stream);
            }
        }

        private static void WriteErrorReport(UpdatePlan plan, string errorMessage, bool rolledBack)
        {
            if (string.IsNullOrEmpty(plan.ErrorReportPath)) return;
            try
            {
                string dir = Path.GetDirectoryName(plan.ErrorReportPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                InstallErrorReport report = new InstallErrorReport
                {
                    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    TargetVersion = plan.TargetVersion ?? "",
                    Error = errorMessage ?? "unknown error",
                    RolledBack = rolledBack
                };
                using (FileStream stream = new FileStream(plan.ErrorReportPath, FileMode.Create, FileAccess.Write, FileShare.Read))
                {
                    DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(InstallErrorReport));
                    serializer.WriteObject(stream, report);
                }
            }
            catch
            {
                // Non-critical diagnostic output
            }
        }

        private static void ClearFileSafe(string filePath)
        {
            if (string.IsNullOrEmpty(filePath)) return;
            try
            {
                if (File.Exists(filePath)) File.Delete(filePath);
            }
            catch { }
        }

        private static void WriteLog(string logPath, string message)
        {
            if (string.IsNullOrEmpty(logPath)) return;
            try
            {
                string dir = Path.GetDirectoryName(logPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine;
                File.AppendAllText(logPath, line, new UTF8Encoding(false));
            }
            catch { }
        }

        private static string NormalizeDirPrefix(string dirPath)
        {
            string full = Path.GetFullPath(dirPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return full + Path.DirectorySeparatorChar;
        }

        private static bool IsUninstallerName(string fileName)
        {
            if (string.IsNullOrEmpty(fileName)) return false;
            return fileName.StartsWith("Uninstall ", StringComparison.OrdinalIgnoreCase)
                || fileName.StartsWith("unins", StringComparison.OrdinalIgnoreCase);
        }

        private static List<Process> FindProcessesInInstallDir(string installDirPrefix, int currentPid)
        {
            List<Process> matches = new List<Process>();
            Process[] all = Process.GetProcesses();
            foreach (Process proc in all)
            {
                bool keep = false;
                try
                {
                    if (proc.Id == currentPid || proc.Id <= 4) continue;
                    string imagePath = NativeMethods.TryGetProcessImagePath(proc.Id);
                    if (string.IsNullOrEmpty(imagePath)) continue;
                    string fullImagePath = Path.GetFullPath(imagePath);
                    if (!fullImagePath.StartsWith(installDirPrefix, StringComparison.OrdinalIgnoreCase)) continue;
                    string leaf = Path.GetFileName(fullImagePath);
                    if (IsUninstallerName(leaf)) continue;
                    matches.Add(proc);
                    keep = true;
                }
                catch
                {
                    // Process already exited or inaccessible
                }
                finally
                {
                    if (!keep)
                    {
                        try { proc.Dispose(); } catch { }
                    }
                }
            }
            return matches;
        }

        private static void DisposeProcesses(List<Process> list)
        {
            if (list == null) return;
            foreach (Process p in list)
            {
                try { p.Dispose(); } catch { }
            }
        }

        private static bool WaitForParentExit(int parentPid, int timeoutMs, string logPath)
        {
            if (parentPid <= 0) return true;
            try
            {
                using (Process parent = Process.GetProcessById(parentPid))
                {
                    WriteLog(logPath, "Waiting for parent process (" + parentPid + ") to exit.");
                    return parent.WaitForExit(timeoutMs);
                }
            }
            catch (ArgumentException)
            {
                return true;
            }
            catch
            {
                return true;
            }
        }

        private static void WaitAndCleanInstallDirProcesses(string installDir, int waitGraceMs, bool allowKill, string logPath)
        {
            int currentPid = Process.GetCurrentProcess().Id;
            string prefix = NormalizeDirPrefix(installDir);
            Stopwatch sw = Stopwatch.StartNew();

            while (sw.ElapsedMilliseconds < waitGraceMs)
            {
                List<Process> active = FindProcessesInInstallDir(prefix, currentPid);
                if (active.Count == 0)
                {
                    return;
                }
                DisposeProcesses(active);
                Thread.Sleep(200);
            }

            List<Process> remaining = FindProcessesInInstallDir(prefix, currentPid);
            if (remaining.Count == 0) return;

            try
            {
                if (!allowKill)
                {
                    throw new InvalidOperationException("Processes inside installDir are still running after grace period (" + remaining.Count + ").");
                }

                foreach (Process proc in remaining)
                {
                    try
                    {
                        WriteLog(logPath, "Terminating lingering helper process inside installDir: PID=" + proc.Id);
                        proc.Kill();
                    }
                    catch { }
                }

                Stopwatch killWait = Stopwatch.StartNew();
                while (killWait.ElapsedMilliseconds < 3000)
                {
                    List<Process> check = FindProcessesInInstallDir(prefix, currentPid);
                    int count = check.Count;
                    DisposeProcesses(check);
                    if (count == 0) break;
                    Thread.Sleep(150);
                }
            }
            finally
            {
                DisposeProcesses(remaining);
            }
        }

        private static void MoveEntryWithRetry(string sourcePath, string destinationPath, bool isDirectory, int retryBudgetMs)
        {
            int budget = Math.Max(0, retryBudgetMs);
            Stopwatch sw = Stopwatch.StartNew();
            Exception lastError = null;

            while (true)
            {
                try
                {
                    if (isDirectory)
                    {
                        Directory.Move(sourcePath, destinationPath);
                    }
                    else
                    {
                        File.Move(sourcePath, destinationPath);
                    }
                    return;
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    if (sw.ElapsedMilliseconds >= budget)
                    {
                        break;
                    }
                    Thread.Sleep(200);
                }
            }

            throw new IOException(
                "Failed to move '" + sourcePath + "' to '" + destinationPath + "': " + (lastError != null ? lastError.Message : "unknown"),
                lastError);
        }

        private static void DeleteDirectoryBestEffort(string dirPath, int retryMs)
        {
            if (string.IsNullOrEmpty(dirPath) || !Directory.Exists(dirPath)) return;
            Stopwatch sw = Stopwatch.StartNew();
            while (true)
            {
                try
                {
                    Directory.Delete(dirPath, true);
                    return;
                }
                catch
                {
                    if (sw.ElapsedMilliseconds >= retryMs) return;
                    Thread.Sleep(200);
                }
            }
        }

        private static void DeletePathBestEffort(string targetPath, int retryMs)
        {
            if (string.IsNullOrEmpty(targetPath)) return;
            if (Directory.Exists(targetPath))
            {
                DeleteDirectoryBestEffort(targetPath, retryMs);
                return;
            }
            if (File.Exists(targetPath))
            {
                Stopwatch sw = Stopwatch.StartNew();
                while (true)
                {
                    try
                    {
                        File.Delete(targetPath);
                        return;
                    }
                    catch
                    {
                        if (sw.ElapsedMilliseconds >= retryMs) return;
                        Thread.Sleep(150);
                    }
                }
            }
        }

        private static void RelaunchApp(UpdatePlan plan, string reason)
        {
            if (!plan.Relaunch) return;
            if (string.IsNullOrEmpty(plan.ExecPath) || !File.Exists(plan.ExecPath))
            {
                WriteLog(plan.LogPath, "Cannot relaunch (" + reason + "): executable missing at " + plan.ExecPath);
                return;
            }

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = plan.ExecPath;
                psi.WorkingDirectory = plan.InstallDir;
                psi.UseShellExecute = false;

                if (plan.Env != null)
                {
                    foreach (EnvEntry entry in plan.Env)
                    {
                        if (entry != null && !string.IsNullOrEmpty(entry.Key) && entry.Value != null)
                        {
                            psi.EnvironmentVariables[entry.Key] = entry.Value;
                        }
                    }
                }

                WriteLog(plan.LogPath, "Relaunching " + reason + ": " + plan.ExecPath);
                Process started = Process.Start(psi);
                if (started != null) started.Dispose();
            }
            catch (Exception ex)
            {
                WriteLog(plan.LogPath, "Failed to relaunch (" + reason + "): " + ex.Message);
            }
        }

        private static bool AcquireLock(string lockPath, string logPath)
        {
            if (string.IsNullOrEmpty(lockPath)) return true;
            try
            {
                string lockDir = Path.GetDirectoryName(lockPath);
                if (!string.IsNullOrEmpty(lockDir)) Directory.CreateDirectory(lockDir);

                if (File.Exists(lockPath))
                {
                    DateTime lastWrite = File.GetLastWriteTimeUtc(lockPath);
                    if ((DateTime.UtcNow - lastWrite).TotalMinutes > 10)
                    {
                        WriteLog(logPath, "Removing stale updater lock: " + lockPath);
                        File.Delete(lockPath);
                    }
                }

                using (FileStream fs = new FileStream(lockPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    byte[] pidBytes = Encoding.UTF8.GetBytes(Process.GetCurrentProcess().Id.ToString());
                    fs.Write(pidBytes, 0, pidBytes.Length);
                }
                return true;
            }
            catch (Exception ex)
            {
                WriteLog(logPath, "Another updater worker is already active: " + ex.Message);
                return false;
            }
        }

        private static void RollbackMoves(List<MovedEntry> entries, int retryBudgetMs, string logPath, string label)
        {
            for (int i = entries.Count - 1; i >= 0; i--)
            {
                MovedEntry item = entries[i];
                try
                {
                    if (item.IsDirectory)
                    {
                        if (Directory.Exists(item.DestinationPath) && !Directory.Exists(item.SourcePath))
                        {
                            MoveEntryWithRetry(item.DestinationPath, item.SourcePath, true, retryBudgetMs);
                        }
                    }
                    else
                    {
                        if (File.Exists(item.DestinationPath) && !File.Exists(item.SourcePath))
                        {
                            MoveEntryWithRetry(item.DestinationPath, item.SourcePath, false, retryBudgetMs);
                        }
                    }
                }
                catch (Exception ex)
                {
                    WriteLog(logPath, "Rollback warning (" + label + ") for '" + item.SourcePath + "': " + ex.Message);
                }
            }
        }

        private static int RunWorker(UpdatePlan plan)
        {
            int waitGraceMs = plan.WaitGraceMs > 0 ? plan.WaitGraceMs : 15000;
            int moveRetryMs = plan.MoveRetryMs >= 0 ? plan.MoveRetryMs : 10000;
            bool lockAcquired = false;
            bool parentExited = false;

            try
            {
                WriteLog(
                    plan.LogPath,
                    "Starting Windows GUI updater worker. PID=" + Process.GetCurrentProcess().Id +
                    " Target=" + (plan.TargetVersion ?? "") +
                    " Relaunch=" + plan.Relaunch);

                if (!AcquireLock(plan.LockPath, plan.LogPath))
                {
                    return 0;
                }
                lockAcquired = true;

                parentExited = WaitForParentExit(plan.ParentPid, Math.Max(waitGraceMs, 30000), plan.LogPath);
                if (!parentExited)
                {
                    throw new TimeoutException("Parent process " + plan.ParentPid + " did not exit within timeout.");
                }

                WaitAndCleanInstallDirProcesses(plan.InstallDir, waitGraceMs, plan.KillLingeringProcesses, plan.LogPath);

                string exeLeafName = Path.GetFileName(plan.ExecPath);
                string stagedExePath = Path.Combine(plan.StageDir, exeLeafName);
                if (!Directory.Exists(plan.StageDir) || !File.Exists(stagedExePath))
                {
                    throw new FileNotFoundException("Staged executable is missing: " + stagedExePath);
                }

                // Clean any leftover backup directory before starting atomic swap.
                if (Directory.Exists(plan.BackupDir))
                {
                    DeleteDirectoryBestEffort(plan.BackupDir, 3000);
                    if (Directory.Exists(plan.BackupDir))
                    {
                        throw new IOException("Unable to clean previous backup directory: " + plan.BackupDir);
                    }
                }
                Directory.CreateDirectory(plan.BackupDir);

                string stageLeaf = Path.GetFileName(plan.StageDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
                string backupLeaf = Path.GetFileName(plan.BackupDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));

                List<MovedEntry> movedToOld = new List<MovedEntry>();
                List<MovedEntry> promotedFromStage = new List<MovedEntry>();

                // Phase 1: Move current live files and directories in installDir into _old.
                try
                {
                    string[] existingEntries = Directory.GetFileSystemEntries(plan.InstallDir);
                    // Move main executable first so the tightest lock check fails immediately before touching anything else.
                    Array.Sort(existingEntries, (a, b) =>
                    {
                        bool aIsMainExe = string.Equals(Path.GetFileName(a), exeLeafName, StringComparison.OrdinalIgnoreCase);
                        bool bIsMainExe = string.Equals(Path.GetFileName(b), exeLeafName, StringComparison.OrdinalIgnoreCase);
                        if (aIsMainExe && !bIsMainExe) return -1;
                        if (!aIsMainExe && bIsMainExe) return 1;
                        return string.Compare(a, b, StringComparison.OrdinalIgnoreCase);
                    });

                    foreach (string entryPath in existingEntries)
                    {
                        string name = Path.GetFileName(entryPath);
                        if (string.Equals(name, stageLeaf, StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(name, backupLeaf, StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(name, "_staging", StringComparison.OrdinalIgnoreCase) ||
                            IsUninstallerName(name))
                        {
                            continue;
                        }

                        bool isDir = Directory.Exists(entryPath);
                        string backupTarget = Path.Combine(plan.BackupDir, name);
                        MoveEntryWithRetry(entryPath, backupTarget, isDir, moveRetryMs);
                        movedToOld.Add(new MovedEntry
                        {
                            SourcePath = entryPath,
                            DestinationPath = backupTarget,
                            IsDirectory = isDir
                        });
                    }
                }
                catch (Exception ex)
                {
                    WriteLog(plan.LogPath, "Phase 1 move to backup failed, rolling back: " + ex.Message);
                    RollbackMoves(movedToOld, Math.Max(moveRetryMs, 3000), plan.LogPath, "phase1");
                    DeleteDirectoryBestEffort(plan.BackupDir, 2000);
                    WriteErrorReport(plan, ex.Message, true);
                    throw;
                }

                // Phase 2: Promote staged files and directories from _ into installDir.
                try
                {
                    string[] stagedEntries = Directory.GetFileSystemEntries(plan.StageDir);
                    foreach (string stageEntryPath in stagedEntries)
                    {
                        string name = Path.GetFileName(stageEntryPath);
                        if (string.Equals(name, StageReadyMarkerFileName, StringComparison.OrdinalIgnoreCase))
                        {
                            continue;
                        }

                        bool isDir = Directory.Exists(stageEntryPath);
                        string liveTarget = Path.Combine(plan.InstallDir, name);
                        if (IsUninstallerName(name) && (File.Exists(liveTarget) || Directory.Exists(liveTarget)))
                        {
                            DeletePathBestEffort(liveTarget, 2000);
                        }

                        MoveEntryWithRetry(stageEntryPath, liveTarget, isDir, moveRetryMs);
                        promotedFromStage.Add(new MovedEntry
                        {
                            SourcePath = stageEntryPath,
                            DestinationPath = liveTarget,
                            IsDirectory = isDir
                        });
                    }

                    if (!File.Exists(plan.ExecPath))
                    {
                        throw new FileNotFoundException("Expected updated executable is missing after promotion: " + plan.ExecPath);
                    }
                }
                catch (Exception ex)
                {
                    WriteLog(plan.LogPath, "Phase 2 promotion failed, rolling back staged and live files: " + ex.Message);
                    RollbackMoves(promotedFromStage, Math.Max(moveRetryMs, 3000), plan.LogPath, "phase2-stage");
                    RollbackMoves(movedToOld, Math.Max(moveRetryMs, 3000), plan.LogPath, "phase2-live");
                    DeleteDirectoryBestEffort(plan.BackupDir, 2000);
                    WriteErrorReport(plan, ex.Message, true);
                    throw;
                }

                // Phase 3: Commit marker cleanup, log success BEFORE relaunch, relaunch immediately, then clean backups.
                ClearFileSafe(Path.Combine(plan.StageDir, StageReadyMarkerFileName));
                ClearFileSafe(plan.ErrorReportPath);
                ClearFileSafe(plan.MarkerPath);
                WriteLog(plan.LogPath, "Update installed successfully.");

                RelaunchApp(plan, "updated app");

                DeleteDirectoryBestEffort(plan.StageDir, 5000);
                DeleteDirectoryBestEffort(plan.BackupDir, 10000);
                if (plan.CleanupPaths != null)
                {
                    foreach (string cleanupPath in plan.CleanupPaths)
                    {
                        DeletePathBestEffort(cleanupPath, 3000);
                    }
                }

                return 0;
            }
            catch (Exception ex)
            {
                WriteLog(plan.LogPath, "Update install failed: " + ex.Message);
                ClearFileSafe(plan.MarkerPath);
                if (parentExited)
                {
                    RelaunchApp(plan, "existing app after rollback");
                }
                return 1;
            }
            finally
            {
                if (lockAcquired)
                {
                    ClearFileSafe(plan.LockPath);
                }
            }
        }
    }
}
