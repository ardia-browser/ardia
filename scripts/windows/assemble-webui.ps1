param(
  [Parameter(Mandatory = $true)][string]$Engine,
  [string]$Ui = "apps/desktop/dist/win",
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$MigrateBin,
  [string]$UpdateVerify,
  [switch]$TestBuild,
  [switch]$Shippable,
  [string]$LauncherName = "",
  [string]$Version = "",
  [int]$Build = 0,
  [string]$VcRedist = "",
  [string]$AppIcon = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "shell-layout.ps1")

$engineLauncher = $ShellLayout.EngineLauncher
$engineNotes = "RUN.txt"
$uiFolder = $ShellLayout.UiFolder
$migratorName = $ShellLayout.Migrator
$verifierName = $ShellLayout.UpdateVerifier
$keyName = $ShellLayout.UpdateKey
$pinnedKey = Join-Path $PSScriptRoot $keyName
$testMarker = $ShellLayout.TestMarker
$repository = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Resolve-Folder([string]$path, [string]$what, [string]$marker) {
  if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "$what '$path' is not a folder" }
  $resolved = (Resolve-Path -LiteralPath $path).Path
  if (-not (Test-Path -LiteralPath (Join-Path $resolved $marker) -PathType Leaf)) { throw "$what '$path' has no $marker" }
  return $resolved
}

if (-not $LauncherName) { $LauncherName = if ($Shippable) { $ShellLayout.Launcher } else { $engineLauncher } }
if ($LauncherName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.exe$') { throw "-LauncherName '$LauncherName' is not a plain .exe name" }
if ($Shippable -and $LauncherName -ine $ShellLayout.Launcher) { throw "a shippable WebUI build starts from $($ShellLayout.Launcher), not ${LauncherName}: the installer, shortcuts and file associations name it" }
$renamed = $LauncherName -ine $engineLauncher
$branded = $Shippable -or ($LauncherName -ieq $ShellLayout.Launcher) -or [bool]$AppIcon
if (-not $AppIcon) { $AppIcon = Join-Path $repository "apps\browser\windows\Ardia\Ardia.ico" }

$engineRoot = Resolve-Folder $Engine "The engine" $engineLauncher
$uiRoot = Resolve-Folder $Ui "The desktop UI build (apps/desktop/dist/win)" "index.html"
if (Test-Path -LiteralPath (Join-Path $engineRoot $ShellLayout.RnwLibrary)) { throw "The engine '$Engine' holds the React Native app; the WebUI shell is assembled from a bare engine" }
if ($Shippable -and $TestBuild) { throw "a shippable WebUI build never carries ${testMarker}: assemble it without -TestBuild, and mark a copy for tests" }
if ($Shippable -and $Build -le 0) { throw "a shippable WebUI build needs -Build above 0, so it carries Ardia.build.json for updates and the installer" }
if ($Shippable -and (Find-TestMarkers $engineRoot).Count) { throw "the engine '$Engine' carries $testMarker; a shippable WebUI build is assembled from an engine without one" }
if ($Shippable -and -not $MigrateBin) { throw "a shippable WebUI build needs -MigrateBin: without $migratorName an upgrade from the React Native shell would open empty" }
if ($Shippable -and -not $UpdateVerify) { throw "a shippable WebUI build needs -UpdateVerify: without $verifierName and $keyName beside $($ShellLayout.Launcher) it never updates itself" }
if ($branded -and -not (Test-Path -LiteralPath $AppIcon -PathType Leaf)) { throw "the app icon '$AppIcon' is not a file" }
$migrateSource = $null
if ($PSBoundParameters.ContainsKey('MigrateBin') -or $MigrateBin) {
  if ([string]::IsNullOrWhiteSpace($MigrateBin) -or -not (Test-Path -LiteralPath $MigrateBin -PathType Leaf)) {
    throw "The migration binary '$MigrateBin' was not found"
  }
  $migrateSource = (Resolve-Path -LiteralPath $MigrateBin).Path
}
$verifierSource = $null
if ($PSBoundParameters.ContainsKey('UpdateVerify') -or $UpdateVerify) {
  if ([string]::IsNullOrWhiteSpace($UpdateVerify) -or -not (Test-Path -LiteralPath $UpdateVerify -PathType Leaf)) {
    throw "The update verifier '$UpdateVerify' was not found"
  }
  if (-not (Test-Path -LiteralPath $pinnedKey -PathType Leaf)) { throw "the pinned update key $pinnedKey is missing" }
  $verifierSource = (Resolve-Path -LiteralPath $UpdateVerify).Path
}
if (Test-Path -LiteralPath $Out) {
  if (Get-ChildItem -LiteralPath $Out -Force | Select-Object -First 1) { throw "'$Out' is not empty" }
} else {
  New-Item -ItemType Directory -Path $Out -Force | Out-Null
}
$outRoot = (Resolve-Path -LiteralPath $Out).Path

Get-ChildItem -LiteralPath $engineRoot -Force | Where-Object { $_.Name -ine $engineNotes -and $_.Name -ine $testMarker } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $outRoot -Recurse
}
if (-not $TestBuild) {
  foreach ($marker in (Find-TestMarkers $outRoot)) { Remove-Item -LiteralPath $marker -Force }
}
Copy-Item -LiteralPath $uiRoot -Destination (Join-Path $outRoot $uiFolder) -Recurse
if ($migrateSource) {
  Copy-Item -LiteralPath $migrateSource -Destination (Join-Path $outRoot $migratorName) -Force
}
if ($verifierSource) {
  Copy-Item -LiteralPath $verifierSource -Destination (Join-Path $outRoot $verifierName) -Force
  Copy-Item -LiteralPath $pinnedKey -Destination (Join-Path $outRoot $keyName) -Force
}

$launcherPath = Join-Path $outRoot $LauncherName
if ($renamed) {
  Move-Item -LiteralPath (Join-Path $outRoot $engineLauncher) -Destination $launcherPath
}
if ($branded) {
  & (Join-Path $PSScriptRoot "launcher-identity.ps1") -Icon $AppIcon -To $launcherPath
  if ($LASTEXITCODE -ne 0) { throw "$LauncherName did not get Ardia's icon and name" }
}
if ($Shippable -or $VcRedist) {
  . (Join-Path $PSScriptRoot "vc-runtime.ps1")
  $launcherImage = Read-PeImage ([System.IO.File]::ReadAllBytes($launcherPath))
  if (-not $launcherImage -or @("x64", "arm64") -notcontains $launcherImage.Cpu) { throw "$LauncherName is not an x64 or ARM64 program" }
  if ($migrateSource) {
    $migratorImage = Read-PeImage ([System.IO.File]::ReadAllBytes((Join-Path $outRoot $migratorName)))
    if (-not $migratorImage -or $migratorImage.Cpu -ne $launcherImage.Cpu) { throw "$migratorName is not a $($launcherImage.Cpu) program like $LauncherName" }
  }
  if ($verifierSource) {
    $verifierImage = Read-PeImage ([System.IO.File]::ReadAllBytes((Join-Path $outRoot $verifierName)))
    if (-not $verifierImage -or $verifierImage.Cpu -ne $launcherImage.Cpu) { throw "$verifierName is not a $($launcherImage.Cpu) program like $LauncherName" }
  }
  Add-VcRuntime $outRoot $launcherImage.Cpu $VcRedist
}
if ($Build -gt 0) {
  if (-not $Version) { $Version = & (Join-Path $PSScriptRoot "project-version.ps1") }
  $identity = [ordered]@{ version = $Version; build = $Build; shell = "webui" } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText((Join-Path $outRoot "Ardia.build.json"), $identity, (New-Object System.Text.UTF8Encoding $false))
  Write-Output "assemble-webui: this is Ardia $Version, build $Build"
}
if ($TestBuild) { New-Item -ItemType File -Path (Join-Path $outRoot $testMarker) -Force | Out-Null }

if ($Shippable) {
  $problems = Get-ShellLayoutProblems $outRoot "webui"
  if ($problems.Count) { throw "the assembled WebUI build in $outRoot is not shippable: $($problems -join '; ')" }
} elseif (-not $TestBuild -and (Find-TestMarkers $outRoot).Count) {
  throw "the assembled WebUI build in $outRoot carries a $testMarker marker without -TestBuild"
}

$uiFiles = @(Get-ChildItem -LiteralPath (Join-Path $outRoot $uiFolder) -Recurse -File).Count
$migratorNote = if ($migrateSource) { ", bundled $migratorName" } else { "" }
if ($verifierSource) { $migratorNote += ", bundled $verifierName and $keyName" }
$kind = if ($Shippable) { "shippable " } else { "" }
Write-Output "WebUI shell assembled ${kind}in $outRoot ($uiFiles UI files in $uiFolder$migratorNote); start it with: $LauncherName $($ShellLayout.WebUISwitch)"
