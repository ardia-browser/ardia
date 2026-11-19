Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$walkRoot = Join-Path ([IO.Path]::GetTempPath()) ("relaunch-walk-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $walkRoot | Out-Null
$env:LOCALAPPDATA = Join-Path $walkRoot "LocalAppData"
New-Item -ItemType Directory -Force -Path (Join-Path $env:LOCALAPPDATA "Programs\Ardia") | Out-Null
$Out = Join-Path $walkRoot "out"
$Setup = Join-Path $walkRoot "ArdiaSetup.exe"
New-Item -ItemType Directory -Force -Path $Out | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
namespace RelaunchCheck {
  public static class Native {
    public static List<IntPtr> AppWindows(uint process) { return new List<IntPtr> { new IntPtr(100000 + process) }; }
    public static List<IntPtr> DialogWindows(uint process) { return new List<IntPtr> { new IntPtr(200000 + process) }; }
    public static bool IsWindowVisible(IntPtr window) { return false; }
    public static bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam) { return true; }
    public static uint RegisterWindowMessageW(string name) { return 0xC000; }
    public static int NtSuspendProcess(IntPtr process) { return 0; }
    public static int NtResumeProcess(IntPtr process) { return 0; }
    public static string ProfileKey(string folder) { return "0123456789abcdef"; }
  }
}
public class WalkView : IDisposable {
  public void Write(long position, uint value) { }
  public void Write(long position, long value) { }
  public void Dispose() { }
}
public class WalkMap : IDisposable {
  public WalkView CreateViewAccessor(long offset, long size) { return new WalkView(); }
  public void Dispose() { }
}
public static class WalkSharedMemory {
  public static WalkMap CreateNew(string name, long capacity) { return new WalkMap(); }
}
public class WalkNamedEvent : IDisposable {
  public WalkNamedEvent(bool initialState, System.Threading.EventResetMode mode, string name) { }
  public void Dispose() { }
}
public class WalkNamedMutex : IDisposable {
  public WalkNamedMutex(bool initiallyOwned, string name, out bool createdNew) { createdNew = true; }
  public void ReleaseMutex() { }
  public void Dispose() { }
}
public static class QuitPages {
  public static int Port = 1;
  static int downloadsRead;
  public static int DownloadsStarted { get { return ++downloadsRead; } }
  static int openRead;
  public static int DownloadsOpen { get { return ++openRead % 2; } }
  public static string DownloadClosedAt { get { return "never"; } }
  public static void ReleaseDownloads() { }
  public static void Start() { }
  public static void Stop() { }
  public static void SetScript(string name, string script) { }
  public static int LoadsOf(string name) { return 1; }
}
'@

$checkAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot "relaunch-check.ps1"), [ref]$null, [ref]$null)
foreach ($statement in $checkAst.EndBlock.Statements) {
  if ($statement -is [System.Management.Automation.Language.AssignmentStatementAst] -and $statement.Left -is [System.Management.Automation.Language.VariableExpressionAst]) {
    $commands = @($statement.Right.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })
    if (@($commands | Where-Object { $_ -notin @("Join-Path", "New-Object", "Get-Date") }).Count) { continue }
    try { . ([scriptblock]::Create($statement.Extent.Text)) } catch { Set-Variable -Scope Script -Name $statement.Left.VariablePath.UserPath.Replace("script:", "") -Value (Join-Path $walkRoot "unset") }
  }
}
foreach ($function in $checkAst.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  . ([scriptblock]::Create($function.Extent.Text))
}
New-Item -ItemType Directory -Force -Path (Join-Path $data "Logs") | Out-Null
. (Join-Path $PSScriptRoot "relaunch-facts.ps1")
$duringSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot "relaunch-during-quit.ps1") -Raw
$windowsOnly = @{ '[IO.MemoryMappedFiles.MemoryMappedFile]::CreateNew(' = '[WalkSharedMemory]::CreateNew('; 'New-Object System.Threading.EventWaitHandle(' = 'New-Object WalkNamedEvent('; 'New-Object System.Threading.Mutex(' = 'New-Object WalkNamedMutex(' }
foreach ($name in $windowsOnly.Keys) {
  if (-not $duringSource.Contains($name)) { throw "relaunch walk: the during-quit script no longer calls $name; update the walk's stubs" }
  $duringSource = $duringSource.Replace($name, $windowsOnly[$name])
}
$duringPath = Join-Path $walkRoot "relaunch-during-quit.ps1"
Set-Content -LiteralPath $duringPath -Value $duringSource -NoNewline
. $duringPath

$script:WalkNow = [datetime]::Now
$script:WalkNextId = 4000
$script:WalkRunning = @()

function Get-Date { return $script:WalkNow }

function Start-Sleep([int]$Seconds = 0, [int]$Milliseconds = 0) { $script:WalkNow = $script:WalkNow.AddMilliseconds(1000 * $Seconds + $Milliseconds) }

function New-WalkProcess([int]$id) {
  $process = [pscustomobject]@{ Id = $id; Handle = [IntPtr]$id; HasExited = $true; ExitCode = 0; StartTime = $script:WalkNow }
  $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($milliseconds) return $true }
  return $process
}

function Start-Process {
  [CmdletBinding()]
  param([Parameter(Position = 0)]$FilePath, [Parameter(Position = 1)]$ArgumentList = @(), [switch]$PassThru, [switch]$Wait, $WindowStyle)
  $script:WalkNextId++
  if ("$FilePath" -eq "$exe") {
    $script:WalkRunning += @([pscustomobject]@{ ProcessId = $script:WalkNextId; ParentProcessId = 1; Name = "Ardia.exe"; CommandLine = "`"$exe`" $(@($ArgumentList) -join ' ')"; CreationDate = $script:WalkNow })
  }
  return New-WalkProcess $script:WalkNextId
}

function Get-Process {
  [CmdletBinding()]
  param([int]$Id)
  if ($PSBoundParameters.ContainsKey("ErrorAction")) {
    $script:WalkRunning = @($script:WalkRunning | Where-Object { $_.ProcessId -ne $Id })
    return $null
  }
  return New-WalkProcess $Id
}

function Stop-Process {
  [CmdletBinding()]
  param([int]$Id, [switch]$Force)
  $script:WalkRunning = @($script:WalkRunning | Where-Object { $_.ProcessId -ne $Id })
}

function Get-CimInstance {
  [CmdletBinding()]
  param([Parameter(Position = 0)]$ClassName, $Filter)
  return @($script:WalkRunning)
}

function Invoke-RestMethod {
  [CmdletBinding()]
  param($Uri, $TimeoutSec)
  return @([pscustomobject]@{ type = "page"; url = "http://127.0.0.1:1/quit-unload.html"; webSocketDebuggerUrl = "ws://127.0.0.1:1/devtools/page/walk" })
}

function Invoke-PageCommands([string]$socketUrl, [object[]]$commands) {
  return @($commands | ForEach-Object { [pscustomobject]@{ id = 1; result = [pscustomobject]@{ result = [pscustomobject]@{ value = $true } } } })
}

$script:WalkCaseFailures = 0
function Fail-Quit([string]$what, [string]$why) { $script:WalkCaseFailures++ }

$realQuitLog = ${function:Quit-Log}
$script:WalkLogLines = @(
  "launch 1000 quit 1000 began (user)",
  "quit 1000 began (user)",
  "quit 4000 began (user)",
  "quit 1 the app answered yes after 10 ms",
  "quit 2 no answer in 3000 ms",
  "quit 3 cancelled by a relaunch after 900 ms",
  "launch 1 process ending",
  "info 10 [quit] not asked on a hidden instance: 1 download in progress, warning off",
  "info 20 [quit] asked: 1 download in progress, warning off; answered quit"
)
function Quit-Log { return @(& $realQuitLog) + $script:WalkLogLines }

function Read-QuitDialog { return [pscustomobject]@{ kind = "confirm"; title = "Are you sure you want to quit Ardia?"; message = "You have 1 download in progress. If you quit now, this download will be cancelled." } }

function Get-WalkPlatformGap($record) {
  $exception = $record.Exception
  while ($exception) {
    if ($exception -is [PlatformNotSupportedException]) { return $exception.Message }
    $exception = $exception.InnerException
  }
  return $null
}

$runnerAst = [System.Management.Automation.Language.Parser]::ParseFile($duringPath, [ref]$null, [ref]$null)
$runner = $runnerAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Test-LaunchesDuringQuit" }, $true)
$cases = @([regex]::Matches($runner.Extent.Text, '(?m)^\s+"(Test-[A-Za-z]+)",?$') | ForEach-Object { $_.Groups[1].Value })
if ($cases.Count -lt 10) { throw "relaunch walk: found only $($cases.Count) cases in Test-LaunchesDuringQuit" }

$script:WalkReached = @{}
$caseLines = @{}
foreach ($case in $cases) {
  $definition = $runnerAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $case }, $true)
  if (-not $definition) { throw "relaunch walk: $case is in the runner's list but not defined" }
  $lines = @($definition.Body.FindAll({ param($node) $node -is [System.Management.Automation.Language.PipelineBaseAst] }, $true) | ForEach-Object { $_.Extent.StartLineNumber } | Sort-Object -Unique)
  $caseLines[$case] = $lines
  foreach ($line in $lines) { Set-PSBreakpoint -Script $duringPath -Line $line -Action { $script:WalkReached["$($_.Line)"] = $true } | Out-Null }
}

$script:QuitData = Join-Path $walkRoot "quit-data"
$env:ARDIA_DATA_DIR = $script:QuitData
$errors = @()
foreach ($case in $cases) {
  $script:WalkRunning = @()
  Remove-Item -LiteralPath $script:QuitData -Recurse -Force -ErrorAction SilentlyContinue
  New-QuitData
  $ended = "ran to its end"
  $failuresBefore = $script:WalkCaseFailures
  try {
    & $case 6>$null | Out-Null
  } catch {
    $gap = Get-WalkPlatformGap $_
    if ($gap) { $ended = "stopped at a Windows-only .NET call (line $($_.InvocationInfo.ScriptLineNumber)): $gap" }
    elseif ($_.FullyQualifiedErrorId -eq $_.Exception.Message) { $ended = "stopped at the case's own failure (line $($_.InvocationInfo.ScriptLineNumber))" }
    elseif ($script:WalkCaseFailures -gt $failuresBefore -and ($_.Exception -is [IndexOutOfRangeException] -or $_.FullyQualifiedErrorId -in @("PropertyNotFoundStrict", "InvokeMethodOnNull", "NullArray"))) { $ended = "stopped past its own recorded failure, where a real run would have ended (line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message))" }
    else {
      $where = ($_.ScriptStackTrace -split "`n" | Select-Object -First 2) -join " <- "
      $errors += "$case`: $($_.Exception.GetType().Name) [$($_.FullyQualifiedErrorId)]: $($_.Exception.Message) at $where"
      $ended = "FAILED"
    }
  }
  $reached = @($caseLines[$case] | Where-Object { $script:WalkReached.ContainsKey("$_") }).Count
  Write-Host "walk: $case reached $reached of $($caseLines[$case].Count) statement lines, $ended"
}
Get-PSBreakpoint | Remove-PSBreakpoint

$saved = @{}
foreach ($case in $cases) { $saved[$case] = (Get-Item "Function:$case").ScriptBlock }
try {
  foreach ($case in $cases) { Set-Item "Function:$case" -Value ([scriptblock]::Create("throw '$case`: walked'")) }
  $script:QuitData = $null
  Test-LaunchesDuringQuit 6>$null
  if ($script:QuitFailures.Count -ne $cases.Count) { $errors += "Test-LaunchesDuringQuit: recorded $($script:QuitFailures.Count) failed cases, not the $($cases.Count) that threw" }
  Write-Host "walk: Test-LaunchesDuringQuit ran every case on its own and recorded $($script:QuitFailures.Count) failures"
} catch {
  $errors += "Test-LaunchesDuringQuit: $($_.Exception.GetType().Name) [$($_.FullyQualifiedErrorId)]: $($_.Exception.Message) at $(($_.ScriptStackTrace -split "`n" | Select-Object -First 2) -join ' <- ')"
} finally {
  foreach ($case in $cases) { Set-Item "Function:$case" -Value $saved[$case] }
}

Remove-Item -LiteralPath $walkRoot -Recurse -Force -ErrorAction SilentlyContinue
if ($errors.Count) {
  foreach ($line in $errors) { Write-Host "walk error: $line" }
  throw "relaunch walk: $($errors.Count) binding, type or missing-name error(s) in the during-quit cases"
}
Write-Host "walk: $($cases.Count) cases bound every call they reached"
