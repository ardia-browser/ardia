param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "relaunch-facts.ps1")

Add-Type -Namespace RelaunchCheck -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr window, System.Text.StringBuilder name, int size);
[DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
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
'@

$entry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{47A92F18-32B0-4548-A1EF-72C217FE1836}_is1"
$folder = Join-Path $env:LOCALAPPDATA "Programs\Ardia"
$exe = Join-Path $folder "Ardia.exe"
$data = Join-Path $env:LOCALAPPDATA "Ardia"
$log = Join-Path $data "Logs\launch.log"
$reports = Join-Path $data "User Data\Crashpad\reports"
$started = Get-Date
$summary = New-Object System.Collections.Generic.List[string]
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function Note([string]$line) {
  Write-Host "relaunch-check: $line"
  $script:summary.Add($line)
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

function Wait-Window([string]$what, [int]$seconds = 120) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    foreach ($browser in @(Browsers)) {
      $windows = [RelaunchCheck.Native]::AppWindows([uint32]$browser.ProcessId)
      if ($windows.Count -gt 0) { return [pscustomobject]@{ Pid = [int]$browser.ProcessId; Window = $windows[0] } }
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

function Start-Ardia { return Start-Process -FilePath $exe -PassThru }

if (-not (Test-Path -LiteralPath $Setup -PathType Leaf)) { throw "'$Setup' does not exist" }
if ((Test-Path -LiteralPath $entry) -or (Test-Path -LiteralPath $folder)) { throw "Ardia is already installed for this user: this check installs and removes it" }
if (@(Running).Count) { throw "Ardia is already running" }
Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction SilentlyContinue
$env:ARDIA_BACKGROUND = "1"

$install = Start-Process -FilePath (Resolve-Path -LiteralPath $Setup).Path -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "the installer exited with $($install.ExitCode)" }

try {
  Start-Ardia | Out-Null
  $shown = Wait-Window "first launch" 180
  Assert-OneBrowser "first launch"
  Note "first launch: a window in $([int]((Get-Date) - $started).TotalSeconds) s"

  foreach ($round in 1, 2) {
    Close-Window $shown
    Start-Ardia | Out-Null
    $previous = $shown.Pid
    $shown = Wait-Window "relaunch $round right after closing"
    if ($shown.Pid -ne $previous) {
      Wait-Exit $previous "relaunch $round" | Out-Null
      Assert-ShutDownFinished $previous "relaunch $round right after closing"
    }
    Start-Sleep -Seconds 2
    Assert-OneBrowser "relaunch $round right after closing"
    Note "relaunch $round right after closing: a window in browser $($shown.Pid)"
  }

  Close-Window $shown
  $exitMs = Wait-Exit $shown.Pid "closing"
  if ($exitMs -gt 15000) { throw "closing: the browser took $exitMs ms to exit after its window closed; it must end once Chromium's shutdown returns (#1706 lingered about 30 s)" }
  Note "closing: the browser exited $exitMs ms after its window closed"
  Start-Ardia | Out-Null
  $shown = Wait-Window "relaunch after a full exit"
  Assert-OneBrowser "relaunch after a full exit"
  Note "relaunch after a full exit: a window in browser $($shown.Pid)"

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

  Close-Window $shown
  Wait-Exit $shown.Pid "before the stuck profile" | Out-Null
  Set-Content -LiteralPath (Join-Path $data "launch-starts.txt") -Value "2" -Encoding ascii
  if (-not (Test-Path -LiteralPath (Join-Path $data "session.json"))) { Set-Content -LiteralPath (Join-Path $data "session.json") -Value "{}" -Encoding ascii }
  Start-Ardia | Out-Null
  $shown = Wait-Window "stuck profile"
  $guard = Read-LaunchGuard @(Launch-Log)
  if (-not $guard.SetAside -or $guard.UnfinishedBefore -ne 2) { throw "stuck profile: two unfinished starts didn't set the restore state aside (log: unfinished $($guard.UnfinishedBefore), set aside $($guard.SetAside))" }
  $setAside = Get-ChildItem -LiteralPath (Join-Path $data "Recovery") -Recurse -File -Filter "session.json" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $setAside) { throw "stuck profile: no session.json under $data\Recovery" }
  Note "stuck profile: after two unfinished starts the session went to $($setAside.Directory.Name) and Ardia opened a window"
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

  Start-Ardia | Out-Null
  $shown = Wait-Window "launch after a start failure"
  Close-Window $shown
  Wait-Exit $shown.Pid "launch after a start failure" | Out-Null
  Note "launch after a start failure: a window again"

  $events = @(Get-WinEvent -FilterHashtable @{ LogName = "Application"; StartTime = $started } -ErrorAction SilentlyContinue |
      Where-Object { $_.ProviderName -eq "Application Error" -and $_.Message -match "Ardia\.exe" })
  if ($events.Count) { throw "Windows logged $($events.Count) Ardia crash(es): $(($events[0].Message -split "`n")[0..3] -join ' | ')" }
  $dumps = @(Get-ChildItem -LiteralPath $reports -Filter *.dmp -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $started })
  if ($dumps.Count) { throw "Crashpad wrote $($dumps.Count) crash dump(s): $($dumps.Name -join ', ')" }
  $fatal = (Read-LaunchGuard @(Launch-Log)).Fatal
  if ($fatal.Count) { throw "the launch log has a fatal line: $($fatal[0])" }
  Note "no crash events, crash dumps or fatal log lines"
} finally {
  Keep-Log "final"
  Get-Process -Name Ardia -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $uninstaller = Join-Path $folder "unins000.exe"
  if (Test-Path -LiteralPath $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait | Out-Null }
  Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction SilentlyContinue
  $summary | Set-Content -LiteralPath (Join-Path $Out "relaunch.md")
}
Write-Host "relaunch-check: every launch opened one browser with a window, and nothing crashed"
