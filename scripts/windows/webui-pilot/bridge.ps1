. C:\pilot\lib.ps1
$ErrorActionPreference = 'Continue'
$results = New-Object System.Collections.Specialized.OrderedDictionary ([StringComparer]::Ordinal)
function Check([string]$name, [bool]$ok, [string]$detail) {
  $results[$name] = @{ ok = $ok; detail = $detail }
  Log ("{0} {1}: {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail))
}
function PageTargets { @(Cdp-List | Where-Object { $_.type -eq 'page' -and $_.url -notlike 'chrome://ardia/*' } | ForEach-Object { $_.url }) }
function PagesCreated { (PageTargets).Count }
function Made-Tab([object]$answer, [string]$claim) { [bool]($answer.ok -and ($answer.r.browserId -is [int] -or $answer.r.browserId -is [long]) -and ($answer.r.browserId -gt 0) -and ($answer.r.lease.claim -ceq $claim) -and ($answer.r.lease.rendererGeneration -match '^[1-9]\d*$')) }
function Js([string]$value) { $value | ConvertTo-Json -Compress }
function Invoke-Host([string]$method, [string]$argsJson) {
  Cdp-Eval "__ardiaHost.invoke($(Js $method), $argsJson).then(r => JSON.stringify({ ok: true, r }), e => JSON.stringify({ ok: false, e: String(e && e.message || e) }))"
}
function Profiles { @(Get-ChildItem -LiteralPath "$Data\Chromium" -Directory -Filter 'Ardia *' -ErrorAction SilentlyContinue | ForEach-Object Name) }

function Free-LoopbackPort {
  $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $probe.Start()
  $port = $probe.LocalEndpoint.Port
  $probe.Stop()
  $port
}
$telemetryPort = Free-LoopbackPort
$telemetryCapture = Join-Path $Proof "bridge-telemetry-capture-$telemetryPort.json"
Remove-Item -LiteralPath $telemetryCapture, "$telemetryCapture.ready" -Force -ErrorAction SilentlyContinue
$env:ARDIA_TEST_TELEMETRY_ENDPOINT = "http://127.0.0.1:$telemetryPort/otel/v1/logs"

Stop-Engine
Start-Shell -Fresh | Out-Null
Wait-ShellReady 60 | Out-Null

$made = Invoke-Host 'tab.create' '{ "key": "bridge-ok", "claim": "bridge-claim", "profile": "default", "url": "file:///C:/pilot/form.html?bridge" }' | ConvertFrom-Json
$control = $made.r.browserId
Wait-Until { ((PageTargets) -contains 'file:///C:/pilot/form.html?bridge') -and (PagesCreated) -ge 1 } 15 'the control page' -NoThrow | Out-Null
$targets = PageTargets
Check 'valid-create-reaches-the-sink' ((Made-Tab $made 'bridge-claim') -and ($targets -contains 'file:///C:/pilot/form.html?bridge')) "tab.create answered $($made | ConvertTo-Json -Compress -Depth 6); pages: $($targets -join ' | ')"
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
$identity = Window-Identity
$quiet = Never { (@(PageTargets | Where-Object { $_ -like '*malformed*' }).Count -gt 0) -or ((PagesCreated) -ne $baseCreated) } 2
$targets = PageTargets
$created = PagesCreated
$leaked = @($targets | Where-Object { $_ -like '*malformed*' })
Check 'malformed-requests-make-no-page' ($quiet -and ($created -eq $baseCreated) -and ($leaked.Count -eq 0) -and ($targets.Count -eq 1)) "$($malformed.Count) malformed requests, then a later request answered; pages created $baseCreated -> $created; pages: $($targets -join ' | ')"
Check 'bridge-answers-after-malformed-requests' (Is-Window $identity) "ArdiaShell.windowIdentity answered $(Identity-Text $identity)"
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
Check 'valid-create-after-hostile-input' ((Made-Tab $second 'bridge-claim-2') -and ($second.r.browserId -ne $control) -and ($targets -contains 'file:///C:/pilot/form.html?second') -and ((PagesCreated) -eq $baseCreated + 1)) "tab.create answered $($second | ConvertTo-Json -Compress -Depth 6); pages $baseCreated -> $(PagesCreated): $($targets -join ' | ')"

function Invoke-HostExpr([string]$method, [string]$argsExpression) {
  $answer = Cdp-Eval "(() => { let pending; try { pending = __ardiaHost.invoke($(Js $method), { args: $argsExpression }); } catch (e) { return JSON.stringify({ ok: false, kind: 'sync', message: String(e && e.message || e) }); } return pending.then(value => JSON.stringify({ ok: true, value: value === undefined ? null : value }), e => { const message = String(e && e.message || e); if (e && typeof e === 'object' && Object.hasOwn(e, 'code')) return JSON.stringify({ ok: false, kind: 'native', code: String(e.code), message }); return JSON.stringify({ ok: false, kind: /^Native request timed out/.test(message) ? 'timeout' : 'transport', message }); }); })()"
  if ($null -eq $answer) { return [pscustomobject]@{ ok = $false; kind = 'transport'; code = $null; message = 'no CDP answer' } }
  $answer | ConvertFrom-Json
}
function Native-Refusal($answer, [string]$code) {
  ($null -ne $answer) -and ($answer.ok -eq $false) -and ($answer.kind -ceq 'native') -and ($answer.code -ceq $code)
}
function Answer-Text($answer) { if ($null -eq $answer) { 'null' } else { $answer | ConvertTo-Json -Compress -Depth 4 } }
$EngineWrittenDocuments = @('session.json', 'live.json', 'live.canonical.json', 'rnw-migration.json', 'rnw-migration.lock', 'launch-starts.txt', 'launch-starts.txt.tmp', 'launch-guard.json')
function Folder-Snapshot([string]$root) {
  @(Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object {
    if ($_.PSIsContainer) { "D:$($_.Name)" } elseif ($EngineWrittenDocuments -notcontains $_.Name) { "F:$($_.Name):$($_.Length):$($_.LastWriteTimeUtc.Ticks)" }
  }) -join '|'
}
function Prototype-Shape { Cdp-Eval 'JSON.stringify({ own: Object.getOwnPropertyNames(Object.prototype).sort(), plain: Object.getPrototypeOf({}) === Object.prototype, polluted: ({}).pilotPolluted === undefined && ({}).polluted === undefined })' }

$outsideCanary = Join-Path $RunRoot 'outside-canary.json'
Set-Content -LiteralPath $outsideCanary '{"canary":"untouched"}' -NoNewline
$canaryBefore = Get-Content -LiteralPath $outsideCanary -Raw
$runBefore = Folder-Snapshot $RunRoot
$dataBefore = Folder-Snapshot $Data
$prototypeBefore = Prototype-Shape

$corpus = Get-Content -LiteralPath 'C:\pilot\hostile-corpus.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$docHostileNames = @(
  '', '.', '..', '../outside-canary.json', '..\\outside-canary.json', 'a/b.json', 'a\\b.json',
  '.hidden.json', 'trailing.', ' leading.json', 'trailing.json ', 'foo:bar.json', 'foo.json:$DATA',
  'CON', 'CON.json', 'PRN.txt', 'AUX', 'NUL.json', 'COM1', 'COM9.json', 'LPT1', 'LPT9.txt',
  'session.json', 'SESSION.JSON', 'live.json', 'LIVE.JSON', 'live.canonical.json', 'Live.Canonical.Json',
  'rnw-migration.json', 'RNW-Migration.JSON', 'rnw-migration.lock', 'RNW-MIGRATION.LOCK',
  'launch-starts.txt', 'LAUNCH-STARTS.TXT', 'launch-starts.txt.tmp', 'Launch-Starts.TXT.tmp', ('a' * 201)
)
$docUnrefused = @()
$docAccepted = @()
$docRoundTripFailures = @()
function Expect-Refusal([string]$label, $answer, [string]$code) {
  if (-not (Native-Refusal $answer $code)) {
    $script:docUnrefused += $label
    Log "document $label expected native $code, answered $(Answer-Text $answer)"
  }
}
function Expect-Refused-Everywhere([string]$label, [string]$expression, [string]$code) {
  Expect-Refusal "read:$label" (Invoke-HostExpr 'ArdiaShell.readDocument' "[$expression]") $code
  Expect-Refusal "write:$label" (Invoke-HostExpr 'ArdiaShell.writeDocument' "[$expression, `"x`"]") $code
  Expect-Refusal "remove:$label" (Invoke-HostExpr 'ArdiaShell.removeDocument' "[$expression]") $code
}
function Expect-RoundTrip([string]$label, [string]$expression, [string]$name) {
  $contents = "pilot-roundtrip:$label"
  $path = Join-Path $Data $name
  $absent = Invoke-HostExpr 'ArdiaShell.readDocument' "[$expression]"
  $written = Invoke-HostExpr 'ArdiaShell.writeDocument' "[$expression, $(Js $contents)]"
  $read = Invoke-HostExpr 'ArdiaShell.readDocument' "[$expression]"
  $disk = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
  $removed = Invoke-HostExpr 'ArdiaShell.removeDocument' "[$expression]"
  $gone = Invoke-HostExpr 'ArdiaShell.readDocument' "[$expression]"
  $ok = ($absent.ok -eq $true) -and ($null -eq $absent.value) -and ($written.ok -eq $true) -and ($read.ok -eq $true) -and ($read.value -ceq $contents) -and ($disk -ceq $contents) -and ($removed.ok -eq $true) -and ($gone.ok -eq $true) -and ($null -eq $gone.value) -and (-not (Test-Path -LiteralPath $path))
  $script:docAccepted += $label
  if (-not $ok) {
    $script:docRoundTripFailures += $label
    Log "document round trip $label failed: absent=$(Answer-Text $absent) written=$(Answer-Text $written) read=$(Answer-Text $read) disk=$disk removed=$(Answer-Text $removed) gone=$(Answer-Text $gone)"
  }
}
foreach ($case in $corpus.cases) {
  switch ($case.document) {
    'request' { Expect-Refused-Everywhere $case.id $case.expression 'ERR_DOCUMENT_REQUEST' }
    'name' { Expect-Refused-Everywhere $case.id $case.expression 'ERR_DOCUMENT_NAME' }
    'accepted' { Expect-RoundTrip $case.id $case.expression $case.name }
    default { $docUnrefused += "unclassified:$($case.id)" }
  }
}
foreach ($name in $docHostileNames) {
  Expect-Refused-Everywhere $name (Js $name) 'ERR_DOCUMENT_NAME'
}
foreach ($shape in @('[]', '["a.json", "b", "extra"]', '"a.json"', '{ "0": "a.json" }', '[123]', '[null]')) {
  Expect-Refusal "read-shape:$shape" (Invoke-HostExpr 'ArdiaShell.readDocument' $shape) 'ERR_DOCUMENT_REQUEST'
  Expect-Refusal "remove-shape:$shape" (Invoke-HostExpr 'ArdiaShell.removeDocument' $shape) 'ERR_DOCUMENT_REQUEST'
}
foreach ($shape in @('[]', '["a.json"]', '["a.json", 123]', '["a.json", "x", "extra"]', '[123, "x"]')) {
  Expect-Refusal "write-shape:$shape" (Invoke-HostExpr 'ArdiaShell.writeDocument' $shape) 'ERR_DOCUMENT_REQUEST'
}
Expect-Refusal 'write:oversized' (Invoke-HostExpr 'ArdiaShell.writeDocument' '["oversized-doc.json", "x".repeat(8 * 1024 * 1024 + 1)]') 'ERR_DOCUMENT_LIMIT'

$prototypeAfter = Prototype-Shape
$canaryAfterHostile = Get-Content -LiteralPath $outsideCanary -Raw
$runAfterHostile = Folder-Snapshot $RunRoot
$dataAfterHostile = Folder-Snapshot $Data
Check 'documents-refuse-hostile-corpus' (($docUnrefused.Count -eq 0) -and ($canaryAfterHostile -eq $canaryBefore) -and ($runAfterHostile -eq $runBefore) -and ($dataAfterHostile -eq $dataBefore)) "not refused with the expected native code: $($docUnrefused -join ', '); outside canary intact: $($canaryAfterHostile -eq $canaryBefore); data unchanged: $($dataAfterHostile -eq $dataBefore)"
Check 'documents-accepted-corpus-names-roundtrip' (($docAccepted.Count -gt 0) -and ($docRoundTripFailures.Count -eq 0) -and ($null -ne $prototypeBefore) -and ($prototypeAfter -ceq $prototypeBefore)) "accepted names: $($docAccepted -join ', '); failed: $($docRoundTripFailures -join ', '); Object.prototype unchanged: $($prototypeAfter -ceq $prototypeBefore)"

$syncAliasPath = Join-Path $Data 'Sync-State.nns'
$syncAliasWrite = Invoke-HostExpr 'ArdiaShell.writeDocument' '["Sync-State.nns", "s".repeat(8 * 1024 * 1024 + 1)]'
$syncAliasSize = (Get-Item -LiteralPath $syncAliasPath -ErrorAction SilentlyContinue).Length
$syncAliasRemove = Invoke-HostExpr 'ArdiaShell.removeDocument' '["Sync-State.nns"]'
Check 'documents-sync-state-alias-limit' (($syncAliasWrite.ok -eq $true) -and ($syncAliasSize -eq (8 * 1024 * 1024 + 1)) -and ($syncAliasRemove.ok -eq $true) -and (-not (Test-Path -LiteralPath $syncAliasPath))) "write=$(Answer-Text $syncAliasWrite) size=$syncAliasSize remove=$(Answer-Text $syncAliasRemove)"

$guardPath = Join-Path $Data 'launch-guard.json'
$guardBefore = Get-Content -LiteralPath $guardPath -Raw -ErrorAction SilentlyContinue
$guardRead = Invoke-HostExpr 'ArdiaShell.readDocument' '["launch-guard.json"]'
$guardWrite = Invoke-HostExpr 'ArdiaShell.writeDocument' '["launch-guard.json", "{\"unfinishedStartsBefore\":99}"]'
$guardSave = Invoke-HostExpr 'ArdiaShell.saveDocument' '["launch-guard.json", "{\"unfinishedStartsBefore\":99}"]'
$guardWriteUpper = Invoke-HostExpr 'ArdiaShell.writeDocument' '["LAUNCH-GUARD.JSON", "{}"]'
$guardRemove = Invoke-HostExpr 'ArdiaShell.removeDocument' '["Launch-Guard.json"]'
$guardAfter = Get-Content -LiteralPath $guardPath -Raw -ErrorAction SilentlyContinue
Check 'documents-launch-guard-read-only' (($null -ne $guardBefore) -and ($guardRead.ok -eq $true) -and ($guardRead.value -ceq $guardBefore) -and (Native-Refusal $guardWrite 'ERR_DOCUMENT_NAME') -and (Native-Refusal $guardSave 'ERR_DOCUMENT_NAME') -and (Native-Refusal $guardWriteUpper 'ERR_DOCUMENT_NAME') -and (Native-Refusal $guardRemove 'ERR_DOCUMENT_NAME') -and ($guardAfter -ceq $guardBefore)) "read=$(Answer-Text $guardRead) write=$(Answer-Text $guardWrite) save=$(Answer-Text $guardSave) upper-case write=$(Answer-Text $guardWriteUpper) remove=$(Answer-Text $guardRemove); file unchanged $($guardAfter -ceq $guardBefore)"

$linkPath = Join-Path $Data 'escape-link.json'
cmd /c mklink "$linkPath" "$outsideCanary" | Out-Null
$linkItem = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
$linkType = if ($linkItem) { [string]$linkItem.LinkType } else { '' }
$linkRead = Invoke-HostExpr 'ArdiaShell.readDocument' '["escape-link.json"]'
$linkWrite = Invoke-HostExpr 'ArdiaShell.writeDocument' '["escape-link.json", "{\"pwned\":true}"]'
$linkRemove = Invoke-HostExpr 'ArdiaShell.removeDocument' '["escape-link.json"]'
$canaryAfterLink = Get-Content -LiteralPath $outsideCanary -Raw
$linkStillExists = Test-Path -LiteralPath $linkPath
if ($linkStillExists) { Remove-Item -LiteralPath $linkPath -Force }
Check 'documents-refuse-reparse-point' (($linkType -ne '') -and (Native-Refusal $linkRead 'ERR_DOCUMENT_READ') -and (Native-Refusal $linkWrite 'ERR_DOCUMENT_WRITE') -and (Native-Refusal $linkRemove 'ERR_DOCUMENT_REMOVE') -and ($canaryAfterLink -eq $canaryBefore) -and $linkStillExists) "read=$(Answer-Text $linkRead) write=$(Answer-Text $linkWrite) remove=$(Answer-Text $linkRemove); outside canary intact: $($canaryAfterLink -eq $canaryBefore); link type $linkType"

$docAbsent = Invoke-HostExpr 'ArdiaShell.readDocument' '["pilot-roundtrip.json"]'
$docWritten = Invoke-HostExpr 'ArdiaShell.writeDocument' '["pilot-roundtrip.json", "{\"ok\":true}"]'
$docRead = Invoke-HostExpr 'ArdiaShell.readDocument' '["pilot-roundtrip.json"]'
$docDisk = Get-Content -LiteralPath (Join-Path $Data 'pilot-roundtrip.json') -Raw -ErrorAction SilentlyContinue
$docRemoved = Invoke-HostExpr 'ArdiaShell.removeDocument' '["pilot-roundtrip.json"]'
$docGone = Invoke-HostExpr 'ArdiaShell.readDocument' '["pilot-roundtrip.json"]'
Check 'documents-valid-roundtrip' (($docAbsent.ok -eq $true) -and ($null -eq $docAbsent.value) -and ($docWritten.ok -eq $true) -and ($docRead.ok -eq $true) -and ($docRead.value -eq '{"ok":true}') -and ($docDisk -eq '{"ok":true}') -and ($docRemoved.ok -eq $true) -and ($docGone.ok -eq $true) -and ($null -eq $docGone.value) -and (-not (Test-Path -LiteralPath (Join-Path $Data 'pilot-roundtrip.json')))) "absent=$($docAbsent.value), read=$($docRead.value), gone=$($docGone.value)"

$protoDocument = '{"pilotPolluted":true}'
$protoWrite = Invoke-HostExpr 'ArdiaShell.writeDocument' "[`"__proto__`", $(Js $protoDocument)]"
$ordinaryWrite = Invoke-HostExpr 'ArdiaShell.writeDocument' '["pilot-bootstrap.json", "ordinary"]'
$originBefore = Cdp-Eval 'String(performance.timeOrigin)'
$liveBefore = (Shell-Lines-Matching 'shell document \d+ is live').Count
Cdp-Command 'Page.reload' @{ ignoreCache = $true } | Out-Null
Wait-Until { (Shell-Lines-Matching 'shell document \d+ is live').Count -gt $liveBefore } 30 'the reloaded document to go live' -NoThrow | Out-Null
Wait-Until { ((Cdp-Eval 'String(performance.timeOrigin)') -ne $originBefore) -and ((Cdp-Eval 'typeof window.__ardiaHost === "object"') -eq $true) } 30 'the reloaded document to answer' -NoThrow | Out-Null
$bootstrapDocs = Cdp-Eval "(() => { const docs = __ardiaHost.bootstrap.documents || {}; return JSON.stringify({ ownProto: Object.hasOwn(docs, '__proto__'), proto: Object.getOwnPropertyDescriptor(docs, '__proto__')?.value ?? null, ordinary: Object.hasOwn(docs, 'pilot-bootstrap.json') ? docs['pilot-bootstrap.json'] : null, plain: Object.getPrototypeOf(docs) === Object.prototype, clean: ({}).pilotPolluted === undefined, mapped: new Map(Object.entries(docs)).get('__proto__') ?? null }); })()" | ConvertFrom-Json
$protoRemove = Invoke-HostExpr 'ArdiaShell.removeDocument' '["__proto__"]'
$ordinaryRemove = Invoke-HostExpr 'ArdiaShell.removeDocument' '["pilot-bootstrap.json"]'
Check 'bootstrap-keeps-proto-document' (($protoWrite.ok -eq $true) -and ($ordinaryWrite.ok -eq $true) -and $bootstrapDocs.ownProto -and ($bootstrapDocs.proto -ceq $protoDocument) -and ($bootstrapDocs.mapped -ceq $protoDocument) -and ($bootstrapDocs.ordinary -ceq 'ordinary') -and $bootstrapDocs.plain -and $bootstrapDocs.clean -and ($protoRemove.ok -eq $true) -and ($ordinaryRemove.ok -eq $true) -and (-not (Test-Path -LiteralPath (Join-Path $Data '__proto__')))) "bootstrap documents after reload: $(Answer-Text $bootstrapDocs)"

function Telemetry-Sink {
  $answer = Invoke-HostExpr 'ArdiaShell.testTelemetrySink' '[]'
  if ($answer.ok -eq $true) { $answer.value } else { $null }
}
$telemetryKey = 'ak_app_0123456789abcdef01234567'
$telemetryKeyExpr = Js $telemetryKey
$telemetryBadCases = @(
  '[]',
  '["{}"]',
  "[`"{}`", $telemetryKeyExpr, `"extra`"]",
  "[123, $telemetryKeyExpr]",
  '["{}", 123]',
  "[`"`", $telemetryKeyExpr]",
  "[`"not-json`", $telemetryKeyExpr]",
  "[`"{`", $telemetryKeyExpr]",
  "[`"{\`"a\`":`", $telemetryKeyExpr]",
  "[`"{} trailing`", $telemetryKeyExpr]",
  "[`"[]`", $telemetryKeyExpr]",
  "[`"\`"x\`"`", $telemetryKeyExpr]",
  "[`"null`", $telemetryKeyExpr]",
  '["{}", "bad_key"]',
  '["{}", "ak_app_0123456789ABCDEF01234567"]',
  '["{}", "ak__0123456789abcdef01234567"]',
  "[`"{}`", $(Js "$telemetryKey`r`nX-Injected: 1")]",
  "[`"{}`", $(Js "$telemetryKey`nX-Injected: 1")]",
  "[`"{\`"a\`":\`"`" + `"a`".repeat(524289) + `"\`"}`", $telemetryKeyExpr]"
)
$telemetrySinkBefore = Telemetry-Sink
$telemetryUnrefused = @()
function Expect-TelemetryRefusal([string]$label, [string]$argsExpression) {
  $ans = Invoke-HostExpr 'ArdiaTelemetry.post' $argsExpression
  if (-not (Native-Refusal $ans 'ERR_TELEMETRY_REFUSED')) {
    $script:telemetryUnrefused += "$label => $(Answer-Text $ans)"
  }
}
foreach ($caseExpr in $telemetryBadCases) {
  Expect-TelemetryRefusal $caseExpr $caseExpr
}
foreach ($case in $corpus.cases) {
  Expect-TelemetryRefusal "body:$($case.id)" "[$($case.expression), $telemetryKeyExpr]"
  Expect-TelemetryRefusal "key:$($case.id)" "[`"{}`", $($case.expression)]"
}
foreach ($shape in $corpus.shapes) {
  Expect-TelemetryRefusal "shape:$($shape.id)" $shape.expression
}
Hold 1000
$telemetrySinkAfter = Telemetry-Sink
$telemetryCap = Cdp-Eval 'Boolean(window.__ardiaHost && Array.isArray(__ardiaHost.bootstrap.capabilities) && __ardiaHost.bootstrap.capabilities.includes("ArdiaTelemetry.post"))'
Check 'telemetry-refuses-invalid-requests' (($telemetryCap -eq $true) -and ($telemetryUnrefused.Count -eq 0) -and ($null -ne $telemetrySinkBefore) -and ($telemetrySinkBefore.requestsStarted -eq 0) -and ($telemetrySinkAfter.requestsStarted -eq 0) -and ($telemetrySinkAfter.inFlight -eq 0)) "advertised=$telemetryCap; $($telemetryBadCases.Count) bad requests and $($corpus.cases.Count) corpus values in both positions; not refused with ERR_TELEMETRY_REFUSED: $($telemetryUnrefused -join '; '); requests started $($telemetrySinkBefore.requestsStarted) -> $($telemetrySinkAfter.requestsStarted)"

$listener = Start-Job -ArgumentList $telemetryPort, $telemetryCapture -ScriptBlock {
  param([int]$port, [string]$capture)
  $server = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
  $server.Start()
  Set-Content -LiteralPath "$capture.ready" 'ready'
  try {
    $accept = $server.AcceptTcpClientAsync()
    if (-not $accept.Wait(30000)) { return }
    $client = $accept.Result
    $client.ReceiveTimeout = 10000
    $stream = $client.GetStream()
    $buffer = New-Object byte[] 65536
    $data = New-Object System.Collections.Generic.List[byte]
    $headerEnd = -1
    $length = 0
    while ($true) {
      $read = $stream.Read($buffer, 0, $buffer.Length)
      if ($read -le 0) { break }
      $data.AddRange([System.ArraySegment[byte]]::new($buffer, 0, $read))
      if ($headerEnd -lt 0) {
        $text = [Text.Encoding]::ASCII.GetString($data.ToArray())
        $headerEnd = $text.IndexOf("`r`n`r`n")
        if ($headerEnd -ge 0 -and $text.Substring(0, $headerEnd) -match '(?im)^content-length:\s*(\d+)\s*$') { $length = [int]$Matches[1] }
      }
      if ($headerEnd -ge 0 -and $data.Count -ge $headerEnd + 4 + $length) { break }
    }
    $bytes = $data.ToArray()
    $head = if ($headerEnd -ge 0) { [Text.Encoding]::ASCII.GetString($bytes, 0, $headerEnd) } else { '' }
    $body = if ($headerEnd -ge 0) { [Text.Encoding]::UTF8.GetString($bytes, $headerEnd + 4, $bytes.Length - $headerEnd - 4) } else { '' }
    $reply = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 204 No Content`r`nContent-Length: 0`r`nConnection: close`r`n`r`n")
    $stream.Write($reply, 0, $reply.Length)
    $stream.Flush()
    $client.Close()
    @{ head = $head; body = $body } | ConvertTo-Json -Compress | Set-Content -LiteralPath $capture -Encoding UTF8
  } finally {
    $server.Stop()
  }
}
$listenerReady = Wait-Until { Test-Path -LiteralPath "$telemetryCapture.ready" } 15 'the loopback telemetry listener' -NoThrow
$controlBody = '{"resourceLogs":[],"pilot":"bridge"}'
$controlPost = Invoke-HostExpr 'ArdiaTelemetry.post' "[$(Js $controlBody), $telemetryKeyExpr]"
Wait-Job $listener -Timeout 30 | Out-Null
Stop-Job $listener -ErrorAction SilentlyContinue
Remove-Job $listener -Force -ErrorAction SilentlyContinue
$captured = if (Test-Path -LiteralPath $telemetryCapture) { Get-Content -LiteralPath $telemetryCapture -Raw | ConvertFrom-Json } else { $null }
$telemetrySinkControl = Telemetry-Sink
$controlHead = if ($captured) { [string]$captured.head } else { '' }
$controlOk = [bool]$listenerReady -and ($controlPost.ok -eq $true) -and ($controlPost.value.status -eq 204) -and ($telemetrySinkControl.requestsStarted -eq 1) -and ($controlHead -match '^POST /otel/v1/logs HTTP/1\.1') -and ($controlHead -cmatch "(?im)^x-ardia-key: $telemetryKey\s*$") -and ($controlHead -match '(?im)^content-type: application/json\s*$') -and ($controlHead -notmatch '(?im)^cookie:') -and ($captured.body -ceq $controlBody)
Check 'telemetry-control-reaches-loopback-sink' $controlOk "answer $(Answer-Text $controlPost); requests started $($telemetrySinkAfter.requestsStarted) -> $($telemetrySinkControl.requestsStarted); captured head: $($controlHead -replace "`r`n", ' | ')"
Remove-Item -LiteralPath $telemetryCapture, "$telemetryCapture.ready" -Force -ErrorAction SilentlyContinue

Stop-Engine
Remove-Item Env:ARDIA_TEST_TELEMETRY_ENDPOINT -ErrorAction SilentlyContinue

$results | ConvertTo-Json -Depth 4 | Set-Content "$Proof\bridge-results.json"
Remove-PilotRun $RunRoot
"DONE bridge"
