param([string]$Label = 'profile-edges', [int]$ChurnFolders = 20000, [int]$ChurnLaunches = 3)
. C:\pilot\lib.ps1
$ErrorActionPreference = 'Continue'
$results = New-Object System.Collections.Specialized.OrderedDictionary ([StringComparer]::Ordinal)
function Check([string]$name, [bool]$ok, [string]$detail) {
  $results[$name] = @{ ok = $ok; detail = $detail }
  Log ("{0} {1}: {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail))
}
Stop-Engine
Remove-Item Env:ARDIA_DATA_DIR, Env:ARDIA_REMOTE_DEBUGGING_PORT, Env:ARDIA_TEST_PIN_PAUSE_MS -ErrorAction SilentlyContinue
$run = New-PilotRun
$local = Join-Path $run 'local'
$roaming = Join-Path $run 'roaming'
$elsewhere = Join-Path $run 'elsewhere'
New-Item -ItemType Directory $local, $roaming, $elsewhere | Out-Null
$web = Join-Path $local 'Ardia WebUI'
Log "$Label with $App; run $run"

function Start-Pilot([string[]]$arguments) {
  $saved = @{ LOCALAPPDATA = $env:LOCALAPPDATA; APPDATA = $env:APPDATA }
  $env:LOCALAPPDATA = $local
  $env:APPDATA = $roaming
  try {
    $exe = "$App\chrome.exe"
    $id = [Pilot]::StartSuspended($exe, (Join-Arguments (@($exe) + $arguments)))
  } finally {
    $env:LOCALAPPDATA = $saved.LOCALAPPDATA
    $env:APPDATA = $saved.APPDATA
  }
  [Pilot]::Resume($id)
  $id
}
function Clear-WebUI { if (Test-Path -LiteralPath $web) { cmd /c rmdir /s /q "$web" | Out-Null } }

$policyKey = 'HKCU:\SOFTWARE\Policies\Ardia'
$existing = (Get-ItemProperty -Path $policyKey -Name UserDataDir -ErrorAction SilentlyContinue).UserDataDir
$hklm = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Ardia' -Name UserDataDir -ErrorAction SilentlyContinue).UserDataDir
if ($existing -or $hklm) {
  Check 'user-data-dir-policy-refused' $false "this account already has a UserDataDir policy ($existing$hklm); not touching it"
} else {
  $policyDir = Join-Path $elsewhere 'policy-relocated-profile'
  $keyExisted = Test-Path $policyKey
  New-Item -Path $policyKey -Force | Out-Null
  New-ItemProperty -Path $policyKey -Name UserDataDir -Value $policyDir -PropertyType String -Force | Out-Null
  Log "policy: HKCU\SOFTWARE\Policies\Ardia UserDataDir = $policyDir"
  try {
    $id = Start-Pilot @('--ardia-shell=webui')
    $code = [Pilot]::WaitExit($id, 30000)
    $window = -not (Never { [Pilot]::FindShell('Ardia') -ne [IntPtr]::Zero } 3)
    Wait-Until { (Engine-Processes).Count -eq 0 } 20 'every process of the refused launch to exit' -NoThrow | Out-Null
    $left = (Engine-Processes).Count
    Stop-Engine
    $written = @(Get-ChildItem -LiteralPath $policyDir -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring($policyDir.Length) })
    $exists = Test-Path -LiteralPath $policyDir
    Check 'user-data-dir-policy-refused' (($code -eq 1) -and -not $window -and -not $exists -and $left -eq 0) "WebUI launch with a UserDataDir policy: exit $code, window $window, policy folder exists $exists, $($written.Count) entries written there$(if ($written.Count) { ': ' + (($written | Select-Object -First 6) -join ', ') })"
  } finally {
    Remove-ItemProperty -Path $policyKey -Name UserDataDir -ErrorAction SilentlyContinue
    if (-not $keyExisted) { Remove-Item -Path $policyKey -Force -ErrorAction SilentlyContinue }
  }
  $cleared = -not (Get-ItemProperty -Path $policyKey -Name UserDataDir -ErrorAction SilentlyContinue)
  Check 'user-data-dir-policy-removed' $cleared "the test policy is gone from HKCU afterwards: $cleared"
}

Clear-WebUI
$churn = Join-Path $web 'Chromium\Default\Ardia Churn'
$opened = 0
$racing = 0
for ($launch = 1; $launch -le $ChurnLaunches; $launch++) {
  New-Item -ItemType Directory -Force $churn | Out-Null
  for ($n = 0; $n -lt $ChurnFolders; $n++) { [IO.Directory]::CreateDirectory((Join-Path $churn ('d{0:D6}' -f $n))) | Out-Null }
  $deleter = Start-Process powershell -ArgumentList @('-NoProfile', '-Command', "Get-ChildItem -LiteralPath '$churn' -Directory | Sort-Object Name -Descending | ForEach-Object { [IO.Directory]::Delete(`$_.FullName) }") -PassThru -WindowStyle Hidden
  Wait-Until { @(Get-ChildItem -LiteralPath $churn -Directory -ErrorAction SilentlyContinue).Count -lt $ChurnFolders } 30 'the cleanup to start deleting' -NoThrow | Out-Null
  $id = Start-Pilot @('--ardia-shell=webui')
  $busyAtStart = -not $deleter.HasExited
  $leftAtStart = @(Get-ChildItem -LiteralPath $churn -Directory -ErrorAction SilentlyContinue).Count
  $exit = [Pilot]::WaitExit($id, 3000)
  $h = $null
  if ($exit -eq -1) { try { $h = Wait-Shell 60 } catch {} }
  $shown = ($h -ne $null) -and ($h -ne [IntPtr]::Zero)
  if ($shown) { $opened++ }
  if ($busyAtStart) { $racing++ }
  Log ("churn launch {0}: exit {1}, window {2}; just after the engine started the cleanup was still running {3} with {4} of {5} folders left" -f $launch, $(if ($exit -eq -1) { 'none (running)' } else { $exit }), $shown, $busyAtStart, $leftAtStart, $ChurnFolders)
  Stop-Engine
  $deleter.WaitForExit(120000) | Out-Null
  Clear-WebUI
}
Check 'cleanup-during-start-still-opens' (($opened -eq $ChurnLaunches) -and ($racing -eq $ChurnLaunches)) "$opened of $ChurnLaunches launches opened the window; the cleanup of $ChurnFolders folders in the profile was still running as $racing of them started"

Remove-PilotRun $run
$results | ConvertTo-Json -Depth 4 | Set-Content "$Proof\$Label-results.json"
"DONE $Label"
