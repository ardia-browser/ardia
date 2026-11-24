. C:\pilot\lib.ps1
$ErrorActionPreference = 'Continue'
$results = New-Object System.Collections.Specialized.OrderedDictionary ([StringComparer]::Ordinal)
function Check([string]$name, [bool]$ok, [string]$detail) {
  $results[$name] = @{ ok = $ok; detail = $detail }
  Log ("{0} {1}: {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail))
}
function PagesCreated { (Shell-Lines-Matching 'page \d+ created').Count }
function PageTargets { @(Cdp-List | Where-Object { $_.type -eq 'page' -and $_.url -notlike 'chrome://ardia/*' } | ForEach-Object { $_.url }) }
function Js([string]$value) { $value | ConvertTo-Json -Compress }
function Invoke-Host([string]$method, [string]$argsJson) {
  Cdp-Eval "__ardiaHost.invoke($(Js $method), $argsJson).then(r => JSON.stringify({ ok: true, r }), e => JSON.stringify({ ok: false, e: String(e && e.message || e) }))"
}
function Profiles { @(Get-ChildItem -LiteralPath "$Data\Chromium" -Directory -Filter 'Ardia *' -ErrorAction SilentlyContinue | ForEach-Object Name) }

Stop-Engine
Start-Shell -Fresh | Out-Null
Wait-ShellReady 60 | Out-Null

$made = Invoke-Host 'tab.create' '{ "key": "bridge-ok", "claim": "bridge-claim", "profile": "default", "url": "file:///C:/pilot/form.html?bridge" }' | ConvertFrom-Json
$control = $made.r.browserId
Wait-Until { ((PageTargets) -contains 'file:///C:/pilot/form.html?bridge') -and (PagesCreated) -ge 1 } 15 'the control page' -NoThrow | Out-Null
$targets = PageTargets
Check 'valid-create-reaches-the-sink' ($made.ok -and $control -and ($targets -contains 'file:///C:/pilot/form.html?bridge')) "tab.create answered $($made | ConvertTo-Json -Compress -Depth 6); pages: $($targets -join ' | ')"
$baseCreated = PagesCreated
$baseProfiles = (Profiles) -join '|'

$payload = '{ method: "tab.create", args: { key: "K", claim: "C", profile: "default", url: "file:///C:/pilot/form.html?malformed-K" } }'
$malformed = [ordered]@{
  'no-arguments'        = 'chrome.send("ardiaRequest", [])'
  'one-argument'        = 'chrome.send("ardiaRequest", ["m-one"])'
  'four-arguments'      = "chrome.send(`"ardiaRequest`", [`"m-four`", `"host.invoke`", $($payload -replace 'K', 'four'), `"extra`"])"
  'numeric-id'          = "chrome.send(`"ardiaRequest`", [7, `"host.invoke`", $($payload -replace 'K', 'numeric')])"
  'empty-id'            = "chrome.send(`"ardiaRequest`", [`"`", `"host.invoke`", $($payload -replace 'K', 'empty')])"
  'oversized-id'        = "chrome.send(`"ardiaRequest`", [`"x`".repeat(300), `"host.invoke`", $($payload -replace 'K', 'oversized')])"
  'operation-not-text'  = "chrome.send(`"ardiaRequest`", [`"m-op`", 5, $($payload -replace 'K', 'op')])"
  'payload-not-object'  = 'chrome.send("ardiaRequest", ["m-payload", "host.invoke", "tab.create"])'
  'payload-is-array'    = "chrome.send(`"ardiaRequest`", [`"m-array`", `"host.invoke`", [$($payload -replace 'K', 'array')]])"
  'host-args-not-object' = 'chrome.send("ardiaRequest", ["m-args", "host.invoke", { method: "tab.create", args: "file:///C:/pilot/form.html?malformed-args" }])'
  'unknown-operation'   = "chrome.send(`"ardiaRequest`", [`"m-unknown`", `"engine.raw`", $($payload -replace 'K', 'unknown')])"
  'unknown-method'      = 'chrome.send("ardiaRequest", ["m-method", "host.invoke", { method: "tab.createEverything", args: { url: "file:///C:/pilot/form.html?malformed-method" } }])'
  'key-missing'         = 'chrome.send("ardiaRequest", ["m-key", "host.invoke", { method: "tab.create", args: { claim: "C", profile: "default", url: "file:///C:/pilot/form.html?malformed-key" } }])'
  'key-oversized'       = 'chrome.send("ardiaRequest", ["m-bigkey", "host.invoke", { method: "tab.create", args: { key: "k".repeat(300), claim: "C", profile: "default", url: "file:///C:/pilot/form.html?malformed-bigkey" } }])'
  'url-not-text'        = 'chrome.send("ardiaRequest", ["m-urltype", "host.invoke", { method: "tab.create", args: { key: "urltype", claim: "C", profile: "default", url: { href: "file:///C:/pilot/form.html?malformed-urltype" } } }])'
}
foreach ($case in $malformed.GetEnumerator()) {
  $sent = Cdp-Eval "(() => { try { $($case.Value); return 'sent'; } catch (e) { return 'threw ' + e.message; } })()"
  Log "malformed $($case.Key): $sent"
}
$identity = Cdp-Eval '__ardiaHost.invoke("ArdiaShell.windowIdentity", {})'
$quiet = Never { (@(PageTargets | Where-Object { $_ -like '*malformed*' }).Count -gt 0) -or ((PagesCreated) -ne $baseCreated) } 2
$targets = PageTargets
$created = PagesCreated
$leaked = @($targets | Where-Object { $_ -like '*malformed*' })
Check 'malformed-requests-make-no-page' ($quiet -and ($created -eq $baseCreated) -and ($leaked.Count -eq 0) -and ($targets.Count -eq 1)) "$($malformed.Count) malformed requests, then a later request answered; pages created $baseCreated -> $created; pages: $($targets -join ' | ')"
Check 'bridge-answers-after-malformed-requests' ($identity -eq 'main') "ArdiaShell.windowIdentity answered '$identity'"
$refusals = [ordered]@{
  'key-missing'   = '{ "claim": "C", "profile": "default", "url": "file:///C:/pilot/form.html?refused-key" }'
  'key-oversized' = "{ `"key`": $(Js ('k' * 300)), `"claim`": `"C`", `"profile`": `"default`", `"url`": `"file:///C:/pilot/form.html?refused-bigkey`" }"
  'claim-missing' = '{ "key": "refused-claim", "profile": "default", "url": "file:///C:/pilot/form.html?refused-claim" }'
  'url-not-text'  = '{ "key": "refused-urltype", "claim": "C", "profile": "default", "url": { "href": "file:///C:/pilot/form.html?refused-urltype" } }'
  'url-is-list'   = '{ "key": "refused-urllist", "claim": "C", "profile": "default", "url": ["file:///C:/pilot/form.html?refused-urllist"] }'
  'private-profile' = '{ "key": "refused-private", "claim": "C", "profile": "@default", "url": "file:///C:/pilot/form.html?refused-private" }'
}
$refusedCount = 0
foreach ($case in $refusals.GetEnumerator()) {
  $answer = Invoke-Host 'tab.create' $case.Value | ConvertFrom-Json
  Log "refusal $($case.Key) -> $($answer | ConvertTo-Json -Compress -Depth 6)"
  if (-not $answer.ok) { $refusedCount++ }
}
$quiet = Never { @(PageTargets | Where-Object { $_ -like '*refused*' }).Count -gt 0 } 2
$targets = PageTargets
Check 'bad-create-arguments-refused' ($quiet -and ($refusedCount -eq $refusals.Count) -and ((PagesCreated) -eq $baseCreated) -and (@($targets | Where-Object { $_ -like '*refused*' }).Count -eq 0)) "$refusedCount of $($refusals.Count) refused with an answer; pages: $($targets -join ' | ')"

$reserved = @(
  'javascript:alert(1)', 'JavaScript:alert(1)', 'chrome://ardia/', 'CHROME://ARDIA/index.html', 'chrome://ardia./',
  'ardia://ardia/', 'ArDiA://ardia/', 'view-source:chrome://ardia/', 'view-source:javascript:alert(1)',
  'view-source:view-source:chrome://ardia/', 'http://[not a host', 'not a url at all'
)
$n = 0
foreach ($url in $reserved) {
  $n++
  $answer = Invoke-Host 'tab.create' "{ `"key`": `"reserved-$n`", `"claim`": `"reserved-claim`", `"profile`": `"reservedprofile`", `"url`": $(Js $url) }" | ConvertFrom-Json
  Log "reserved tab.create $url -> $($answer | ConvertTo-Json -Compress -Depth 6)"
  $results["reserved-create $url"] = @{ ok = (-not $answer.ok); detail = "$($answer.e)" }
}
$quiet = Never { (Test-Path -LiteralPath "$Data\Chromium\Ardia reservedprofile") -or ((PageTargets).Count -ne 1) } 2
$targets = PageTargets
$refusedAll = @($reserved | Where-Object { $results["reserved-create $_"].ok }).Count
$reservedProfile = Test-Path -LiteralPath "$Data\Chromium\Ardia reservedprofile"
Check 'reserved-tab-urls-refused' ($quiet -and ($refusedAll -eq $reserved.Count) -and ((PagesCreated) -eq $baseCreated) -and ($targets.Count -eq 1)) "$refusedAll of $($reserved.Count) refused; pages: $($targets -join ' | ')"
Check 'reserved-url-loads-no-profile' ((-not $reservedProfile) -and (((Profiles) -join '|') -eq $baseProfiles)) "Ardia reservedprofile on disk: $reservedProfile; profile folders $baseProfiles -> $((Profiles) -join '|')"

$navigations = @('javascript:document.title="owned"', 'chrome://ardia/', 'ArDiA://ardia/', 'view-source:chrome://ardia/', '')
foreach ($url in $navigations) {
  $answer = Invoke-Host 'tab.command' "{ `"id`": $control, `"claim`": `"bridge-claim`", `"command`": `"loadUrl`", `"args`": [$(Js $url)] }" | ConvertFrom-Json
  Log "reserved loadUrl '$url' -> $($answer | ConvertTo-Json -Compress -Depth 6)"
  $results["reserved-load '$url'"] = @{ ok = (-not $answer.ok); detail = "$($answer.e)" }
}
$wrongClaim = Invoke-Host 'tab.command' "{ `"id`": $control, `"claim`": `"someone-else`", `"command`": `"loadUrl`", `"args`": [`"file:///C:/pilot/form.html?stolen`"] }" | ConvertFrom-Json
$noArgs = Invoke-Host 'tab.command' "{ `"id`": $control, `"claim`": `"bridge-claim`", `"command`": `"loadUrl`", `"args`": `"file:///C:/pilot/form.html?scalar`" }" | ConvertFrom-Json
$quiet = Never { (PageTargets) -notcontains 'file:///C:/pilot/form.html?bridge' } 2
$targets = PageTargets
$title = Cdp-Eval 'document.title' 'file:///C:/pilot/form.html'
$refusedLoads = @($navigations | Where-Object { $results["reserved-load '$_'"].ok }).Count
Check 'reserved-navigation-refused' ($quiet -and ($refusedLoads -eq $navigations.Count) -and ($targets -contains 'file:///C:/pilot/form.html?bridge') -and ($title -ne 'owned')) "$refusedLoads of $($navigations.Count) refused; page still at $($targets -join ' | '), title '$title'"
Check 'wrong-claim-cannot-navigate' ((-not $wrongClaim.ok) -and ($targets -notcontains 'file:///C:/pilot/form.html?stolen')) "answer $($wrongClaim | ConvertTo-Json -Compress)"
Check 'loadurl-without-a-list-does-nothing' ($targets -notcontains 'file:///C:/pilot/form.html?scalar') "answer $($noArgs | ConvertTo-Json -Compress); pages: $($targets -join ' | ')"

$load = Invoke-Host 'tab.command' "{ `"id`": $control, `"claim`": `"bridge-claim`", `"command`": `"loadUrl`", `"args`": [`"file:///C:/pilot/form.html?loaded`"] }" | ConvertFrom-Json
Wait-Until { (PageTargets) -contains 'file:///C:/pilot/form.html?loaded' } 15 'the page to load the new URL' -NoThrow | Out-Null
$targets = PageTargets
Check 'valid-navigation-reaches-the-sink' ($load.ok -and ($targets -contains 'file:///C:/pilot/form.html?loaded')) "answer $($load | ConvertTo-Json -Compress); pages: $($targets -join ' | ')"
$second = Invoke-Host 'tab.create' '{ "key": "bridge-second", "claim": "bridge-claim-2", "profile": "default", "url": "file:///C:/pilot/form.html?second" }' | ConvertFrom-Json
Wait-Until { ((PageTargets) -contains 'file:///C:/pilot/form.html?second') -and (PagesCreated) -eq $baseCreated + 1 } 15 'the second page' -NoThrow | Out-Null
$targets = PageTargets
Check 'valid-create-after-hostile-input' ($second.ok -and ($targets -contains 'file:///C:/pilot/form.html?second') -and ((PagesCreated) -eq $baseCreated + 1)) "pages: $($targets -join ' | ')"

Stop-Engine
$results | ConvertTo-Json -Depth 4 | Set-Content "$Proof\bridge-results.json"
Remove-PilotRun $RunRoot
"DONE bridge"
