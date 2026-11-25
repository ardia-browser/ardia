. C:\pilot\lib.ps1
$ErrorActionPreference = 'Continue'
$results = New-Object System.Collections.Specialized.OrderedDictionary ([StringComparer]::Ordinal)
function Check([string]$name, [bool]$ok, [string]$detail) {
  $results[$name] = @{ ok = $ok; detail = $detail }
  Log ("{0} {1}: {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail))
}
function Listener([int]$port) { @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object OwningProcess) | Select-Object -First 1 }
Stop-Engine

$fixed = 9555
$first = New-PilotRun
$firstData = $Data
$env:ARDIA_DATA_DIR = $firstData
$env:ARDIA_REMOTE_DEBUGGING_PORT = "$fixed"
$a = Start-Process "$App\chrome.exe" -ArgumentList '--ardia-shell=webui' -PassThru
[Pilot]::Roots.Add($a.Id) | Out-Null
Wait-Until { Listener $fixed } 60 'the first run to listen' -NoThrow | Out-Null
$second = New-PilotRun
$secondData = $Data
$env:ARDIA_DATA_DIR = $secondData
$b = Start-Process "$App\chrome.exe" -ArgumentList '--ardia-shell=webui' -PassThru
[Pilot]::Roots.Add($b.Id) | Out-Null
Wait-Until { Test-Path -LiteralPath "$secondData\Chromium\Local State" } 60 'the second run to start' -NoThrow | Out-Null
$owners = @((Wait-Settled { (@(Get-NetTCPConnection -State Listen -LocalPort $fixed -ErrorAction SilentlyContinue | ForEach-Object OwningProcess | Sort-Object -Unique) -join ',') } 15 1500) -split ',' | Where-Object { $_ } | ForEach-Object { [int]$_ })
$secondHasPort = Test-Path -LiteralPath "$secondData\Chromium\DevToolsActivePort"
$firstReachesSecond = $owners -contains $b.Id
$secondReachesFirst = ($owners -contains $a.Id) -and -not $secondHasPort
$crossed = if ($firstReachesSecond -and $secondReachesFirst) { 'either run can drive the other run''s browser' } elseif ($firstReachesSecond) { 'the first run can drive the second run''s browser' } elseif ($secondReachesFirst) { 'the second run drives the first run''s browser' } else { 'no crossing seen' }
Check 'fixed-port-collision-reproduced' ($firstReachesSecond -or $secondReachesFirst) "both runs asked for port $fixed; settled listeners: $($owners -join ', '); first run's browser $($a.Id), second run's browser $($b.Id) (its own DevToolsActivePort: $secondHasPort); with a fixed port $crossed"
Stop-Engine
Remove-Item Env:ARDIA_DATA_DIR, Env:ARDIA_REMOTE_DEBUGGING_PORT -ErrorAction SilentlyContinue
Remove-PilotRun $first
Remove-PilotRun $second

$outA = Join-Path $RunsRoot 'port-run-a.json'
$outB = Join-Path $RunsRoot 'port-run-b.json'
Remove-Item -LiteralPath $outA, $outB -ErrorAction SilentlyContinue
$runA = Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\pilot\port-run.ps1', '-Out', $outA) -PassThru -WindowStyle Hidden
$runB = Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\pilot\port-run.ps1', '-Out', $outB) -PassThru -WindowStyle Hidden
$runA.WaitForExit(240000) | Out-Null
$runB.WaitForExit(240000) | Out-Null
$ra = Get-Content -LiteralPath $outA -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
$rb = Get-Content -LiteralPath $outB -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
Log "concurrent run A: $($ra | ConvertTo-Json -Compress)"
Log "concurrent run B: $($rb | ConvertTo-Json -Compress)"
$distinct = $ra.port -and $rb.port -and ($ra.port -ne $rb.port)
Check 'concurrent-runs-get-their-own-ports' ($distinct -and $ra.ready -and $rb.ready -and $ra.ownerIsThisRun -and $rb.ownerIsThisRun -and (Is-Window $ra.identity) -and (Is-Window $rb.identity)) "run A port $($ra.port) owned by its own browser $($ra.ownerIsThisRun); run B port $($rb.port) owned by its own browser $($rb.ownerIsThisRun); identities $(Identity-Text $ra.identity) and $(Identity-Text $rb.identity)"
Remove-Item -LiteralPath $outA, $outB -ErrorAction SilentlyContinue
$results | ConvertTo-Json -Depth 4 | Set-Content "$Proof\ports-results.json"
"DONE ports"
