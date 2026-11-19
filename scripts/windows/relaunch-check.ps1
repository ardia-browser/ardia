param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "relaunch-facts.ps1")
. (Join-Path $PSScriptRoot "relaunch-during-quit.ps1")

Add-Type -Namespace RelaunchCheck -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr window, System.Text.StringBuilder name, int size);
[DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern uint RegisterWindowMessageW(string name);
[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr process);
[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr process);
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
public static System.Collections.Generic.List<IntPtr> DialogWindows(uint process) {
  var found = new System.Collections.Generic.List<IntPtr>();
  EnumWindows((window, state) => {
    uint owner; GetWindowThreadProcessId(window, out owner);
    if (owner != process || !IsWindowVisible(window)) return true;
    var name = new System.Text.StringBuilder(128); GetClassNameW(window, name, 128);
    if (name.ToString() == "#32770") found.Add(window);
    return true;
  }, IntPtr.Zero);
  return found;
}
public static string ProfileKey(string folder) {
  ulong hash = 14695981039346656037UL;
  foreach (char c in folder.TrimEnd('\\', '/')) {
    char lower = char.ToLowerInvariant(c);
    hash ^= (ulong)(lower == '/' ? '\\' : lower);
    hash *= 1099511628211UL;
  }
  return hash.ToString("x16");
}
'@

$entry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{47A92F18-32B0-4548-A1EF-72C217FE1836}_is1"
$folder = Join-Path $env:LOCALAPPDATA "Programs\Ardia"
$exe = Join-Path $folder "Ardia.exe"
$data = Join-Path $env:LOCALAPPDATA "Ardia"
$log = Join-Path $data "Logs\launch.log"
$reports = Join-Path $data "User Data\Crashpad\reports"
$started = Get-Date
$summary = New-Object System.Collections.Generic.List[string]
$script:SeenProcesses = New-Object System.Collections.Generic.List[object]
$script:QuitDumps = @()
$werDumps = Join-Path $Out "dumps"
$werParent = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps"
$werKey = Join-Path $werParent "Ardia.exe"
$werValueNames = @("DumpFolder", "DumpType", "DumpCount")
New-Item -ItemType Directory -Force -Path $Out | Out-Null
New-Item -ItemType Directory -Force -Path $werDumps | Out-Null

function Note([string]$line) {
  Write-Host "relaunch-check: $line"
  $script:summary.Add($line)
}

function Remember-Pid([int]$processId, $process = $null) {
  if (-not $processId) { return }
  $startedAt = $null
  try {
    if ($process -is [System.Diagnostics.Process]) { $startedAt = $process.StartTime }
    elseif ($process -and $process.CreationDate) { $startedAt = $process.CreationDate }
    else { $startedAt = (Get-Process -Id $processId -ErrorAction Stop).StartTime }
  } catch { $startedAt = $null }
  $fileTime = if ($startedAt) { ([DateTime]$startedAt).ToFileTimeUtc() } else { $null }
  $script:SeenProcesses.Add([pscustomobject]@{ Pid = $processId; FileTime = $fileTime })
}

function Test-StartedByThisCheck([int]$processId, $fileTime) {
  foreach ($seen in $script:SeenProcesses) {
    if ($seen.Pid -ne $processId) { continue }
    if ($null -eq $seen.FileTime -or $null -eq $fileTime) { return $true }
    if ([Math]::Abs([long]$seen.FileTime - [long]$fileTime) -le 10000000) { return $true }
  }
  return $false
}

function Save-WerKey {
  $parentExisted = Test-Path -LiteralPath $werParent
  if (-not (Test-Path -LiteralPath $werKey)) { return [pscustomobject]@{ Existed = $false; ParentExisted = $parentExisted; Values = @{} } }
  $key = Get-Item -LiteralPath $werKey -ErrorAction Stop
  $names = @($key.GetValueNames())
  $values = @{}
  foreach ($name in $werValueNames) {
    if ($names -contains $name) {
      $values[$name] = [pscustomobject]@{ Value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); Kind = $key.GetValueKind($name) }
    }
  }
  return [pscustomobject]@{ Existed = $true; ParentExisted = $true; Values = $values }
}

function Restore-WerKey($before) {
  if (-not $before) { return }
  try {
    if (-not $before.Existed) {
      $created = if ($before.ParentExisted) { $werKey } else { $werParent }
      if (Test-Path -LiteralPath $created) { Remove-Item -LiteralPath $created -Recurse -Force -ErrorAction Stop }
      Note "crash dump settings: removed the key this check created"
      return
    }
    foreach ($name in $werValueNames) {
      $saved = $before.Values[$name]
      if ($saved) { New-ItemProperty -LiteralPath $werKey -Name $name -PropertyType $saved.Kind -Value $saved.Value -Force -ErrorAction Stop | Out-Null }
      else { Remove-ItemProperty -LiteralPath $werKey -Name $name -Force -ErrorAction SilentlyContinue }
    }
    Note "crash dump settings: put back the $($before.Values.Count) value(s) that were there before"
  } catch {
    Write-Host "relaunch-check: the crash dump settings could not be put back: $($_.Exception.Message)"
  }
}

function Running { return @(Get-CimInstance Win32_Process -Filter "Name='Ardia.exe'") }

function Browsers { return @(Get-BrowserProcesses @(Running)) }

function Keep-Log([string]$name) {
  foreach ($file in @($log, (Join-Path $data "Logs\launch.previous.log"))) {
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $Out "$name-$(Split-Path -Leaf $file)") -Force }
  }
}

function Launch-Log { if (Test-Path -LiteralPath $log) { return @(Get-Content -LiteralPath $log) } return @() }

function Assert-ShutDownFinished([int]$processId, [string]$what) {
  $previousLog = Join-Path $data "Logs\launch.previous.log"
  $ended = @(Get-Content -LiteralPath $previousLog -ErrorAction SilentlyContinue | Where-Object { $_ -match 'process ending' }).Count
  if (-not $ended) {
    Keep-Log $what
    throw "$what`: the previous Ardia ($processId) ended without finishing its shutdown (no 'process ending' in its log), so what it hadn't saved was lost"
  }
}

function Quit-Writes([string]$file) {
  $closed = $null
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($line in @(Get-Content -LiteralPath $file -ErrorAction SilentlyContinue)) {
    if ($line -match 'process started inside the engine') { $closed = $null; $parts.Clear() }
    elseif ($line -match '^window (\d+) closed ') { $closed = [int]$Matches[1] }
    elseif ($line -match '^launch (\d+) quitting' -and $null -ne $closed) { $parts.Add("quit began $([int]$Matches[1] - $closed) ms after the last window closed") }
    elseif ($line -match '^quit \d+ ((the app answered (yes|no)|cancelled by a relaunch) after \d+ ms|no answer in \d+ ms)') { $parts.Add("willQuit: $($Matches[1])") }
    elseif ($line -match '\[quit\] last saves: (.+)$') { $parts.Add("the UI's last saves: $($Matches[1])") }
    elseif ($line -match 'telemetry drained in (\d+) ms') { $parts.Add("telemetry drained in $($Matches[1]) ms") }
    elseif ($line -match 'document (.+) of (\d+) bytes written at quit in (\d+) ms') { $parts.Add("$($Matches[1]) of $($Matches[2]) bytes in $($Matches[3]) ms") }
    elseif ($line -match 'telemetry and documents written in (\d+) ms(.*)$') { $parts.Add("all writes in $($Matches[1]) ms$($Matches[2])") }
  }
  if (-not $parts.Count) { return "nothing logged" }
  return $parts -join ', '
}

function Wait-Window([string]$what, [int]$seconds = 120) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    foreach ($browser in @(Browsers)) {
      $windows = [RelaunchCheck.Native]::AppWindows([uint32]$browser.ProcessId)
      if ($windows.Count -gt 0) {
        Remember-Pid ([int]$browser.ProcessId) $browser
        return [pscustomobject]@{ Pid = [int]$browser.ProcessId; Window = $windows[0] }
      }
    }
    Start-Sleep -Milliseconds 250
  }
  Keep-Log $what
  throw "$what`: no Ardia window within $seconds s (browser processes: $(((Browsers) | ForEach-Object ProcessId) -join ', '))"
}

function Close-Window($shown) {
  [RelaunchCheck.Native]::PostMessageW($shown.Window, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero) | Out-Null
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline -and [RelaunchCheck.Native]::IsWindowVisible($shown.Window)) { Start-Sleep -Milliseconds 50 }
}

function Wait-Exit([int]$processId, [string]$what, [int]$seconds = 60) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.Elapsed.TotalSeconds -lt $seconds) {
    if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { return [int]$watch.Elapsed.TotalMilliseconds }
    Start-Sleep -Milliseconds 100
  }
  throw "$what`: Ardia ($processId) was still running $seconds s after its window closed"
}

function Count-LogLines([string]$pattern) { return @(@(Launch-Log) | Where-Object { $_ -match $pattern }).Count }

function Wait-LogLine([string]$pattern, [string]$what, [int]$after, [int]$seconds = 30) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if ((Count-LogLines $pattern) -gt $after) { return }
    Start-Sleep -Milliseconds 25
  }
  Keep-Log $what
  throw "$what`: the launch log never said '$pattern'"
}

function Assert-OneBrowser([string]$what) {
  $deadline = (Get-Date).AddSeconds(10)
  $browsers = @(Browsers)
  while ($browsers.Count -gt 1 -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $browsers = @(Browsers)
  }
  if ($browsers.Count -ne 1) {
    $described = $browsers | ForEach-Object { "$($_.ProcessId) from $($_.ParentProcessId) at $($_.CreationDate.ToString('HH:mm:ss.fff')): $($_.CommandLine)" }
    throw "$what`: $($browsers.Count) browser processes on one profile: $($described -join ' | ')"
  }
}

function Start-Ardia {
  $launched = Start-Process -FilePath $exe -PassThru
  Remember-Pid $launched.Id $launched
  return $launched
}

function Read-CrashDumps {
  $found = @(Get-ChildItem -LiteralPath $werDumps -Filter "*.dmp" -ErrorAction SilentlyContinue)
  Note "full crash dumps written: $($found.Count)"
  if (-not $found.Count) { return }
  $machine = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $debugger = @("${env:ProgramFiles(x86)}\Windows Kits\10\Debuggers\$machine\cdb.exe", "$env:ProgramFiles\Windows Kits\10\Debuggers\$machine\cdb.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $debugger) { Write-Host "relaunch-check: no cdb.exe on this runner; the dumps are in the artifact."; return }
  $symbols = Join-Path $Out "symbols"
  foreach ($dump in ($found | Select-Object -First 2)) {
    Write-Host "relaunch-check: $($dump.Name), as cdb reads it:"
    & $debugger -z $dump.FullName -y "srv*$symbols*https://msdl.microsoft.com/download/symbols" -c ".ecxr; kn 40; lm m Ardia*; lm m Microsoft*; q" 2>&1 | Select-Object -Last 80 | ForEach-Object { Write-Host "  $_" }
  }
}

function Get-CrashEventFacts($record) {
  $text = "$($record.Message)"
  $processId = if ($text -match 'Faulting process id: (0x[0-9a-fA-F]+)') { [Convert]::ToInt32($Matches[1].Substring(2), 16) } else { 0 }
  $fileTime = if ($text -match 'Faulting application start time: (0x[0-9a-fA-F]+)') { try { [Convert]::ToInt64($Matches[1].Substring(2), 16) } catch { $null } } else { $null }
  $startTime = if ($null -ne $fileTime) { try { [DateTime]::FromFileTime($fileTime).ToString('HH:mm:ss.fff') } catch { "$fileTime" } } else { "unknown" }
  $path = if ($text -match 'Faulting application path: ([^\r\n]+)') { $Matches[1].Trim() } else { "unknown" }
  $module = if ($text -match 'Faulting module name: ([^,\r\n]+)') { $Matches[1].Trim() } else { "unknown" }
  $offset = if ($text -match 'Fault offset: (0x[0-9a-fA-F]+)') { $Matches[1] } else { "unknown" }
  $ours = Test-StartedByThisCheck $processId $fileTime
  $whose = if ($ours) { "started by this check" } else { "not ours" }
  return [pscustomobject]@{ Pid = $processId; Ours = $ours; Line = "process $processId ($whose), started $startTime, $path, $module+$offset" }
}

if (-not (Test-Path -LiteralPath $Setup -PathType Leaf)) { throw "'$Setup' does not exist" }
if ((Test-Path -LiteralPath $entry) -or (Test-Path -LiteralPath $folder)) { throw "Ardia is already installed for this user: this check installs and removes it" }
if (@(Running).Count) { throw "Ardia is already running" }
Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction SilentlyContinue
$env:ARDIA_BACKGROUND = "1"

$install = Start-Process -FilePath (Resolve-Path -LiteralPath $Setup).Path -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "the installer exited with $($install.ExitCode)" }

$werOn = $false
$werBefore = $null
try {
  $werBefore = Save-WerKey
  if (-not $werBefore.Existed) { New-Item -Path $werKey -Force -ErrorAction Stop | Out-Null }
  New-ItemProperty -Path $werKey -Name DumpFolder -PropertyType ExpandString -Value $werDumps -Force -ErrorAction Stop | Out-Null
  New-ItemProperty -Path $werKey -Name DumpType -PropertyType DWord -Value 2 -Force -ErrorAction Stop | Out-Null
  New-ItemProperty -Path $werKey -Name DumpCount -PropertyType DWord -Value 10 -Force -ErrorAction Stop | Out-Null
  $werOn = $true
} catch {
  Write-Host "relaunch-check: full crash dumps could not be turned on: $($_.Exception.Message)"
}
Note "full crash dumps on: $werOn"

try {
  Start-Ardia | Out-Null
  $shown = Wait-Window "first launch" 180
  Assert-OneBrowser "first launch"
  Note "first launch: a window in $([int]((Get-Date) - $started).TotalSeconds) s"
  Keep-Log "first-launch"

  foreach ($round in 1, 2) {
    Close-Window $shown
    Start-Ardia | Out-Null
    $previous = $shown.Pid
    $shown = Wait-Window "relaunch $round right after closing"
    if ($shown.Pid -ne $previous) {
      Wait-Exit $previous "relaunch $round" | Out-Null
      Assert-ShutDownFinished $previous "relaunch $round right after closing"
      Note "relaunch $round right after closing: the previous Ardia's quit: $(Quit-Writes (Join-Path $data "Logs\launch.previous.log"))"
    }
    Start-Sleep -Seconds 2
    Assert-OneBrowser "relaunch $round right after closing"
    Note "relaunch $round right after closing: a window in browser $($shown.Pid)"
    Keep-Log "relaunch-$round"
  }

  Close-Window $shown
  $exitMs = Wait-Exit $shown.Pid "closing"
  if ($exitMs -gt 15000) { throw "closing: the browser took $exitMs ms to exit after its window closed; it must end once Chromium's shutdown returns (#1706 lingered about 30 s)" }
  Note "closing: the browser exited $exitMs ms after its window closed"
  Note "closing: $(Quit-Writes $log)"
  Keep-Log "closing"
  Start-Ardia | Out-Null
  $shown = Wait-Window "relaunch after a full exit"
  Assert-OneBrowser "relaunch after a full exit"
  Note "relaunch after a full exit: a window in browser $($shown.Pid)"
  Keep-Log "relaunch-after-exit"

  $held = $null
  foreach ($attempt in 1, 2, 3) {
    $lingering = $shown.Pid
    $endings = Count-LogLines 'process ending'
    Close-Window $shown
    Wait-LogLine 'process ending' "lingering exit" $endings
    $candidate = Get-Process -Id $lingering -ErrorAction SilentlyContinue
    if ($candidate -and [RelaunchCheck.Native]::NtSuspendProcess($candidate.Handle) -eq 0 -and -not $candidate.HasExited) {
      $held = $candidate
      break
    }
    Note "lingering exit: attempt $attempt ended before it could be held"
    if ($candidate -and -not $candidate.HasExited) { [RelaunchCheck.Native]::NtResumeProcess($candidate.Handle) | Out-Null }
    Wait-Exit $lingering "lingering exit attempt $attempt" | Out-Null
    Start-Ardia | Out-Null
    $shown = Wait-Window "lingering exit attempt $attempt"
  }
  if (-not $held) { throw "lingering exit: the browser ended before it could be held, three times" }
  try {
    Start-Ardia | Out-Null
    Start-Sleep -Seconds 26
    $waiting = @((Browsers) | Where-Object { [int]$_.ProcessId -ne $lingering })
    if ($waiting.Count -ne 1) { throw "lingering exit: expected one new launch waiting, found $($waiting.Count)" }
    $children = @(Get-BrowserChildren @(Running) ([int]$waiting[0].ProcessId))
    if ($children.Count -gt 0) { throw "lingering exit: the new launch started $($children.Count) browser processes while the previous Ardia was still exiting: two browsers on one profile" }
    if ([RelaunchCheck.Native]::AppWindows([uint32]$waiting[0].ProcessId).Count -gt 0) { throw "lingering exit: the new launch opened a window while the previous Ardia was still exiting" }
  } finally {
    if ([RelaunchCheck.Native]::NtResumeProcess($held.Handle) -ne 0) { throw "lingering exit: Ardia ($lingering) could not be let go" }
  }
  Wait-Exit $lingering "lingering exit" | Out-Null
  $shown = Wait-Window "relaunch after a lingering exit"
  Assert-OneBrowser "relaunch after a lingering exit"
  $guard = Read-LaunchGuard @(Launch-Log)
  if ($null -eq $guard.WaitedMs -or $guard.WaitedMs -lt 1000) { throw "lingering exit: the launch log doesn't show the new launch waiting for the previous one (waited '$($guard.WaitedMs)' ms)" }
  Note "relaunch during a lingering exit: waited $($guard.WaitedMs) ms for the previous Ardia, then one browser and a window"
  Keep-Log "lingering-exit"

  Close-Window $shown
  Wait-Exit $shown.Pid "before the stuck profile" | Out-Null
  Note "closing before the stuck profile: $(Quit-Writes $log)"
  Set-Content -LiteralPath (Join-Path $data "launch-starts.txt") -Value "2" -Encoding ascii
  if (-not (Test-Path -LiteralPath (Join-Path $data "session.json"))) { Set-Content -LiteralPath (Join-Path $data "session.json") -Value "{}" -Encoding ascii }
  Start-Ardia | Out-Null
  $shown = Wait-Window "stuck profile"
  $guard = Read-LaunchGuard @(Launch-Log)
  if (-not $guard.SetAside -or $guard.UnfinishedBefore -ne 2) { throw "stuck profile: two unfinished starts didn't set the restore state aside (log: unfinished $($guard.UnfinishedBefore), set aside $($guard.SetAside))" }
  $setAside = Get-ChildItem -LiteralPath (Join-Path $data "Recovery") -Recurse -File -Filter "session.json" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $setAside) { throw "stuck profile: no session.json under $data\Recovery" }
  Note "stuck profile: after two unfinished starts the session went to $($setAside.Directory.Name) and Ardia opened a window"
  Keep-Log "stuck-profile"
  Close-Window $shown
  Wait-Exit $shown.Pid "after the stuck profile" | Out-Null
  $settled = (Get-Content -LiteralPath (Join-Path $data "launch-starts.txt") -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ("$settled".Trim() -ne "0") { throw "stuck profile: a clean quit left $settled unfinished starts" }

  $library = Join-Path $folder "Microsoft.ReactNative.dll"
  Rename-Item -LiteralPath $library -NewName "Microsoft.ReactNative.dll.hidden"
  try {
    $failing = Start-Ardia
    if (-not $failing.WaitForExit(90000)) { throw "start failure: Ardia was still running 90 s after a start that could not succeed" }
    $code = $failing.ExitCode
    $deadline = (Get-Date).AddSeconds(90)
    while (@(Browsers).Count -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if (@(Browsers).Count) { throw "start failure: an Ardia was still running 90 s after a start that could not succeed" }
  } finally {
    Rename-Item -LiteralPath "$library.hidden" -NewName "Microsoft.ReactNative.dll"
  }
  $guard = Read-LaunchGuard @(Launch-Log)
  if (-not $guard.StartFailure) { throw "start failure: the launch log doesn't give the reason" }
  if ($guard.Fatal.Count) { throw "start failure: the engine crashed instead of quitting: $($guard.Fatal[0])" }
  if ($code -ne 0) { throw "start failure: Ardia exited with $code, not 0" }
  Note "start failure: a clean exit (0) with the reason in the log: $($guard.StartFailure)"
  Keep-Log "start-failure"

  Start-Ardia | Out-Null
  $shown = Wait-Window "launch after a start failure"
  Close-Window $shown
  Wait-Exit $shown.Pid "launch after a start failure" | Out-Null
  Note "launch after a start failure: a window again"
  Keep-Log "after-start-failure"

  Test-LaunchesDuringQuit

  $events = @(Get-WinEvent -FilterHashtable @{ LogName = "Application"; StartTime = $started } -ErrorAction SilentlyContinue |
      Where-Object { $_.ProviderName -eq "Application Error" -and $_.Message -match "Ardia\.exe" })
  $facts = @($events | ForEach-Object { Get-CrashEventFacts $_ })
  foreach ($fact in $facts) { Write-Host "relaunch-check: Application Error: $($fact.Line)" }
  $ourCrashes = @($facts | Where-Object { $_.Ours })
  if ($facts.Count -gt $ourCrashes.Count) { Note "Ardia crash events from processes this check did not start: $($facts.Count - $ourCrashes.Count)" }
  if ($ourCrashes.Count) { throw "Windows logged $($ourCrashes.Count) crash(es) of an Ardia this check started: $(($ourCrashes | ForEach-Object { $_.Line }) -join ' | ')" }
  $dumps = @(Get-ChildItem -LiteralPath $reports -Filter *.dmp -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $started })
  if ($dumps.Count) { throw "Crashpad wrote $($dumps.Count) crash dump(s): $($dumps.Name -join ', ')" }
  if ($script:QuitDumps.Count) { throw "Crashpad wrote $($script:QuitDumps.Count) crash dump(s) in the quit cases' profiles: $($script:QuitDumps -join ', ')" }
  $fatal = (Read-LaunchGuard @(Launch-Log)).Fatal
  if ($fatal.Count) { throw "the launch log has a fatal line: $($fatal[0])" }
  Note "no crash events, crash dumps or fatal log lines"
  if ($script:QuitFailures.Count) { throw "launches during a quit: $($script:QuitFailures.Count) case(s) failed: $($script:QuitFailures -join ' | ')" }
} finally {
  Keep-Log "final"
  Restore-WerKey $werBefore
  Read-CrashDumps
  Get-Process -Name Ardia -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $uninstaller = Join-Path $folder "unins000.exe"
  if (Test-Path -LiteralPath $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait | Out-Null }
  Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction SilentlyContinue
  $summary | Set-Content -LiteralPath (Join-Path $Out "relaunch.md")
}
Write-Host "relaunch-check: every launch opened one browser with a window, and nothing crashed"
