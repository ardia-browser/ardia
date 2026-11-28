param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Label = 'content-blocker-webui',
  [int]$BlockerSeconds = 120
)
$App = (Resolve-Path -LiteralPath $App).Path.TrimEnd('\')
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$env:PILOT_APP = $App
$env:PILOT_PROOF = (Resolve-Path -LiteralPath $Out).Path.TrimEnd('\')
if (-not $env:PILOT_RUNS) { $env:PILOT_RUNS = Join-Path $env:PILOT_PROOF 'runs' }
. (Join-Path $PSScriptRoot 'lib.ps1')
$ErrorActionPreference = 'Continue'

$results = New-Object System.Collections.Specialized.OrderedDictionary ([StringComparer]::Ordinal)
$started = Get-Date
$stepStarted = Get-Date
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
  $ms = [int]((Get-Date) - $script:stepStarted).TotalMilliseconds
  $results[$Name] = @{ ok = $Ok; detail = $Detail; ms = $ms }
  Log ("{0} {1} ({2} ms): {3}" -f ($(if ($Ok) { 'PASS' } else { 'FAIL' }), $Name, $ms, $Detail))
  $script:stepStarted = Get-Date
}
function Blocker-State {
  $json = Cdp-Eval '__ardiaHost.call("contentBlocker.state", "default", "{}").then(r => JSON.stringify({ ok: true, value: JSON.parse(r) }), e => JSON.stringify({ ok: false, code: e && e.code || null, message: String(e && e.message || e) }))'
  if ($json) { $json | ConvertFrom-Json } else { $null }
}
function Fixture-Page([string]$url) { Cdp-List | Where-Object { $_.type -eq 'page' -and $_.url -like "$url*" } | Select-Object -First 1 }

$fixtureLog = Join-Path $env:PILOT_PROOF "$Label-fixture.txt"
$fixture = Start-Process node -ArgumentList @((Join-Path $PSScriptRoot 'content-blocker-fixture.mjs'), '0') -PassThru -WindowStyle Hidden -RedirectStandardOutput $fixtureLog
$run = $null
try {
  $site = Wait-Until { $line = Get-Content -LiteralPath $fixtureLog -TotalCount 1 -ErrorAction SilentlyContinue; if ($line) { $line | ConvertFrom-Json } } 15 'the fixture server' -NoThrow
  Check 'fixture' ([bool]$site) "the ad-block fixture serves $($site.page) from $($site.served)"
  if (-not $site) { throw 'no fixture server' }
  $base = $site.page
  Check 'test-build' (Test-Path -LiteralPath (Join-Path $App 'Ardia.test-build') -PathType Leaf) "$App carries the Ardia.test-build marker CDP needs"
  if (-not $results['test-build'].ok) { throw "$App is not a test build" }
  $seedProblems = & node (Join-Path (Split-Path -Parent $PSScriptRoot) 'ubo-seed.mjs') --app $App --check 2>&1
  Check 'seeded' ($LASTEXITCODE -eq 0) "the packaged uBlock Origin carries its compiled engine for a new profile's first page: $seedProblems"

  Stop-Engine
  $run = New-PilotRun
  Start-Shell -Extra @($site.hostRule) | Out-Null
  Wait-ShellReady 90 | Out-Null
  $script:state = $null
  Wait-Until { $script:state = Blocker-State; $script:state -and $script:state.ok -and $script:state.value.stats.ready } $BlockerSeconds 'the content blocker to report ready' -NoThrow | Out-Null
  $state = $script:state
  $stateText = if ($state) { $state | ConvertTo-Json -Compress -Depth 4 } else { 'no answer' }
  if ($stateText.Length -gt 400) { $stateText = $stateText.Substring(0, 400) + '…' }
  Check 'blocker-ready' ([bool]($state -and $state.ok -and $state.value.stats.ready -and $state.value.enabled)) "contentBlocker.state: $stateText"

  Invoke-RestMethod -Method Put -TimeoutSec 10 "http://127.0.0.1:$(DevTools-Port)/json/new?$base" | Out-Null
  Wait-Until { Fixture-Page $base } 20 'a tab at the fixture' -NoThrow | Out-Null
  $ready = Wait-Until { (Cdp-Eval '!!(window.adCheck && window.adCheck.settled)' $base) -eq $true } 45 'the fixture to settle its checks' -NoThrow
  $page = if ($ready) { (Cdp-Eval 'JSON.stringify(window.adCheck)' $base) | ConvertFrom-Json } else { $null }
  $hits = @((Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "$($site.served)hits").Content | ConvertFrom-Json | ForEach-Object { $_ })
  $pageText = if ($page) { $page | ConvertTo-Json -Compress -Depth 4 } else { 'no result' }
  Check 'content-shown' ([bool]($page -and $page.contentShown)) "ordinary content stays visible: $pageText"
  Check 'content-request-loaded' ($hits -contains $site.contentScript) "the page's own script reached the server, so the page ran: $($hits -join ', ')"
  Check 'ads-hidden' ([bool]($page -and $page.ads -gt 0 -and $page.hiddenAds -eq $page.ads)) "every fake ad EasyList names is hidden: $pageText"
  Check 'ad-request-blocked' (-not ($hits -contains $site.adScript)) "the ad script never reached the server: $($hits -join ', ')"
  Check 'third-party-ad-blocked' ([bool]($page -and $page.reached.($site.thirdPartyAd) -eq $false)) "the third-party ad script was blocked: $pageText"
} catch {
  Check 'run' $false $_.Exception.Message
} finally {
  Stop-Engine
  if ($fixture) { Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue }
  if ($run) { Remove-PilotRun $run }
}

$failed = @($results.Keys | Where-Object { -not $results[$_].ok })
$report = [ordered]@{
  label = $Label
  app = $App
  started = $started.ToUniversalTime().ToString('o')
  seconds = [Math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  passed = $results.Count - $failed.Count
  failed = $failed.Count
  checks = $results
}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $env:PILOT_PROOF "$Label-results.json") -Encoding utf8
$lines = @('### Windows WebUI content blocker', '', "$($report.passed) of $($results.Count) checks passed in $($report.seconds) s.", '', '| Check | Result | ms | Detail |', '| --- | --- | --- | --- |')
foreach ($name in $results.Keys) {
  $row = $results[$name]
  $detail = ($row.detail -replace '\|', '\|' -replace '\r?\n', ' ')
  $lines += "| $name | $(if ($row.ok) { 'pass' } else { '**fail**' }) | $($row.ms) | $detail |"
}
$lines | Set-Content -LiteralPath (Join-Path $env:PILOT_PROOF "$Label.md") -Encoding utf8
"DONE $Label, $($failed.Count) failed"
if ($failed.Count) { exit 1 }
exit 0
