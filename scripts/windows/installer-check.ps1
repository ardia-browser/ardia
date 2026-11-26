param(
  [Parameter(Mandatory = $true)][string]$Setup
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "shell-layout.ps1")

$entry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{47A92F18-32B0-4548-A1EF-72C217FE1836}_is1"
$folder = Join-Path $env:LOCALAPPDATA "Programs\Ardia"
$shortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Ardia.lnk"
$appUserModelId = "Ardia.Browser"
$progId = "HKCU:\Software\Classes\ArdiaHTM"
$client = "HKCU:\Software\Clients\StartMenuInternet\Ardia"
$capabilities = "Software\Clients\StartMenuInternet\Ardia\Capabilities"
$registered = "HKCU:\Software\RegisteredApplications"
$fileTypes = @(".htm", ".html", ".shtml", ".svg", ".webp", ".xht", ".xhtml")
$loginItems = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$loginApprovals = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
$unrelatedLoginItem = "Ardia installer-check unrelated"

function Default-Value([string]$key) {
  $item = Get-Item -LiteralPath $key -ErrorAction SilentlyContinue
  if ($item) { return $item.GetValue("") }
  return $null
}

function Browser-Leftovers {
  $left = @()
  if (Test-Path -LiteralPath $progId) { $left += "the ProgID ArdiaHTM" }
  if (Test-Path -LiteralPath $client) { $left += "StartMenuInternet\Ardia" }
  if ($null -ne (Get-ItemProperty -LiteralPath $registered -ErrorAction SilentlyContinue).Ardia) { $left += "RegisteredApplications\Ardia" }
  foreach ($type in $fileTypes) {
    $list = Get-Item -LiteralPath "HKCU:\Software\Classes\$type\OpenWithProgids" -ErrorAction SilentlyContinue
    if ($list -and ($list.GetValueNames() -contains "ArdiaHTM")) { $left += "$type OpenWithProgids ArdiaHTM" }
  }
  return ,$left
}

function Read-RegistryValue([string]$key, [string]$name) {
  $item = Get-Item -LiteralPath $key -ErrorAction SilentlyContinue
  if (-not $item -or -not ($item.GetValueNames() -contains $name)) { return $null }
  return @{ Kind = $item.GetValueKind($name); Data = $item.GetValue($name, $null, "DoNotExpandEnvironmentNames") }
}

function Write-RegistryValue([string]$key, [string]$name, $kind, $data) {
  if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -LiteralPath $key -Name $name -PropertyType $kind -Value $data -Force | Out-Null
}

function Restore-RegistryValue([string]$key, [string]$name, $saved) {
  if ($null -eq $saved) { Remove-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue; return }
  Write-RegistryValue $key $name $saved.Kind $saved.Data
}

function Invoke-Quietly([string]$program, [string]$what) {
  $run = Start-Process -FilePath $program -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait -PassThru
  if ($run.ExitCode -ne 0) { throw "$what exited with $($run.ExitCode)" }
}

if (-not (Test-Path -LiteralPath $Setup -PathType Leaf)) { throw "'$Setup' does not exist" }
if ((Test-Path -LiteralPath $entry) -or (Test-Path -LiteralPath $folder)) { throw "Ardia is already installed for this user: this check installs and removes it, so it only runs where it is not" }
$before = Browser-Leftovers
if ($before.Count) { throw "Ardia's browser registration is already here before the install: $($before -join ', ')" }

$seededExe = Join-Path $folder "Ardia.exe"
$loginSeed = @{ Retired = "Ardia"; RetiredCommand = "`"$seededExe`""; Item = "Ardia WebUI" }
$loginSeed.ExtraName = "Ardia installer-check extra arguments"
$loginSeed.ExtraCommand = "`"$seededExe`" --start-maximized"
$loginSeed.UnrelatedCommand = "`"$(Join-Path $env:WINDIR "System32\notepad.exe")`" --ardia-shell=rnw"
$loginSeed.Approval = [byte[]](3, 0, 0, 0, 16, 32, 48, 64, 80, 96, 112, 128)
$loginSeed.OrphanApproval = [byte[]](2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
$loginSeed.Runs = @($loginSeed.Retired, $loginSeed.Item, $loginSeed.ExtraName, $unrelatedLoginItem)
$loginSeed.Approvals = @($loginSeed.Retired, $loginSeed.Item)
$loginSeed.SavedRuns = @{}
foreach ($name in $loginSeed.Runs) { $loginSeed.SavedRuns[$name] = Read-RegistryValue $loginItems $name }
$loginSeed.SavedApprovals = @{}
foreach ($name in $loginSeed.Approvals) { $loginSeed.SavedApprovals[$name] = Read-RegistryValue $loginApprovals $name }

$installedByCheck = $false
try {
  if ($loginSeed) {
    Remove-ItemProperty -LiteralPath $loginItems -Name $loginSeed.Item -ErrorAction SilentlyContinue
    Write-RegistryValue $loginApprovals $loginSeed.Item Binary $loginSeed.OrphanApproval
    Write-RegistryValue $loginItems $loginSeed.Retired String $loginSeed.RetiredCommand
    Write-RegistryValue $loginItems $loginSeed.ExtraName String $loginSeed.ExtraCommand
    Write-RegistryValue $loginItems $unrelatedLoginItem String $loginSeed.UnrelatedCommand
    Write-RegistryValue $loginApprovals $loginSeed.Retired Binary $loginSeed.Approval
  }
  Invoke-Quietly (Resolve-Path -LiteralPath $Setup).Path "the installer"
  $installedByCheck = $true
  $shellKind = Resolve-ShellLayout $folder "webui"
  $shipped = Get-ShellInstalledFiles $shellKind
  $missing = @($shipped | Where-Object { -not (Test-Path -LiteralPath (Join-Path $folder $_) -PathType Leaf) })
  if ($missing.Count) { throw "the install in $folder lacks $($missing -join ', ')" }
  if (Get-ChildItem -LiteralPath $folder -Recurse -File -Force -Filter "Ardia.test-build" | Select-Object -First 1) { throw "the install in $folder carries an Ardia.test-build marker: a build people install must ignore test keys" }
  $layoutProblems = Get-ShellLayoutProblems $folder $shellKind
  if ($layoutProblems.Count) { throw "the $shellKind install in $folder is wrong: $($layoutProblems -join '; ')" }
  if (-not (Test-Path -LiteralPath $shortcut -PathType Leaf)) { throw "no Start Menu shortcut at $shortcut" }
  $installed = Get-ItemProperty -LiteralPath $entry
  if ($installed.DisplayName -ne "Ardia") { throw "the uninstall entry is named '$($installed.DisplayName)'" }
  $displayIcon = ($installed.DisplayIcon -split ",")[0].Trim('"')
  if (-not $displayIcon -or -not (Test-Path -LiteralPath $displayIcon -PathType Leaf)) { throw "the uninstall entry's icon '$($installed.DisplayIcon)' is not a file" }
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
  $linkIcon = ($link.IconLocation -split ",")[0]
  if (-not $linkIcon -or -not (Test-Path -LiteralPath $linkIcon -PathType Leaf)) { throw "the Start Menu shortcut's icon '$($link.IconLocation)' is not a file" }
  $linkId = (New-Object -ComObject Shell.Application).NameSpace((Split-Path -Parent $shortcut)).ParseName((Split-Path -Leaf $shortcut)).ExtendedProperty("System.AppUserModel.ID")
  if ($linkId -ne $appUserModelId) { throw "the Start Menu shortcut's AppUserModelID is '$linkId', not ${appUserModelId}: the taskbar would not group the app's windows with it" }
  $launchSwitch = Get-ShellLaunchSwitch $shellKind
  $installedLauncher = Join-Path $folder "Ardia.exe"
  if (-not $link.TargetPath -or -not (Test-Path -LiteralPath $link.TargetPath -PathType Leaf) -or (Get-FileHash -LiteralPath $link.TargetPath).Hash -ne (Get-FileHash -LiteralPath $installedLauncher).Hash) { throw "the Start Menu shortcut opens '$($link.TargetPath)', not the installed Ardia.exe" }
  if ($link.Arguments -ne $launchSwitch) { throw "the Start Menu shortcut passes '$($link.Arguments)', not '$launchSwitch' for the $shellKind shell" }
  & (Join-Path $PSScriptRoot "launcher-identity.ps1") -Icon $displayIcon -To (Join-Path $folder "Ardia.exe") -Check
  if ($LASTEXITCODE -ne 0) { throw "the installed Ardia.exe does not carry Ardia's icon and name" }
  Write-Host "installer-check: the $shellKind shell's shortcut has Ardia's icon, AppUserModelID $linkId and arguments '$($link.Arguments)', the uninstall entry's icon is $displayIcon"
  $exe = Join-Path $folder "Ardia.exe"
  $command = Default-Value "$progId\shell\open\command"
  if ($command -ne (Get-ShellDocumentCommand $exe $shellKind)) { throw "the ProgID's open command is '$command', not '$(Get-ShellDocumentCommand $exe $shellKind)'" }
  if ((Default-Value "$progId\DefaultIcon") -ne "$exe,0") { throw "the ProgID's icon is '$(Default-Value "$progId\DefaultIcon")'" }
  if ((Get-ItemProperty -LiteralPath "$progId\Application").ApplicationName -ne "Ardia") { throw "the ProgID's application name is not Ardia" }
  if ((Get-ItemProperty -LiteralPath $registered).Ardia -ne $capabilities) { throw "RegisteredApplications\Ardia is '$((Get-ItemProperty -LiteralPath $registered).Ardia)', not $capabilities" }
  $caps = Get-ItemProperty -LiteralPath "HKCU:\$capabilities"
  if ($caps.ApplicationName -ne "Ardia" -or $caps.ApplicationIcon -ne "$exe,0") { throw "the Capabilities name or icon is wrong: '$($caps.ApplicationName)', '$($caps.ApplicationIcon)'" }
  foreach ($scheme in "http", "https") {
    $handler = (Get-ItemProperty -LiteralPath "HKCU:\$capabilities\URLAssociations").$scheme
    if ($handler -ne "ArdiaHTM") { throw "URLAssociations\$scheme is '$handler', not ArdiaHTM" }
  }
  foreach ($type in $fileTypes) {
    $handler = (Get-ItemProperty -LiteralPath "HKCU:\$capabilities\FileAssociations").$type
    if ($handler -ne "ArdiaHTM") { throw "FileAssociations\$type is '$handler', not ArdiaHTM" }
    if (-not ((Get-Item -LiteralPath "HKCU:\Software\Classes\$type\OpenWithProgids").GetValueNames() -contains "ArdiaHTM")) { throw "$type does not offer ArdiaHTM in Open with" }
  }
  if ((Get-ItemProperty -LiteralPath "HKCU:\$capabilities\StartMenu").StartMenuInternet -ne "Ardia") { throw "Capabilities\StartMenu does not name StartMenuInternet\Ardia" }
  if ((Default-Value "$client\shell\open\command") -ne (Get-ShellOpenCommand $exe $shellKind)) { throw "StartMenuInternet\Ardia's open command is '$(Default-Value "$client\shell\open\command")'" }
  Write-Host "installer-check: Ardia is registered as a browser: ArdiaHTM opens $command, for http, https and $($fileTypes -join ' ')"
  if ($loginSeed) {
    $expectedLogin = Get-ShellOpenCommand $exe $shellKind
    if ($null -ne (Read-RegistryValue $loginItems $loginSeed.Retired)) { throw "the install left the $($loginSeed.Retired) login item of the shell it replaced" }
    $item = (Read-RegistryValue $loginItems $loginSeed.Item).Data
    if ($item -ne $expectedLogin) { throw "the $($loginSeed.Item) login item is '$item' after the install, not '$expectedLogin' for the $shellKind shell" }
    $approval = Read-RegistryValue $loginApprovals $loginSeed.Item
    if (-not $approval -or $approval.Kind -ne [Microsoft.Win32.RegistryValueKind]::Binary -or (($approval.Data | ForEach-Object { $_ }) -join ",") -ne ($loginSeed.Approval -join ",")) { throw "StartupApproved\Run\$($loginSeed.Item) does not carry the disabled approval of $($loginSeed.Retired) over the enabled one an earlier Open at Login left behind" }
    if ($null -ne (Read-RegistryValue $loginApprovals $loginSeed.Retired)) { throw "the install left StartupApproved\Run\$($loginSeed.Retired)" }
    $extra = (Read-RegistryValue $loginItems $loginSeed.ExtraName).Data
    if ($extra -ne $loginSeed.ExtraCommand) { throw "a login item with its own arguments became '$extra'" }
    $unrelated = (Read-RegistryValue $loginItems $unrelatedLoginItem).Data
    if ($unrelated -ne $loginSeed.UnrelatedCommand) { throw "an unrelated login item became '$unrelated'" }
    Write-Host "installer-check: the $($loginSeed.Retired) login item moved to $($loginSeed.Item), opening $expectedLogin with its StartupApproved state; the other login items are untouched"
  }
  $count = @(Get-ChildItem -LiteralPath $folder -Recurse -File).Count
  Write-Host "installer-check: installed Ardia $($installed.DisplayVersion), $count files in $folder"

  Invoke-Quietly (Join-Path $folder "unins000.exe") "the uninstaller"
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and ((Test-Path -LiteralPath $folder) -or (Test-Path -LiteralPath $entry))) { Start-Sleep -Milliseconds 500 }
  if (Test-Path -LiteralPath $folder) { throw "the uninstaller left $(@(Get-ChildItem -LiteralPath $folder -Recurse -File).Count) files in $folder" }
  if (Test-Path -LiteralPath $entry) { throw "the uninstaller left its uninstall entry" }
  if (Test-Path -LiteralPath $shortcut) { throw "the uninstaller left the Start Menu shortcut" }
  $after = Browser-Leftovers
  if ($after.Count) { throw "the uninstaller left Ardia's browser registration: $($after -join ', ')" }
  $installedByCheck = $false
  Write-Host "installer-check: uninstalled, nothing left in $folder"
} finally {
  $uninstaller = Join-Path $folder "unins000.exe"
  if ($installedByCheck -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    try { Invoke-Quietly $uninstaller "the uninstaller" } catch { Write-Warning "installer-check: cleaning up after a failed check, the uninstaller failed: $($_.Exception.Message)" }
  }
  if ($loginSeed) {
    foreach ($name in $loginSeed.Runs) { Restore-RegistryValue $loginItems $name $loginSeed.SavedRuns[$name] }
    foreach ($name in $loginSeed.Approvals) { Restore-RegistryValue $loginApprovals $name $loginSeed.SavedApprovals[$name] }
  }
}
