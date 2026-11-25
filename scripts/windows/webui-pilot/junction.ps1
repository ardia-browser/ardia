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
New-Item -ItemType Directory $local, $roaming, $elsewhere, "$elsewhere\unrelated" | Out-Null
$rn = Join-Path $local 'Ardia'
$web = Join-Path $local 'Ardia WebUI'
$realLocal = [Environment]::GetFolderPath('LocalApplicationData')
$realBefore = @(Get-ChildItem -Force $realLocal -ErrorAction SilentlyContinue | ForEach-Object Name) -join '|'
Log "run $run; LOCALAPPDATA and APPDATA for every launch point inside it"

function Clear-WebUI {
  $item = Get-Item -LiteralPath $web -Force -ErrorAction SilentlyContinue
  if (-not $item) { return }
  if ($item.PSIsContainer) { cmd /c rmdir /s /q "$web" | Out-Null } else { Remove-Item -LiteralPath $web -Force }
}
function Link([string]$kind, [string]$link, [string]$target) {
  $flag = @{ junction = '/J'; symlink = '/D'; file = '' }[$kind]
  if ($flag) { cmd /c mklink $flag "$link" "$target" | Out-Null } else { cmd /c mklink "$link" "$target" | Out-Null }
  $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
  Log "fixture: $kind $link -> $($item.Target) ($($item.LinkType))"
  [bool]($item -and $item.LinkType)
}
function Snapshot { (Get-ChildItem -Recurse -Force $rn, $elsewhere -ErrorAction SilentlyContinue | ForEach-Object { if ($_.PSIsContainer) { $_.FullName } else { $_.FullName + ':' + $_.Length + ':' + $_.LastWriteTimeUtc.Ticks } }) -join "`n" }
function Start-Pilot([string[]]$arguments, [string]$dataDir = '', [string]$pause = '') {
  $saved = @{ LOCALAPPDATA = $env:LOCALAPPDATA; APPDATA = $env:APPDATA }
  $env:LOCALAPPDATA = $local
  $env:APPDATA = $roaming
  if ($dataDir) { $env:ARDIA_DATA_DIR = $dataDir }
  if ($pause) { $env:ARDIA_TEST_PIN_PAUSE_MS = $pause }
  try {
    $exe = "$App\chrome.exe"
    $id = [Pilot]::StartSuspended($exe, (Join-Arguments (@($exe) + $arguments)))
  } finally {
    $env:LOCALAPPDATA = $saved.LOCALAPPDATA
    $env:APPDATA = $saved.APPDATA
    Remove-Item Env:ARDIA_DATA_DIR, Env:ARDIA_TEST_PIN_PAUSE_MS -ErrorAction SilentlyContinue
  }
  $seen = (Get-CimInstance Win32_Process -Filter "ProcessId=$id").CommandLine
  $argv = @([Pilot]::Argv($seen) | Select-Object -Skip 1)
  $same = ($argv.Count -eq $arguments.Count) -and -not (Compare-Object $argv $arguments -SyncWindow 0 -CaseSensitive)
  Log "launched $id with $seen; argv matches: $same"
  [Pilot]::Resume($id)
  [pscustomobject]@{ Id = $id; ArgvOk = $same; CommandLine = $seen }
}
function Refused([string]$name, [string[]]$arguments, [string]$dataDir = '') {
  $before = Snapshot
  $p = Start-Pilot $arguments $dataDir
  $code = [Pilot]::WaitExit($p.Id, 20000)
  $window = -not (Never { [Pilot]::FindShell('Ardia') -ne [IntPtr]::Zero } 2)
  Wait-Until { (Engine-Processes).Count -eq 0 } 10 'the refused launch to leave no process' -NoThrow | Out-Null
  $now = Snapshot
  $unchanged = $now -eq $before
  if (-not $unchanged) { Compare-Object ($before -split "`n") ($now -split "`n") | ForEach-Object { Log "changed $($_.SideIndicator) $($_.InputObject)" } }
  $left = (Engine-Processes).Count
  Stop-Engine
  Check $name ($p.ArgvOk -and $code -eq 1 -and -not $window -and $unchanged -and $left -eq 0) "$($p.CommandLine)$(if ($dataDir) { " with ARDIA_DATA_DIR=$dataDir" }): argv as intended $($p.ArgvOk), exit $code, window $window, React Native folders unchanged $unchanged"
}
function Opens([string]$name, [string[]]$arguments) {
  $before = Snapshot
  $p = Start-Pilot $arguments
  $h = $null
  try { $h = Wait-Shell 60 } catch {}
  Wait-Until { Test-Path -LiteralPath (Join-Path $web 'Chromium\Local State') } 30 'the WebUI profile to be written' -NoThrow | Out-Null
  $pinned = $false
  if ($h) {
    try { Rename-Item -LiteralPath $web -NewName 'Ardia WebUI moved' -ErrorAction Stop } catch { $pinned = $true }
    if (-not $pinned) { Rename-Item -LiteralPath (Join-Path $local 'Ardia WebUI moved') -NewName 'Ardia WebUI' }
  }
  $unchanged = (Snapshot) -eq $before
  $inWebUI = Test-Path -LiteralPath (Join-Path $web 'Chromium\Local State')
  Stop-Engine
  $opened = ($h -ne $null) -and ($h -ne [IntPtr]::Zero)
  Check $name ($p.ArgvOk -and $opened -and $unchanged -and $inWebUI -and $pinned) "$($p.CommandLine): argv as intended $($p.ArgvOk), window $opened, profile in Ardia WebUI\Chromium $inWebUI, folder pinned against rename $pinned, React Native folders unchanged $unchanged"
}
function Try-Rename([string]$path) {
  $leaf = Split-Path -Leaf $path
  try {
    Rename-Item -LiteralPath $path -NewName "$leaf moved" -ErrorAction Stop
    Rename-Item -LiteralPath (Join-Path (Split-Path -Parent $path) "$leaf moved") -NewName $leaf
    'renamed'
  } catch { 'refused' }
}

$rnDefault = "$rn\User Data\Default"
New-Item -ItemType Directory -Force "$rnDefault\Local Storage\leveldb", "$rnDefault\Network" | Out-Null
Set-Content "$rnDefault\Preferences" '{"react native profile":true}'
Set-Content "$rnDefault\Local Storage\leveldb\000001.log" 'react native storage'
Set-Content "$rnDefault\Network\Cookies" 'react native cookies'
Set-Content "$rn\User Data\Local State" '{"react native local state":true}'
Set-Content "$rn\session.json" '{"react native session":true}'
$fixture = Snapshot

$folder = Join-Path $elsewhere 'handle-probe'
New-Item -ItemType Directory $folder | Out-Null
foreach ($probe in @(@{ name = 'no access'; access = 0 }, @{ name = 'FILE_LIST_DIRECTORY | SYNCHRONIZE'; access = 0x100001 })) {
  $h = [Pilot]::OpenFolder($folder, [uint32]$probe.access)
  $outcome = Try-Rename $folder
  [Pilot]::CloseFolder($h)
  $results["handle-semantics $($probe.name)"] = @{ ok = $true; detail = "a folder held open with $($probe.name), share read and write but not delete: rename $outcome" }
  Log "handle semantics: held with $($probe.name), share read|write: rename $outcome"
}
$zeroAccess = $results['handle-semantics no access'].detail -match 'rename renamed'
$realAccess = $results['handle-semantics FILE_LIST_DIRECTORY | SYNCHRONIZE'].detail -match 'rename refused'
Check 'handle-with-real-access-blocks-rename' ($realAccess) "zero-access handle lets the rename through: $zeroAccess; FILE_LIST_DIRECTORY | SYNCHRONIZE handle refuses it: $realAccess"
Remove-Item -LiteralPath $folder -Force

Link junction $web $rn | Out-Null
Refused 'junction-app-data-to-react-native' @('--ardia-shell=webui')
foreach ($variant in @('--ARDIA-SHELL=webui', '-ardia-shell=webui', '/ardia-shell=webui', '--Ardia-Shell=webui', ' --ardia-shell=webui ', '--SINGLE-ARGUMENT --ardia-shell=webui')) {
  Refused "switch-spelling '$variant' with the junction" @($variant -split '(?<=\S) (?=--)')
}
Clear-WebUI

New-Item -ItemType Directory $web | Out-Null
Link junction (Join-Path $web 'Chromium') "$rn\User Data" | Out-Null
Refused 'junction-profile-to-react-native' @('--ardia-shell=webui')
Clear-WebUI

$own = @(
  @{ name = 'junction at depth 1 to the React Native profile'; kind = 'junction'; link = 'Chromium\Default'; target = $rnDefault },
  @{ name = 'directory symlink at depth 1 to the React Native profile'; kind = 'symlink'; link = 'Chromium\Default'; target = $rnDefault },
  @{ name = 'junction at depth 3 to React Native storage'; kind = 'junction'; link = 'Chromium\Default\Local Storage\leveldb'; target = "$rnDefault\Local Storage\leveldb" },
  @{ name = 'directory symlink at depth 3 to React Native storage'; kind = 'symlink'; link = 'Chromium\Default\Local Storage\leveldb'; target = "$rnDefault\Local Storage\leveldb" },
  @{ name = 'junction at depth 2 to an unrelated folder'; kind = 'junction'; link = 'Chromium\Default\Network'; target = "$elsewhere\unrelated" },
  @{ name = 'file symlink to the React Native Local State'; kind = 'file'; link = 'Chromium\Local State'; target = "$rn\User Data\Local State" },
  @{ name = 'junction in the app-data folder beside Chromium'; kind = 'junction'; link = 'Sessions'; target = $rn }
)
foreach ($case in $own) {
  $path = Join-Path $web $case.link
  New-Item -ItemType Directory -Force (Split-Path -Parent $path) | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $web 'Chromium') | Out-Null
  if (Link $case.kind $path $case.target) {
    Refused "own-tree link: $($case.name)" @('--ardia-shell=webui')
  } else {
    Check "own-tree link: $($case.name)" $false "the $($case.kind) fixture at $path could not be made"
  }
  Clear-WebUI
}

Refused 'user-data-dir-into-react-native' @('--ardia-shell=webui', "--user-data-dir=$rn\User Data")
Refused 'user-data-dir-spelled-long-path' @('--ardia-shell=webui', "--user-data-dir=\\?\$rn\User Data")
$short = (cmd /c "for %I in (""$rn\User Data"") do @echo %~sI").Trim()
Log "8.3 spelling of the React Native profile: $short"
if ($short -and $short -ne "$rn\User Data") {
  Refused 'user-data-dir-spelled-8.3' @('--ardia-shell=webui', "--user-data-dir=$short")
} else {
  Check 'user-data-dir-spelled-8.3' $false "no 8.3 name was generated for $rn\User Data"
}
$unc = '\\localhost\' + $rn.Substring(0, 1) + '$' + $rn.Substring(2) + '\User Data'
if (Test-Path -LiteralPath $unc) {
  Refused 'user-data-dir-spelled-unc' @('--ardia-shell=webui', "--user-data-dir=$unc")
} else {
  Check 'user-data-dir-spelled-unc' $false "$unc is not reachable"
}
Refused 'ardia-data-dir-at-react-native' @('--ardia-shell=webui') $rn

Set-Content -LiteralPath $web 'not a folder'
Log "fixture: $web is a file, so the WebUI profile can't be created"
Refused 'uncreatable-webui-folder' @('--ardia-shell=webui')
Clear-WebUI

$before = Snapshot
$p = Start-Pilot @('--ardia-shell=webui') '' '15000'
Wait-Until { Test-Path -LiteralPath (Join-Path $web 'Chromium') } 10 'install_static to create and pin the profile folder' -NoThrow | Out-Null
$early = @(Engine-Processes)
$modules = @((Get-Process -Id $p.Id -ErrorAction SilentlyContinue).Modules | ForEach-Object ModuleName)
$chromeDll = $modules -contains 'chrome.dll'
$profileRename = Try-Rename (Join-Path $web 'Chromium')
$parentRename = Try-Rename $web
$h = $null
try { $h = Wait-Shell 60 } catch {}
$opened = ($h -ne $null) -and ($h -ne [IntPtr]::Zero)
Stop-Engine
Check 'pin-alone-blocks-rename' ($p.ArgvOk -and $early.Count -eq 1 -and -not $chromeDll -and $profileRename -eq 'refused' -and $parentRename -eq 'refused' -and $opened -and ((Snapshot) -eq $before)) "paused right after the pin: $($early.Count) engine process, chrome.dll loaded $chromeDll; renaming Ardia WebUI\Chromium $profileRename, renaming Ardia WebUI $parentRename; window after the pause $opened"
Clear-WebUI

Rename-Item -LiteralPath "$rn\User Data" -NewName 'User Data moved'
Move-Item -LiteralPath "$rn\User Data moved" -Destination (Join-Path $elsewhere 'profile')
Link junction "$rn\User Data" (Join-Path $elsewhere 'profile') | Out-Null
New-Item -ItemType Directory $web | Out-Null
Link junction (Join-Path $web 'Chromium') (Join-Path $elsewhere 'profile') | Out-Null
Refused 'relocated-react-native-profile' @('--ardia-shell=webui')
Clear-WebUI

Opens 'control-starts-in-webui-folder' @('--ardia-shell=webui')
Clear-WebUI
Opens 'control-switch-spelling-uppercase' @('--ARDIA-SHELL=webui')
Clear-WebUI
Opens 'control-switch-spelling-single-dash' @('-ardia-shell=webui')
Shot "$Proof\junction-control.png"
Clear-WebUI
Opens 'control-user-data-dir-with-a-space' @('--ardia-shell=webui', "--user-data-dir=$web\Chromium")
Clear-WebUI

cmd /c rmdir "$rn\User Data" | Out-Null
Move-Item -LiteralPath (Join-Path $elsewhere 'profile') -Destination "$rn\User Data"
Check 'react-native-fixture-intact' ((Snapshot) -eq $fixture) "every React Native fixture file has the size and time it was written with"
$realAfter = @(Get-ChildItem -Force $realLocal -ErrorAction SilentlyContinue | ForEach-Object Name) -join '|'
Check 'account-folders-untouched' ($realAfter -eq $realBefore) "the account's own LOCALAPPDATA lists the same entries before and after"
Remove-PilotRun $run
Check 'run-folder-removed-by-marker' (-not (Test-Path -LiteralPath $run)) "$run removed after its .pilot-run marker matched"
$results | ConvertTo-Json -Depth 4 | Set-Content "$Proof\junction-results.json"
"DONE junction"
