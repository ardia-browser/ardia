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

$paused = Read-SyncTrace @(
  "info 812 [sync] test: recoveredStart true, status paused",
  "info 4100 [sync] test: left as it was, status paused",
  "warn 9000 [sync] couldn't read sync.json"
)
Check "a recovered start is read from the sync trace" $true $paused.Recovered
Check "a paused start shows only the paused status" "paused" ($paused.Statuses -join ",")
Check "a paused start has no unlock or cycle line" 0 $paused.UnlocksOrCycles.Count
$ordinary = Read-SyncTrace @(
  "info 700 [sync] test: recoveredStart false, status starting",
  "info 1900 [sync] test: status updating",
  "info 2100 [sync] test: status updated",
  "warn 2200 [sync] unlocking at launch failed",
  "warn 2300 [sync] cycle failed"
)
Check "an ordinary start is read from the sync trace" $false $ordinary.Recovered
Check "an ordinary start's statuses are read in order" "starting,updating,updated" ($ordinary.Statuses -join ",")
Check "unlock and cycle lines are found" 2 $ordinary.UnlocksOrCycles.Count
Check "a trace without the unlock line doesn't say it unlocked" "" $ordinary.Unlocked
$unlocked = Read-SyncTrace @("info 650 [sync] test: recoveredStart false, status starting", "info 700 [sync] unlock finished: unlocked", "info 2100 [sync] test: status updated")
Check "the unlock that comes before the load is read" $true $unlocked.Unlocked
Check "the unlock line counts as an unlock" 1 $unlocked.UnlocksOrCycles.Count
Check "a key that didn't unlock is read" $false (Read-SyncTrace @("info 700 [sync] unlock finished: not unlocked")).Unlocked
Check "turning Sync on is read" "turned on" (Read-SyncTrace @("info 5000 [sync] test: turned on")).TurnedOn
Check "a log without the sync trace reads as unknown" $null (Read-SyncTrace @("info 1 hello")).Recovered

$scratch = Join-Path ([IO.Path]::GetTempPath()) "relaunch-facts-$([guid]::NewGuid())"
try {
  $syncData = Join-Path $scratch "data"
  $syncFolder = Join-Path $scratch "folder"
  New-Item -ItemType Directory -Force -Path $syncData, (Join-Path $syncFolder "chain") | Out-Null
  Set-Content -LiteralPath (Join-Path $syncData "sync-state.nns") -Value "state" -NoNewline
  Set-Content -LiteralPath (Join-Path $syncData "sync-journal-1.nns") -Value "journal" -NoNewline
  Set-Content -LiteralPath (Join-Path $syncData "session.json") -Value "{}" -NoNewline
  Set-Content -LiteralPath (Join-Path $syncFolder "chain/a.nns") -Value "a" -NoNewline
  $before = Get-SyncDigests $syncData $syncFolder
  Check "the sealed files and the sync folder are hashed, nothing else" "data/sync-journal-1.nns,data/sync-state.nns,folder/chain/a.nns" (@($before.Keys) -join ",")
  Check "unchanged files compare equal" 0 (Compare-SyncDigests $before (Get-SyncDigests $syncData $syncFolder)).Count
  Set-Content -LiteralPath (Join-Path $syncData "sync-journal-1.nns") -Value "journal2" -NoNewline
  Set-Content -LiteralPath (Join-Path $syncData "sync-journal-2.nns") -Value "new" -NoNewline
  Remove-Item -LiteralPath (Join-Path $syncFolder "chain/a.nns")
  Check "a changed, an added and a removed file are each reported" "data/sync-journal-1.nns changed,folder/chain/a.nns was removed,data/sync-journal-2.nns was added" ((Compare-SyncDigests $before (Get-SyncDigests $syncData $syncFolder)) -join ",")

  $docPath = Join-Path $syncData "sync.json"
  Set-Content -LiteralPath $docPath -Value '{"enabled":true,"seqs":{"b":2,"a":{"y":1,"x":0}},"pausedByGuard":true}'
  $doc = Read-SyncDoc $docPath
  Check "pausedByGuard is read from sync.json" $true $doc.PausedByGuard
  Check "seqs are read with sorted keys" '{"a":{"x":0,"y":1},"b":2}' $doc.Seqs
  Set-Content -LiteralPath $docPath -Value '{"enabled":true,"seqs":{"a":{"x":0,"y":1},"b":2}}'
  Check "the same seqs in another order read the same" '{"a":{"x":0,"y":1},"b":2}' (Read-SyncDoc $docPath).Seqs
  Check "a doc without the pause reads as not paused" $false (Read-SyncDoc $docPath).PausedByGuard
  Check "a missing sync.json is not found" $false (Read-SyncDoc (Join-Path $syncData "absent.json")).Found
  Check "an absent unsettledStarts reads as 0" 0 (Read-SyncDoc $docPath).UnsettledStarts
  Set-Content -LiteralPath $docPath -Value '{"enabled":true,"unsettledStarts":2,"pausedByGuard":true}'
  Check "unsettledStarts is read" 2 (Read-SyncDoc $docPath).UnsettledStarts
  Set-Content -LiteralPath $docPath -Value '{"enabled":true,"unsettledStarts":"2"}'
  Check "an unsettledStarts that isn't a number reads as 0" 0 (Read-SyncDoc $docPath).UnsettledStarts
  Check "a sync.json read while running gives the same facts" 0 (Read-SyncDocWhileRunning $docPath).UnsettledStarts
} finally {
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

$local = @(
  '{"at":1000,"kind":"event","sent":false,"event":"usage_counts","uuid":"1","distinct_id":null,"properties":{"sync_paused_by_launch_guard":1}}',
  '{"at":2000,"kind":"event","sent":false,"event":"usage_counts","uuid":"2","distinct_id":null,"properties":{"sync_paused_by_launch_guard":0,"sync_resumes":0}}',
  '{"at":500,"kind":"event","sent":false,"event":"usage_counts","uuid":"3","distinct_id":null,"properties":{"sync_paused_by_launch_guard":1}}',
  '{"at":1500,"kind":"log","sent":false,"level":"warn","message":"sync_paused_by_launch_guard","attributes":{}}',
  'not json "sync_paused_by_launch_guard"'
)
Check "the pause count is summed over one start's local events" 1 (Measure-LocalCount $local "usage_counts" "sync_paused_by_launch_guard" 900 2500)
Check "events outside the start aren't counted" 2 (Measure-LocalCount $local "usage_counts" "sync_paused_by_launch_guard" 0 2500)

$before = @("launch 12 process started inside the engine", "info 40 [sync] test: recoveredStart false, status starting", "launch 9000 process ending")
$older = @("launch 10 process started inside the engine", "launch 500 process ending")
$mark = Get-LogMark $before $older
Check "a mark counts the log's lines" 3 $mark.From
$grown = $before + @("launch 15 process started inside the engine", "info 308 [sync] test: recoveredStart true, status paused")
Check "a log that grew gives only the new lines" "launch 15 process started inside the engine|info 308 [sync] test: recoveredStart true, status paused" ((Get-RunLines $mark $grown $older) -join "|")
$rotatedNew = @("launch 11 process started inside the engine", "engine 0 launch guard: waited 0 ms for a previous Ardia, 2 unfinished starts before this one, restore state set aside", "info 308 [sync] test: recoveredStart true, status paused") + @(1..89 | ForEach-Object { "info $_ line" }) + @("launch 9100 process ending")
$rotatedPrevious = $before + @("launch 9050 shutdown finished")
$runLines = Get-RunLines $mark $rotatedNew $rotatedPrevious
Check "a rotated log is read whole, with the old log's lines after the mark" 94 $runLines.Count
Check "the old log's tail comes first" "launch 9050 shutdown finished" $runLines[0]
Check "the rotated run's trace is found" $true (Read-SyncTrace $runLines).Recovered
Check "the rotated run's guard line is found" $true (Read-LaunchGuard $runLines).SetAside
Check "a rotation with nothing more in the old log reads the new log alone" 93 (Get-RunLines $mark $rotatedNew $before).Count
$sameFirst = @($before[0], "launch 20 another start's line")
Check "a rotated log that happens to start with the same line is still read whole" 2 (Get-RunLines $mark $sameFirst $before).Count
Check "an empty log at the mark gives every line" 2 (Get-RunLines (Get-LogMark @() @()) @("a", "b") @()).Count
$twin = @($before[0], "info 41 [sync] test: recoveredStart false, status starting", "launch 9001 process ending")
Check "a rotated log with the same length and first line as the marked one is read whole" "launch 9001 process ending" (@(Get-RunLines $mark $twin $before) -join "|").Split("|")[-1]
Check "and every one of its lines is read" 3 @(Get-RunLines $mark $twin $before).Count

if ($failures.Count) {
  $failures | ForEach-Object { Write-Host "::error::$_" }
  exit 1
}
Write-Host "Launch logs and process lists read as the relaunch check expects."
