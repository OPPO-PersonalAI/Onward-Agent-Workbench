# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
param([string]$AppBin = '', [string]$LogFile = '')
# Native stderr must remain log output on Windows PowerShell 5.1.
$ErrorActionPreference = 'Continue'
$RepoRoot = if ($env:ONWARD_REPO_ROOT) { $env:ONWARD_REPO_ROOT } elseif ($env:REPO_ROOT) { $env:REPO_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '../..') -ErrorAction Stop).Path }
if (-not $LogFile) { $LogFile = Join-Path $RepoRoot 'traces/test-logs/orchestrator-watchdog-autotest.log' }
New-Item -ItemType Directory -Force (Split-Path $LogFile) -ErrorAction Stop | Out-Null
$Utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($LogFile, '', $Utf8)
function Write-LogLine {
    [CmdletBinding()]
    param([Parameter(ValueFromPipeline = $true)]$Value)
    process {
        $Text = [string]$Value
        [IO.File]::AppendAllText($LogFile, $Text + [Environment]::NewLine, $Utf8)
        Write-Output $Text
    }
}
$Candidates = if ($env:PYTHON3) { @($env:PYTHON3) } else { @('py', 'python3', 'python') }
$Python = $null
foreach ($Candidate in $Candidates) {
    $Command = Get-Command -Name $Candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Command) { $Python = $Command.Source; break }
}
if (-not $Python) {
    'OWD: Python interpreter not found.' | Write-LogLine -ErrorAction Stop
    exit 127
}
$Failed = 0
"OWD orchestrator watchdog self-check (PY=$Python, REPO_ROOT=$RepoRoot)" | Write-LogLine -ErrorAction Stop
foreach ($Check in @('check-regression-entry.py', 'check-orchestrator-watchdog.py')) {
    # A failed native launch must not inherit a previous command's success code.
    $LASTEXITCODE = $null
    try {
        & $Python (Join-Path $RepoRoot "test/autotest/$Check") 2>&1 | Write-LogLine -ErrorAction Stop
        $CheckExit = if ($null -eq $LASTEXITCODE) { 127 } else { $LASTEXITCODE }
    } catch {
        $_.ToString() | Write-LogLine -ErrorAction Stop
        $CheckExit = 1
    }
    if ($Failed -eq 0 -and $CheckExit -ne 0) { $Failed = $CheckExit }
}
"OWD orchestrator watchdog self-check: $(if ($Failed -eq 0) { 'PASS' } else { "FAIL (rc=$Failed)" })" | Write-LogLine -ErrorAction Stop
exit $Failed
