param([int]$Cycles = 12, [string]$Label = 'close')
. C:\pilot\lib.ps1
$ErrorActionPreference = 'Continue'
$results = New-Object System.Collections.Specialized.OrderedDictionary ([StringComparer]::Ordinal)
function Check([string]$name, [bool]$ok, [string]$detail) {
  $results[$name] = @{ ok = $ok; detail = $detail }
  Log ("{0} {1}: {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail))
}
Stop-Engine
$clean = 0
$withRegions = 0
$tornDown = 0
for ($i = 1; $i -le $Cycles; $i++) {
  $p = Start-Shell -Fresh
  $h = $null
  try { $h = Wait-ShellReady 60 } catch {}
  $rect = '{ "x": 220, "y": 60, "width": 900, "height": 600 }'
  $made = Cdp-Eval "__ardiaHost.invoke('tab.create', { key: 'close-$i', claim: 'close-claim', profile: 'default', url: 'file:///C:/pilot/form.html?close-$i' }).then(r => __ardiaHost.invoke('tab.viewport', { id: r.browserId, claim: 'close-claim', visible: true, rect: $rect }).then(() => 'shown'))"
  Wait-Until { @(Cdp-List | Where-Object { $_.url -like "*form.html?close-$i" }).Count -ge 1 } 15 'the page' -NoThrow | Out-Null
  $how = if ($i % 2) { 'ArdiaShell.closeWindow' } else { 'WM_CLOSE' }
  $regions = "__ardiaHost.invoke('shell.inputRegions', { pages: [$rect], overlays: [] })"
  if ($how -eq 'WM_CLOSE') {
    Cdp-Eval "$regions.then(() => 'set')" | Out-Null
    [Pilot]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  } else {
    Cdp-Eval "($regions.then(() => { window.__ardiaHost.invoke('ArdiaShell.closeWindow', {}); return 'closing'; }))" | Out-Null
  }
  $exited = $p.WaitForExit(20000)
  Wait-Until { (Engine-Processes).Count -eq 0 } 15 'every engine process to exit' -NoThrow | Out-Null
  $code = if ($exited) { '0x{0:X8}' -f $p.ExitCode } else { 'running' }
  $log = Shell-Lines
  $passActive = @($log | Where-Object { $_ -match 'input regions: 1 pages, 0 overlays, 1 pass-through rects' }).Count -ge 1
  $torn = @($log | Where-Object { $_ -match 'shell torn down while its views were alive' }).Count -ge 1
  $dumps = @(Get-ChildItem -Recurse -Force "$Data\Chromium\Crashpad" -Include *.dmp -ErrorAction SilentlyContinue).Count
  $left = (Engine-Processes).Count
  Stop-Engine
  $ok = $exited -and $p.ExitCode -eq 0 -and $dumps -eq 0 -and $passActive
  if ($ok) { $clean++ }
  if ($passActive) { $withRegions++ }
  if ($torn) { $tornDown++ }
  Check "cycle $i ($how)" $ok "page '$made', pass-through active before close $passActive, exit $code, crash dumps $dumps, teardown logged $torn, processes left $left"
  if (-not $ok) { $log | Select-Object -Last 8 | ForEach-Object { Log "log $_" } }
  Remove-PilotRun $RunRoot
}
Check "$Label-all-cycles-clean" ($clean -eq $Cycles) "$clean of $Cycles closes with pass-through regions active exited 0 with no crash dump; $withRegions had regions set; $tornDown logged the teardown"
$results | ConvertTo-Json -Depth 4 | Set-Content "$Proof\$Label-results.json"
"DONE $Label"
