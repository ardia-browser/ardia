. C:\pilot\lib.ps1
$ErrorActionPreference = 'Continue'
$results = New-Object System.Collections.Specialized.OrderedDictionary ([StringComparer]::Ordinal)
function Check([string]$name, [bool]$ok, [string]$detail) {
  $results[$name] = @{ ok = $ok; detail = $detail }
  Log ("{0} {1}: {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail))
}
function Js([string]$value) { $value | ConvertTo-Json -Compress }
function Invoke-Host([string]$method, [string]$argsJson) {
  Cdp-Eval "__ardiaHost.invoke($(Js $method), $argsJson).then(r => JSON.stringify({ ok: true, r }), e => JSON.stringify({ ok: false, e: String(e && e.message || e) }))" | ConvertFrom-Json
}
function Engine-Call([string]$name) {
  Cdp-Eval "__ardiaHost.call ? __ardiaHost.call($(Js $name), 'default', '{}').then(r => JSON.stringify({ ok: true, r }), e => JSON.stringify({ ok: false, e: String(e && e.message || e) })) : JSON.stringify({ ok: false, e: 'no call' })" | ConvertFrom-Json
}
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunSubKey = 'Software\Microsoft\Windows\CurrentVersion\Run'
function Run-Value([string]$name) { (Get-ItemProperty -LiteralPath $RunKey -Name $name -ErrorAction SilentlyContinue).$name }
function Read-RawRun([string]$name) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RunSubKey, $false)
  if ($null -eq $key) { return $null }
  try {
    $val = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -eq $val) { return $null }
    return @{ value = $val; kind = $key.GetValueKind($name) }
  } finally { $key.Dispose() }
}
function Restore-RawRun([string]$name, $saved) {
  if ($null -eq $saved) {
    Remove-ItemProperty -LiteralPath $RunKey -Name $name -ErrorAction SilentlyContinue
    return
  }
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($RunSubKey)
  try { $key.SetValue($name, $saved.value, $saved.kind) } finally { $key.Dispose() }
}
$Spawned = @('msedge', 'mshta', 'calc', 'CalculatorApp', 'msdt', 'explorer', 'SystemSettings', 'wscript', 'cscript')
function Spawned { @(Get-Process -Name $Spawned -ErrorAction SilentlyContinue | ForEach-Object Id) }
function Named([int[]]$ids) { @($ids | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p) { "$($p.Name)#$_ parent $((Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue).ParentProcessId)" } }) -join ', ' }

$edgeWasRunning = [bool](Get-Process -Name msedge -ErrorAction SilentlyContinue)
$OpenRefusals = @('A URL is required', 'The arguments must be a list')
$LoginRefusals = @('Opening at login takes one boolean', 'The arguments must be a list')
$DefaultRefusals = @('The default browser calls take no arguments', 'The arguments must be a list')
$settingsAtStart = @(Get-Process -Name SystemSettings -ErrorAction SilentlyContinue | ForEach-Object Id)
function Refused($answer, [string[]]$Expected, [switch]$FalseIsRefusal) {
  if ($null -eq $answer -or $null -eq $answer.ok) { return $false }
  if ($answer.ok -eq $true) { return [bool]$FalseIsRefusal -and ($answer.r -is [bool]) -and -not $answer.r }
  return ($answer.ok -eq $false) -and ($Expected -ccontains [string]$answer.e)
}
$MailApps = @('olk', 'HxOutlook', 'OUTLOOK', 'HxTsr', 'OpenWith')
$webuiRunBefore = Read-RawRun 'Ardia WebUI'
$mailWasRunning = @(Get-Process -Name $MailApps -ErrorAction SilentlyContinue | ForEach-Object Id)
$runStarted = Get-Date
$pilotEnginePids = @()
$failedRun = $false
try {
  Stop-Engine
  Start-Shell -Fresh | Out-Null
  Wait-ShellReady 60 | Out-Null

  $decorations = (Invoke-Host 'ArdiaShell.testWindowDecorations' '{}').r
  Check 'mica-corners-dark-title' ($decorations.backdropSet -and $decorations.cornersSet -and $decorations.darkTitleSet -and $decorations.backdrop -eq 2 -and $decorations.darkTitle -eq $decorations.systemDark) ($decorations | ConvertTo-Json -Compress)

  $rnwSync = Join-Path $env:LOCALAPPDATA 'Ardia\Sync'
  function Rnw-Keys { @(Get-ChildItem -LiteralPath $rnwSync -Filter 'sync-key-*' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Name) $($_.Length) $($_.LastWriteTimeUtc.Ticks)" }) -join '|' }
  $rnwKeysBefore = Rnw-Keys
  $secret = (Invoke-Host 'ArdiaShell.testSecretRoundTrip' '{}').r
  $underData = $secret.directory -like "$Data*"
  Check 'dpapi-secret-roundtrip' ($secret.opened -and $secret.kind -eq 'dpapi' -and $secret.probe -and $secret.saved -and $secret.same -and $secret.hidden -and $secret.boundToPurpose -and $secret.apartFromOtherInstances -and $secret.rejectsPathAccount -and $secret.deleted -and $underData) ($secret | ConvertTo-Json -Compress)
  Check 'dpapi-case-distinct-accounts' ($secret.caseIndependent -and $secret.caseFiles.lower -and $secret.caseFiles.upper -and $secret.caseFiles.lower.ToLowerInvariant() -ne $secret.caseFiles.upper.ToLowerInvariant()) ($secret.caseFiles | ConvertTo-Json -Compress)
  $leftovers = @(Get-ChildItem -LiteralPath (Join-Path $Data 'Sync') -Filter 'sync-key-*' -ErrorAction SilentlyContinue).Count
  Check 'dpapi-leaves-nothing-and-skips-rnw' (($leftovers -eq 0) -and ((Rnw-Keys) -eq $rnwKeysBefore)) "test keys left: $leftovers; RNW Sync keys unchanged: $((Rnw-Keys) -eq $rnwKeysBefore)"

  $corpus = Get-Content -LiteralPath 'C:\pilot\hostile-corpus.json' -Raw -Encoding UTF8 | ConvertFrom-Json
  function Sink-Calls { (Invoke-Host 'ArdiaShell.testOpenExternalSink' '{}').r.calls }
  function Open-With([string]$argsExpression) {
    Cdp-Eval "(() => { try { return __ardiaHost.invoke('ArdiaApp.openExternalURL', { args: $argsExpression }).then(r => JSON.stringify({ ok: true, r }), e => JSON.stringify({ ok: false, e: String(e && e.message || e) })); } catch (e) { return JSON.stringify({ ok: false, e: 'threw ' + e.message }); } })()" | ConvertFrom-Json
  }
  $before = Spawned
  $sinkBefore = Sink-Calls
  $unrefused = @()
  foreach ($case in $corpus.cases) {
    $answer = Open-With "[$($case.expression)]"
    if (-not (Refused $answer $OpenRefusals -FalseIsRefusal)) { $unrefused += $case.id; Log "open-external answered $($answer | ConvertTo-Json -Compress) for $($case.id)" }
  }
  foreach ($shape in $corpus.shapes) {
    $answer = Open-With $shape.expression
    if (-not (Refused $answer $OpenRefusals -FalseIsRefusal)) { $unrefused += $shape.id; Log "open-external answered $($answer | ConvertTo-Json -Compress) for $($shape.id)" }
  }
  Hold 2000
  $sinkAfter = Sink-Calls
  $fresh = @(Spawned | Where-Object { $before -notcontains $_ })
  Check 'open-external-refuses-shared-corpus' (($null -ne $sinkBefore) -and ($unrefused.Count -eq 0) -and ($sinkBefore -eq 0) -and ($sinkAfter -eq 0) -and ($fresh.Count -eq 0)) "$($corpus.cases.Count) corpus values and $($corpus.shapes.Count) bad shapes; not explicitly refused: $($unrefused -join ', '); ShellExecuteExW calls $sinkBefore -> $sinkAfter; new processes: $(Named $fresh)"
  $valid = Open-With "[$(Js $corpus.control)]"
  $sinkControl = Sink-Calls
  Check 'open-external-control-reaches-sink' (($valid.ok -eq $true) -and ($valid.r -is [bool]) -and $valid.r -and ($sinkAfter -eq 0) -and ($sinkControl -eq 1)) "answer $($valid | ConvertTo-Json -Compress); ShellExecuteExW calls $sinkAfter -> $sinkControl"

  $pilotEnginePids = @(Engine-Processes | ForEach-Object Id)
  $mailto = Open-With "[$(Js $corpus.mailto)]"
  $sinkMail = Sink-Calls
  Check 'mailto-with-embedded-url-reaches-sink' (($mailto.ok -eq $true) -and ($mailto.r -is [bool]) -and ($sinkMail -eq 2)) "answer $($mailto | ConvertTo-Json -Compress); ShellExecuteExW calls $sinkControl -> $sinkMail"

  $rnwBefore = Run-Value 'Ardia'
  $expected = '"' + "$App\chrome.exe" + '" --ardia-shell=webui'
  function Set-Login([string]$argsExpression) {
    Cdp-Eval "(() => { try { return __ardiaHost.invoke('ArdiaSystem.setLaunchAtLogin', { args: $argsExpression }).then(r => JSON.stringify({ ok: true, r }), e => JSON.stringify({ ok: false, e: String(e && e.message || e) })); } catch (e) { return JSON.stringify({ ok: false, e: 'threw ' + e.message }); } })()" | ConvertFrom-Json
  }
  function Login-Corpus([string]$state) {
    $value = Run-Value 'Ardia WebUI'
    $bad = @()
    foreach ($case in $corpus.cases) {
      if ($case.id -eq 'type.true' -or $case.id -eq 'type.false') { continue }
      $answer = Set-Login "[$($case.expression)]"
      if (-not (Refused $answer $LoginRefusals) -or (Run-Value 'Ardia WebUI') -ne $value) { $bad += $case.id; Log "setLaunchAtLogin answered $($answer | ConvertTo-Json -Compress) for $($case.id) while $state" }
    }
    foreach ($shape in @($corpus.shapes) + @([pscustomobject]@{ id = 'shape.boolNotInList'; expression = 'true' }, [pscustomobject]@{ id = 'shape.twoBooleans'; expression = '[true, false]' })) {
      $answer = Set-Login $shape.expression
      if (-not (Refused $answer $LoginRefusals) -or (Run-Value 'Ardia WebUI') -ne $value) { $bad += $shape.id; Log "setLaunchAtLogin answered $($answer | ConvertTo-Json -Compress) for $($shape.id) while $state" }
    }
    ,$bad
  }
  Remove-ItemProperty -LiteralPath $RunKey -Name 'Ardia WebUI' -ErrorAction SilentlyContinue
  $absentAtStart = $null -eq (Run-Value 'Ardia WebUI')
  $status0 = Invoke-Host 'ArdiaSystem.launchAtLoginStatus' '{ "args": [] }'
  $badAbsent = Login-Corpus 'absent'
  $on = Set-Login '[true]'
  $stored = Run-Value 'Ardia WebUI'
  $status1 = Invoke-Host 'ArdiaSystem.launchAtLoginStatus' '{ "args": [] }'
  $badPresent = Login-Corpus 'present'
  $storedAfter = Run-Value 'Ardia WebUI'
  $off = Set-Login '[false]'
  $status2 = Invoke-Host 'ArdiaSystem.launchAtLoginStatus' '{ "args": [] }'
  Check 'set-launch-at-login-refuses-shared-corpus' ($absentAtStart -and ($badAbsent.Count -eq 0) -and ($badPresent.Count -eq 0) -and ($storedAfter -eq $expected)) "not refused or changed the Run value while absent: $($badAbsent -join ', '); while present: $($badPresent -join ', ')"
  Check 'login-item-toggles-run-key' ($on.ok -and $off.ok -and $stored -eq $expected -and $status1.r -eq 'enabled' -and $status2.r -eq 'notRegistered' -and (Run-Value 'Ardia WebUI') -eq $null -and (Run-Value 'Ardia') -eq $rnwBefore) "before $($status0.r), stored '$stored', after on $($status1.r), after off $($status2.r), RNW value unchanged: $((Run-Value 'Ardia') -eq $rnwBefore)"

  function Sinks { $r = (Invoke-Host 'ArdiaShell.testOpenExternalSink' '{}').r; [pscustomobject]@{ open = $r.calls; defaults = $r.defaultBrowserCalls } }
  function Set-Default([string]$argsExpression) {
    Cdp-Eval "(() => { try { return __ardiaHost.invoke('ArdiaSystem.setAsDefaultBrowser', { args: $argsExpression }).then(r => JSON.stringify({ ok: true, r }), e => JSON.stringify({ ok: false, e: String(e && e.message || e) })); } catch (e) { return JSON.stringify({ ok: false, e: 'threw ' + e.message }); } })()" | ConvertFrom-Json
  }
  $defaultSinkBefore = Sinks
  $defaultUnrefused = @()
  foreach ($case in $corpus.cases) {
    $answer = Set-Default "[$($case.expression)]"
    if (-not (Refused $answer $DefaultRefusals)) { $defaultUnrefused += $case.id; Log "setAsDefaultBrowser answered $($answer | ConvertTo-Json -Compress) for $($case.id)" }
  }
  foreach ($shape in @($corpus.shapes | Where-Object { $_.expression -ne '[]' }) + @([pscustomobject]@{ id = 'shape.stringArgs'; expression = '"x"' }, [pscustomobject]@{ id = 'shape.objectArgs'; expression = '{ "0": 1 }' })) {
    $answer = Set-Default $shape.expression
    if (-not (Refused $answer $DefaultRefusals)) { $defaultUnrefused += $shape.id; Log "setAsDefaultBrowser answered $($answer | ConvertTo-Json -Compress) for $($shape.id)" }
  }
  $defaultSinkAfter = Sinks
  Check 'set-default-browser-refuses-shared-corpus' (($defaultUnrefused.Count -eq 0) -and ($defaultSinkBefore.defaults -eq 0) -and ($defaultSinkAfter.defaults -eq 0) -and ($null -ne $defaultSinkBefore.open) -and ($defaultSinkAfter.open -eq $defaultSinkBefore.open)) "$($corpus.cases.Count) corpus values as one-item lists and bad containers; not explicitly refused: $($defaultUnrefused -join ', '); default apps launches $($defaultSinkBefore.defaults) -> $($defaultSinkAfter.defaults); external opens $($defaultSinkBefore.open) -> $($defaultSinkAfter.open)"
  $defaultControl = Set-Default '[]'
  $defaultSinkControl = Sinks
  Check 'set-default-browser-control-reaches-sink' (($defaultControl.ok -eq $true) -and ($defaultControl.r -is [bool]) -and ($defaultSinkAfter.defaults -eq 0) -and ($defaultSinkControl.defaults -eq 1) -and ($defaultSinkControl.open -eq $defaultSinkAfter.open)) "answer $($defaultControl | ConvertTo-Json -Compress); default apps launches $($defaultSinkAfter.defaults) -> $($defaultSinkControl.defaults)"

  $isDefault = Invoke-Host 'ArdiaSystem.isDefaultBrowser' '{ "args": [] }'
  $badDefault = Invoke-Host 'ArdiaSystem.isDefaultBrowser' '{ "args": [1] }'
  Check 'default-browser-check' ($isDefault.ok -and ($isDefault.r -is [bool]) -and -not $badDefault.ok) "answer $($isDefault | ConvertTo-Json -Compress)"

  $power = Engine-Call 'engine.systemState'
  $state = if ($power.ok -and $power.r -is [string]) { $power.r | ConvertFrom-Json } else { $null }
  Check 'power-state' (($power.r -is [string]) -and $state -and $state.power -eq 'windows' -and $state.physicalMemory -gt 0 -and ($state.onBattery -is [bool])) "answer $($power | ConvertTo-Json -Compress -Depth 4)"

  $identity = Window-Identity
  Check 'bridge-answers-after-platform-calls' (Is-Window $identity) "windowIdentity $(Identity-Text $identity)"
} catch {
  $failedRun = $true
  Log "FAIL platform harness: $($_.Exception.Message)"
} finally {
  Stop-Engine
  if (-not $edgeWasRunning) { Get-Process -Name msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
  Restore-RawRun 'Ardia WebUI' $webuiRunBefore
  Get-Process -Name SystemSettings -ErrorAction SilentlyContinue | Where-Object { $settingsAtStart -notcontains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
  $mailCandidates = @(Get-Process -Name $MailApps -ErrorAction SilentlyContinue | Where-Object { $mailWasRunning -notcontains $_.Id })
  foreach ($proc in $mailCandidates) {
    $info = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" -ErrorAction SilentlyContinue
    if (($proc.StartTime -ge $runStarted) -or ($info -and (($info.CommandLine -like '*ardia-fixture.invalid*') -or ($pilotEnginePids -contains [int]$info.ParentProcessId)))) {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
  }
  $results | ConvertTo-Json -Depth 4 | Set-Content "$Proof\platform-results.json"
  if ($RunRoot) { Remove-PilotRun $RunRoot }
}
$failed = @($results.Keys | Where-Object { -not $results[$_].ok })
if ($failedRun -or $failed.Count -or $results.Count -eq 0) {
  "FAILED platform: $($failed -join ', ')"
  exit 1
}
"DONE platform"
exit 0
