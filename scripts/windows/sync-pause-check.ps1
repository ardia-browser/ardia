param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$PausedSeconds = 25,
  [switch]$SettleCheck
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "relaunch-facts.ps1")

Add-Type -Namespace SyncPauseCheck -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr window, System.Text.StringBuilder name, int size);
[DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
public delegate bool EnumWindowsProc(IntPtr window, IntPtr state);
public static System.Collections.Generic.List<IntPtr> AppWindows(uint process) {
  var found = new System.Collections.Generic.List<IntPtr>();
  EnumWindows((window, state) => {
    uint owner; GetWindowThreadProcessId(window, out owner);
    if (owner != process || !IsWindowVisible(window)) return true;
    var name = new System.Text.StringBuilder(128); GetClassNameW(window, name, 128);
    if (name.ToString() == "Microsoft.UI.Windowing.Window") found.Add(window);
    return true;
  }, IntPtr.Zero);
  return found;
}
'@

$entry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{47A92F18-32B0-4548-A1EF-72C217FE1836}_is1"
$folder = Join-Path $env:LOCALAPPDATA "Programs\Ardia"
$exe = Join-Path $folder "Ardia.exe"
$marker = Join-Path $folder "Ardia.test-build"
$Out = [IO.Path]::GetFullPath($Out)
$work = Join-Path (Split-Path -Parent $Out) "sync-pause-work"
$data = Join-Path $work "data"
$syncFolder = Join-Path $work "sync-folder"
$docPath = Join-Path $data "sync.json"
$log = Join-Path $data "Logs\launch.log"
$previousLog = Join-Path $data "Logs\launch.previous.log"
$reports = Join-Path $data "User Data\Crashpad\reports"
$started = Get-Date
$summary = New-Object System.Collections.Generic.List[string]
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function Note([string]$line) {
  Write-Host "sync-pause-check: $line"
  $script:summary.Add($line)
}

function Running { return @(Get-CimInstance Win32_Process -Filter "Name='Ardia.exe'") }

function Browsers { return @(Get-BrowserProcesses @(Running)) }

function Launch-Log { if (Test-Path -LiteralPath $log) { return @(Get-Content -LiteralPath $log) } return @() }

function Previous-Log { if (Test-Path -LiteralPath $previousLog) { return @(Get-Content -LiteralPath $previousLog) } return @() }

function Keep-Log([string]$name) {
  foreach ($file in @($log, (Join-Path $data "Logs\launch.previous.log"), (Join-Path $data "sync.json"), (Join-Path $data "launch-guard.json"))) {
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $Out "$name-$(Split-Path -Leaf $file)") -Force }
  }
}

function Now-Ms { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Start-Run([string]$what) {
  $mark = Get-LogMark @(Launch-Log) @(Previous-Log)
  $startedMs = Now-Ms
  $process = Start-Process -FilePath $exe -PassThru
  $null = $process.Handle
  $deadline = (Get-Date).AddSeconds(180)
  while ((Get-Date) -lt $deadline) {
    foreach ($browser in @(Browsers)) {
      $windows = [SyncPauseCheck.Native]::AppWindows([uint32]$browser.ProcessId)
      if ($windows.Count -gt 0) { return [pscustomobject]@{ What = $what; Pid = [int]$browser.ProcessId; Mark = $mark; StartedMs = $startedMs } }
    }
    Start-Sleep -Milliseconds 250
  }
  Keep-Log $what
  throw "$what`: no Ardia window within 180 s"
}

function Run-Lines($run) { return @(Get-RunLines $run.Mark @(Launch-Log) @(Previous-Log)) }

function Wait-Trace($run, [scriptblock]$ready, [string]$waitingFor, [int]$seconds = 120) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $trace = Read-SyncTrace @(Run-Lines $run)
    if (& $ready $trace) { return $trace }
    Start-Sleep -Milliseconds 250
  }
  Keep-Log $run.What
  $trace = Read-SyncTrace @(Run-Lines $run)
  throw "$($run.What): Sync never showed $waitingFor (recoveredStart $($trace.Recovered), statuses $($trace.Statuses -join ', '), turning on: $($trace.TurnedOn))"
}

function Stop-Run($run) {
  foreach ($round in 1..3) {
    if (-not (Get-Process -Id $run.Pid -ErrorAction SilentlyContinue)) { break }
    foreach ($window in @([SyncPauseCheck.Native]::AppWindows([uint32]$run.Pid))) { [SyncPauseCheck.Native]::PostMessageW($window, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero) | Out-Null }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $run.Pid -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 100 }
  }
  if (Get-Process -Id $run.Pid -ErrorAction SilentlyContinue) {
    Keep-Log $run.What
    throw "$($run.What): Ardia ($($run.Pid)) was still running 90 s after its windows closed"
  }
  $deadline = (Get-Date).AddSeconds(30)
  while (@(Browsers).Count -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  $run | Add-Member -NotePropertyName EndedMs -NotePropertyValue (Now-Ms) -Force
  Keep-Log $run.What
  $runLines = @(Run-Lines $run)
  if (-not @($runLines | Where-Object { $_ -match 'process ending' }).Count) { throw "$($run.What): the start's log has no 'process ending', so its quit didn't finish" }
  $fatal = (Read-LaunchGuard $runLines).Fatal
  if ($fatal.Count) { throw "$($run.What): the start's log has a fatal line: $($fatal[0])" }
}

function Local-Telemetry {
  $local = Join-Path $data "Telemetry\local"
  if (-not (Test-Path -LiteralPath $local)) { return @() }
  return @(Get-ChildItem -LiteralPath $local -File -Filter *.jsonl | ForEach-Object { Get-Content -LiteralPath $_.FullName })
}

function Wait-Doc($run, [scriptblock]$ready, [string]$waitingFor, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $doc = Read-SyncDocWhileRunning $docPath
    if (& $ready $doc) { return Get-Date }
    Start-Sleep -Milliseconds 250
  }
  Keep-Log $run.What
  throw "$($run.What): sync.json never showed $waitingFor within $seconds s (unsettledStarts $((Read-SyncDocWhileRunning $docPath).UnsettledStarts))"
}

function Wait-LoadBegan($run) {
  $trace = Wait-Trace $run { param($t) $null -ne $t.Unlocked } "the unlock that comes before the load" 60
  $seen = Get-Date
  if (-not $trace.Unlocked) { throw "$($run.What): the sync key didn't unlock, so the start stays counted and can't be checked for a reset" }
  return $seen
}

function Wait-ResetWhileAlive($run, [datetime]$loadBegan) {
  $deadline = $loadBegan.AddSeconds(200)
  $lastOneAt = $null
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $run.Pid -ErrorAction SilentlyContinue)) { Keep-Log $run.What; throw "$($run.What): Ardia ended before unsettledStarts went back to 0" }
    $count = (Read-SyncDocWhileRunning $docPath).UnsettledStarts
    $at = Get-Date
    $alive = [bool](Get-Process -Id $run.Pid -ErrorAction SilentlyContinue)
    if ($count -eq 1) { $lastOneAt = $at }
    elseif ($count -eq 0) {
      if (-not $alive) { Keep-Log $run.What; throw "$($run.What): unsettledStarts read 0 only as Ardia ended, so the quit may have written it" }
      return [pscustomobject]@{ ZeroAt = $at; LastOneAt = $lastOneAt }
    }
    Start-Sleep -Milliseconds 250
  }
  Keep-Log $run.What
  throw "$($run.What): unsettledStarts didn't go back to 0 within 200 s of the load while Ardia ran (last 1 at $(if ($lastOneAt) { [int]($lastOneAt - $loadBegan).TotalSeconds } else { 'never' }) s)"
}

function Assert-StaysPaused($run, [bool]$recovered, $digests, [string]$seqs, [int]$unsettled) {
  $trace = Read-SyncTrace @(Run-Lines $run)
  if ($trace.Recovered -ne $recovered) { throw "$($run.What): recoveredStart was $($trace.Recovered), not $recovered" }
  $moved = @($trace.Statuses | Where-Object { $_ -ne "paused" })
  if ($moved.Count) { throw "$($run.What): Sync left the pause: statuses $($trace.Statuses -join ', ')" }
  if ($trace.UnlocksOrCycles.Count) { throw "$($run.What): Sync unlocked or ran a cycle: $($trace.UnlocksOrCycles[0])" }
  $doc = Read-SyncDoc $docPath
  if (-not $doc.PausedByGuard) { throw "$($run.What): sync.json has no pausedByGuard: true after the start" }
  if ($doc.UnsettledStarts -ne $unsettled) { throw "$($run.What): a paused start moved unsettledStarts from $unsettled to $($doc.UnsettledStarts)" }
  if ($doc.Seqs -ne $seqs) { throw "$($run.What): sync.json's seqs changed from $seqs to $($doc.Seqs)" }
  $changes = Compare-SyncDigests $digests (Get-SyncDigests $data $syncFolder)
  if ($changes.Count) { throw "$($run.What): Sync's files changed while paused: $($changes -join '; ')" }
  return $trace
}

if (-not (Test-Path -LiteralPath $Setup -PathType Leaf)) { throw "'$Setup' does not exist" }
if ((Test-Path -LiteralPath $entry) -or (Test-Path -LiteralPath $folder)) { throw "Ardia is already installed for this user: this check installs and removes it" }
if (@(Running).Count) { throw "Ardia is already running" }

$install = Start-Process -FilePath (Resolve-Path -LiteralPath $Setup).Path -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "the installer exited with $($install.ExitCode)" }

try {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $data, $syncFolder | Out-Null
  Set-Content -LiteralPath (Join-Path $data "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM
  Set-Content -LiteralPath $marker -Value "sync-pause-check" -Encoding ascii
  $env:ARDIA_BACKGROUND = "1"
  $env:ARDIA_DATA_DIR = $data
  $env:ARDIA_INSTANCE = "syncFolder=$syncFolder"

  $env:ARDIA_TEST = "syncTurnOn=1"
  $run = Start-Run "turning Sync on"
  $trace = Wait-Trace $run { param($t) $t.TurnedOn -and ($t.TurnedOn -ne "turned on" -or $t.Statuses -contains "updated") } "turned on and updated"
  if ($trace.TurnedOn -ne "turned on") { throw "turning Sync on: $($trace.TurnedOn)" }
  Stop-Run $run
  $env:ARDIA_TEST = ""
  $doc = Read-SyncDoc $docPath
  if (-not $doc.Enabled) { throw "turning Sync on: sync.json doesn't say enabled after the quit" }
  if ($doc.UnsettledStarts -ne 0) { throw "turning Sync on: unsettledStarts is $($doc.UnsettledStarts) after turning Sync on and a clean quit" }
  Note "turning Sync on: a test start turned Sync on in a scratch folder and finished a cycle (statuses $($trace.Statuses -join ', '))"

  $run = Start-Run "ordinary start"
  Wait-Doc $run { param($d) $d.UnsettledStarts -eq 1 } "unsettledStarts 1 (the start's count)" 60 | Out-Null
  $loadBegan = Wait-LoadBegan $run
  $trace = Wait-Trace $run { param($t) $null -ne $t.Recovered -and $t.Statuses -contains "updated" } "a finished cycle"
  $sinceLoad = [int]((Get-Date) - $loadBegan).TotalSeconds
  $beforeQuit = (Read-SyncDocWhileRunning $docPath).UnsettledStarts
  if ($sinceLoad -lt 100 -and $beforeQuit -ne 1) { throw "ordinary start: unsettledStarts went from 1 to $beforeQuit $sinceLoad s after the load began, before 2 minutes or a quit" }
  if ($trace.Recovered -ne $false) { throw "ordinary start: recoveredStart was $($trace.Recovered), not false" }
  if ($trace.Statuses -contains "paused") { throw "ordinary start: Sync paused on a start the guard didn't recover" }
  $guard = Read-LaunchGuard @(Run-Lines $run)
  if ($guard.SetAside) { throw "ordinary start: the guard set the restore state aside" }
  Stop-Run $run
  $afterQuit = (Read-SyncDoc $docPath).UnsettledStarts
  if ($afterQuit -ne 0) { throw "ordinary start: a clean quit left unsettledStarts $afterQuit" }
  Note "ordinary start: recoveredStart false, unsettledStarts 1 before the unlock and still $beforeQuit after the cycle ($sinceLoad s after the load began), Sync unlocked and finished a cycle (statuses $($trace.Statuses -join ', ')), unsettledStarts 0 after the clean quit"

  if ($SettleCheck) {
    $run = Start-Run "two minutes alive"
    Wait-Doc $run { param($d) $d.UnsettledStarts -eq 1 } "unsettledStarts 1 (the start's count)" 60 | Out-Null
    $loadBegan = Wait-LoadBegan $run
    $sampled = Wait-ResetWhileAlive $run $loadBegan
    $afterSeconds = [Math]::Round(($sampled.ZeroAt - $loadBegan).TotalSeconds, 1)
    if ($afterSeconds -lt 110) { throw "two minutes alive: unsettledStarts went back to 0 only $afterSeconds s after the load began, before 2 minutes" }
    $lastOne = if ($sampled.LastOneAt) { "$([Math]::Round(($sampled.LastOneAt - $loadBegan).TotalSeconds, 1)) s" } else { "never" }
    Stop-Run $run
    $afterQuit = (Read-SyncDoc $docPath).UnsettledStarts
    if ($afterQuit -ne 0) { throw "two minutes alive: unsettledStarts is $afterQuit after the quit" }
    Note "two minutes alive: unsettledStarts 1 at the start (last seen 1 at $lastOne after the load began), 0 at $afterSeconds s after the load began (the [sync] unlock finished line) with Ardia still running and its window open, and 0 after the quit"
  } else {
    Note "two minutes alive: not run (full runs only)"
  }

  $doc = Read-SyncDoc $docPath
  if ($doc.PausedByGuard) { throw "before the recovered start: sync.json already has pausedByGuard" }
  if ($doc.UnsettledStarts -ne 0) { throw "before the recovered start: unsettledStarts is $($doc.UnsettledStarts), not 0" }
  $seqs = $doc.Seqs
  $digests = Get-SyncDigests $data $syncFolder
  if (-not @($digests.Keys | Where-Object { $_ -like "data/sync-*" }).Count) { throw "before the recovered start: no sync-state.nns or sync-journal-*.nns in $data" }
  Note "before the recovered start: $($digests.Count) Sync files hashed ($(@($digests.Keys) -join ', ')), seqs $seqs"

  Set-Content -LiteralPath (Join-Path $data "launch-starts.txt") -Value "2" -Encoding ascii
  if (-not (Test-Path -LiteralPath (Join-Path $data "session.json"))) { Set-Content -LiteralPath (Join-Path $data "session.json") -Value "{}" -Encoding ascii }
  $run = Start-Run "recovered start"
  $guard = Read-LaunchGuard @(Run-Lines $run)
  if (-not $guard.SetAside -or $guard.UnfinishedBefore -ne 2) { throw "recovered start: two unfinished starts didn't set the restore state aside (unfinished $($guard.UnfinishedBefore), set aside $($guard.SetAside))" }
  Wait-Trace $run { param($t) $null -ne $t.Recovered } "the start's trace" | Out-Null
  Start-Sleep -Seconds $PausedSeconds
  $pausedRun = $run
  Stop-Run $run
  $trace = Assert-StaysPaused $run $true $digests $seqs 0
  $settled = "$(Get-Content -LiteralPath (Join-Path $data "launch-starts.txt") -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim()
  if ($settled -ne "0") { throw "recovered start: a clean quit left $settled unfinished starts" }
  $pauses = Measure-LocalCount @(Local-Telemetry) "usage_counts" "sync_paused_by_launch_guard" $pausedRun.StartedMs $pausedRun.EndedMs
  if ($pauses -ne 1) { throw "recovered start: the local telemetry copy counts sync_paused_by_launch_guard $pauses times, not once" }
  $countPauses = Measure-LocalCount @(Local-Telemetry) "usage_counts" "sync_paused_after_unsettled_starts" $pausedRun.StartedMs $pausedRun.EndedMs
  if ($countPauses -ne 0) { throw "recovered start: the guard's pause was also counted as sync_paused_after_unsettled_starts ($countPauses)" }
  Note "recovered start: recoveredStart true, status paused for $PausedSeconds s and through the quit, pausedByGuard in sync.json, unsettledStarts still 0, seqs and every Sync file unchanged, no unlock or cycle, sync_paused_by_launch_guard 1"

  $run = Start-Run "start after the pause"
  Wait-Trace $run { param($t) $null -ne $t.Recovered } "the start's trace" | Out-Null
  Start-Sleep -Seconds $PausedSeconds
  Stop-Run $run
  Assert-StaysPaused $run $false $digests $seqs 0 | Out-Null
  $again = Measure-LocalCount @(Local-Telemetry) "usage_counts" "sync_paused_by_launch_guard" $run.StartedMs $run.EndedMs
  if ($again -ne 0) { throw "start after the pause: an ordinary start counted sync_paused_by_launch_guard $again times" }
  Note "start after the pause: recoveredStart false and Sync still paused, unsettledStarts still 0, its files unchanged"

  $events = @(Get-WinEvent -FilterHashtable @{ LogName = "Application"; StartTime = $started } -ErrorAction SilentlyContinue |
      Where-Object { $_.ProviderName -eq "Application Error" -and $_.Message -match "Ardia\.exe" })
  if ($events.Count) { throw "Windows logged $($events.Count) Ardia crash(es): $(($events[0].Message -split "`n")[0..3] -join ' | ')" }
  $dumps = @(Get-ChildItem -LiteralPath $reports -Filter *.dmp -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $started })
  if ($dumps.Count) { throw "Crashpad wrote $($dumps.Count) crash dump(s): $($dumps.Name -join ', ')" }
  Note "no crash events, crash dumps or fatal log lines in any start"
} catch {
  Note "stopped: $($_.Exception.Message)"
  throw
} finally {
  Keep-Log "final"
  Get-Process -Name Ardia -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  $uninstaller = Join-Path $folder "unins000.exe"
  if (Test-Path -LiteralPath $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait | Out-Null }
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($variable in "ARDIA_BACKGROUND", "ARDIA_DATA_DIR", "ARDIA_INSTANCE", "ARDIA_TEST") { Remove-Item -LiteralPath "Env:$variable" -ErrorAction SilentlyContinue }
  $summary | Set-Content -LiteralPath (Join-Path $Out "sync-pause.md")
}
Write-Host "sync-pause-check: a recovered start paused Sync without touching its files, and an ordinary start synced"
