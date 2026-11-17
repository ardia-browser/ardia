$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "relaunch-facts.ps1")

$failures = @()

function Check([string]$Name, $Expected, $Actual) {
  if ("$Expected" -eq "$Actual") { Write-Host "pass: $Name" } else { $script:failures += "$Name`: expected '$Expected', got '$Actual'" }
}

function Process([int]$Id, [int]$Parent, [string]$CommandLine) {
  return [pscustomobject]@{ ProcessId = $Id; ParentProcessId = $Parent; CommandLine = $CommandLine }
}

$running = @(
  (Process 10 1 '"C:\Users\a\AppData\Local\Programs\Ardia\Ardia.exe" '),
  (Process 11 10 'C:\Users\a\AppData\Local\Programs\Ardia\Ardia.exe --type=crashpad-handler "--user-data-dir=C:\x"'),
  (Process 12 10 '"C:\Users\a\AppData\Local\Programs\Ardia\Ardia.exe" --type=gpu-process --field-trial-handle=1'),
  (Process 20 1 '"C:\Users\a\AppData\Local\Programs\Ardia\Ardia.exe" --single-argument https://example.com/--type=x'),
  (Process 30 1 $null)
)
Check "a process without --type is a browser process" "10,20" ((Get-BrowserProcesses $running | ForEach-Object ProcessId) -join ",")
Check "an address that contains --type is still a browser process" $true ((Get-BrowserProcesses $running | ForEach-Object ProcessId) -contains 20)
Check "a process with no command line is not counted" $false ((Get-BrowserProcesses $running | ForEach-Object ProcessId) -contains 30)
Check "children are found by parent id" "11,12" ((Get-ChildProcesses $running 10 | ForEach-Object ProcessId) -join ",")
Check "a browser that has started nothing has no children" 0 @(Get-ChildProcesses $running 20).Count
Check "the crash handler, which starts before the engine, isn't a browser child" "12" ((Get-BrowserChildren $running 10 | ForEach-Object ProcessId) -join ",")
Check "a waiting launch with only its crash handler has no browser children" 0 @(Get-BrowserChildren @((Process 40 1 'x'), (Process 41 40 'Ardia.exe --type=crashpad-handler --monitor-self')) 40).Count

$waited = Read-LaunchGuard @(
  "launch 270 process started inside the engine",
  "engine 0 launch guard: waited 2875 ms for the previous Ardia on this profile to finish exiting",
  "engine 0 launch guard: waited 2875 ms for a previous Ardia, 0 unfinished starts before this one, restore state kept"
)
Check "the wait for a previous Ardia is read" 2875 $waited.WaitedMs
Check "unfinished starts are read" 0 $waited.UnfinishedBefore
Check "kept restore state is not set aside" $false $waited.SetAside
Check "a clean log has no fatal lines" 0 $waited.Fatal.Count

$recovered = Read-LaunchGuard @("engine 0 launch guard: waited 0 ms for a previous Ardia, 2 unfinished starts before this one, restore state set aside")
Check "two unfinished starts are read" 2 $recovered.UnfinishedBefore
Check "set-aside restore state is read" $true $recovered.SetAside

$failed = Read-LaunchGuard @(
  "error 317 the app could not start inside the engine: Class not registered",
  "engine 0 app start failed: the app could not start inside the engine: Class not registered (code 13).",
  "[3088:1728:1116/002259.416:FATAL:chrome\browser\browser_process_impl.cc:1959] Check failed: base::RunLoop::IsRunningOnCurrentThread().",
  "fatal 330 crash 0x80000003 at chrome.dll+0x82104BA"
)
Check "a start failure's reason is read" "the app could not start inside the engine: Class not registered (code 13)." $failed.StartFailure
Check "the engine's CHECK and the crash handler's lines are fatal" 2 $failed.Fatal.Count
Check "a log without guard lines reads as unknown" "" (Read-LaunchGuard @("info 1 hello")).WaitedMs

if ($failures.Count) {
  $failures | ForEach-Object { Write-Host "::error::$_" }
  exit 1
}
Write-Host "Launch logs and process lists read as the relaunch check expects."
