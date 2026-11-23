. C:\pilot\lib.ps1
$ErrorActionPreference = 'Continue'
$results = New-Object System.Collections.Specialized.OrderedDictionary ([StringComparer]::Ordinal)
function Check([string]$name, [bool]$ok, [string]$detail) {
  $results[$name] = @{ ok = $ok; detail = $detail }
  Log ("{0} {1}: {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail))
}
function Send-Then-Barrier([string]$request) {
  Cdp-Eval "(() => { $request; return window.__ardiaHost.invoke('ArdiaShell.windowIdentity', {}); })()"
}
function Crash-And-Reload([int]$after, [string[]]$expect) {
  Cdp-Command 'Page.crash' @{} -NoReply | Out-Null
  Wait-Until { (Shell-Lines-Matching 'shell document retired; generation is now' $after).Count -ge 1 } 20 'the crashed document to retire' -NoThrow | Out-Null
  $live = (Shell-Lines-Matching 'shell document \d+ is live' $after).Count
  Cdp-Command 'Page.reload' @{ ignoreCache = $true } | Out-Null
  Wait-Until { (Shell-Lines-Matching 'shell document \d+ is live' $after).Count -gt $live } 30 'the reloaded document to go live' -NoThrow | Out-Null
  foreach ($pattern in $expect) { Wait-Until { (Shell-Lines-Matching $pattern $after).Count -ge 1 } 20 "a log line matching '$pattern'" -NoThrow | Out-Null }
  Wait-Until { (Cdp-Eval '__ardiaHost.invoke("ArdiaShell.windowIdentity", {})') -eq 'main' } 30 'the reloaded document to answer' -NoThrow | Out-Null
}
Stop-Engine
Start-Shell -Fresh | Out-Null
Wait-ShellReady 60 | Out-Null
$late = Cdp-Eval '__ardiaHost.invoke("ArdiaShell.testDelayedReply", { args: [1500] })'
Check 'delayed-reply-control' ($late -eq 'late') "a delayed reply to the live document resolves: '$late'"
Cdp-Eval '__ardiaHost.invoke("tab.create", { key: "stale-probe", claim: "stale-claim", profile: "default", url: "file:///C:/pilot/form.html" }).then(() => "made")' | Out-Null
Wait-Until { @(Cdp-List | Where-Object { $_.url -like 'file:///C:/pilot/form.html*' }).Count -ge 1 } 15 'the probe page' -NoThrow | Out-Null
$before = (Shell-Lines).Count
$origin = Cdp-Eval 'String(performance.timeOrigin)'
Send-Then-Barrier 'window.__ardiaHost.invoke("ArdiaShell.testDelayedReply", { args: [3000] })' | Out-Null
Crash-And-Reload $before @('reply dropped: shell document')
$after = @(Shell-Lines | Select-Object -Skip $before)
$after | ForEach-Object { Log "log $_" }
$retired = @($after | Where-Object { $_ -match 'shell document retired; generation is now (\d+), (\d+) pages of the old document dropped' })
$dropped = @($after | Where-Object { $_ -match 'reply dropped: shell document (\d+) is not the live one \((\d+)\)' })
$live = @($after | Where-Object { $_ -match 'shell document (\d+) is live' })
Check 'crash-retires-document' ($retired.Count -ge 1) "$($retired -join ' / ')"
Check 'old-reply-dropped' ($dropped.Count -ge 1) "$($dropped -join ' / ')"
Check 'reload-is-a-new-generation' ($live.Count -ge 1) "$($live -join ' / ')"
$reloaded = Cdp-Eval 'String(performance.timeOrigin)'
$answer = Cdp-Eval '__ardiaHost.invoke("ArdiaShell.windowIdentity", {})'
Check 'new-document-answers' (($answer -eq 'main') -and ($reloaded -ne $origin)) "new document (time origin $origin -> $reloaded) answers '$answer'"
$targets = (Cdp-List)
Log ("targets after reload: " + (($targets | ForEach-Object { $_.url }) -join ' | '))

$before = (Shell-Lines).Count
Send-Then-Barrier 'window.__ardiaHost.invoke("tab.create", { key: "orphan-probe", claim: "orphan-claim", profile: "default", url: "file:///C:/pilot/form.html?orphan", testDelayMs: 4000 })' | Out-Null
Crash-And-Reload $before @('page creation dropped')
$after = @(Shell-Lines | Select-Object -Skip $before)
$after | ForEach-Object { Log "log $_" }
$orphanDropped = @($after | Where-Object { $_ -match 'page creation dropped( before its profile loaded)?: shell document (\d+) is not the live one' })
$targets = (Cdp-List)
$orphan = @($targets | Where-Object { $_.url -like '*form.html?orphan*' })
Check 'retired-document-makes-no-page' (($orphanDropped.Count -ge 1) -and ($orphan.Count -eq 0)) "$($orphanDropped -join ' / '); targets: $(($targets | ForEach-Object { $_.url }) -join ' | ')"

$before = (Shell-Lines).Count
$orphanProfile = "$Data\Chromium\Ardia orphanprofile"
Send-Then-Barrier 'window.__ardiaHost.invoke("tab.create", { key: "orphan-profile-probe", claim: "orphan-profile-claim", profile: "orphanprofile", url: "file:///C:/pilot/form.html?orphanprofile", testDelayMs: 4000 })' | Out-Null
Crash-And-Reload $before @('page creation dropped before its profile loaded')
$after = @(Shell-Lines | Select-Object -Skip $before)
$after | ForEach-Object { Log "log $_" }
$profileDropped = @($after | Where-Object { $_ -match 'page creation dropped before its profile loaded: shell document (\d+) is not the live one' })
$targets = (Cdp-List)
$orphan = @($targets | Where-Object { $_.url -like '*form.html?orphanprofile*' })
$madeProfile = Test-Path -LiteralPath $orphanProfile
Check 'retired-document-loads-no-profile' (($profileDropped.Count -ge 1) -and ($orphan.Count -eq 0) -and -not $madeProfile) "$($profileDropped -join ' / '); $orphanProfile on disk: $madeProfile"
$alive = Cdp-Eval '__ardiaHost.invoke("tab.create", { key: "after-orphan", claim: "after-orphan-claim", profile: "orphanprofile", url: "file:///C:/pilot/form.html?after" }).then(() => "made", e => "refused " + e)'
$madeNow = [bool](Wait-Until { Test-Path -LiteralPath $orphanProfile } 15 'the live document to load the profile' -NoThrow)
Check 'live-document-still-loads-that-profile' (($alive -eq 'made') -and $madeNow) "the live document's tab.create answered '$alive'; $orphanProfile on disk: $madeNow"
Stop-Engine
$results | ConvertTo-Json -Depth 4 | Set-Content "$Proof\stale-results.json"
Remove-PilotRun $RunRoot
"DONE stale"
