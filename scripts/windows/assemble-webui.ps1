param(
  [Parameter(Mandatory = $true)][string]$Engine,
  [string]$Ui = "apps/desktop/dist/win",
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$MigrateBin,
  [switch]$TestBuild
)

$ErrorActionPreference = "Stop"

$engineLauncher = "chrome.exe"
$engineNotes = "RUN.txt"
$uiFolder = "ardia-ui"
$migratorName = "ardia-webui-migrate.exe"
$testMarker = "Ardia.test-build"

function Resolve-Folder([string]$path, [string]$what, [string]$marker) {
  if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "$what '$path' is not a folder" }
  $resolved = (Resolve-Path -LiteralPath $path).Path
  if (-not (Test-Path -LiteralPath (Join-Path $resolved $marker) -PathType Leaf)) { throw "$what '$path' has no $marker" }
  return $resolved
}

$engineRoot = Resolve-Folder $Engine "The engine" $engineLauncher
$uiRoot = Resolve-Folder $Ui "The desktop UI build (apps/desktop/dist/win)" "index.html"
if (Test-Path -LiteralPath (Join-Path $engineRoot "ArdiaApp.dll")) { throw "The engine '$Engine' holds the React Native app; the WebUI shell is assembled from a bare engine" }
$migrateSource = $null
if ($PSBoundParameters.ContainsKey('MigrateBin') -or $MigrateBin) {
  if ([string]::IsNullOrWhiteSpace($MigrateBin) -or -not (Test-Path -LiteralPath $MigrateBin -PathType Leaf)) {
    throw "The migration binary '$MigrateBin' was not found"
  }
  $migrateSource = (Resolve-Path -LiteralPath $MigrateBin).Path
}
if (Test-Path -LiteralPath $Out) {
  if (Get-ChildItem -LiteralPath $Out -Force | Select-Object -First 1) { throw "'$Out' is not empty" }
} else {
  New-Item -ItemType Directory -Path $Out -Force | Out-Null
}
$outRoot = (Resolve-Path -LiteralPath $Out).Path

Get-ChildItem -LiteralPath $engineRoot -Force | Where-Object { $_.Name -ine $engineNotes } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $outRoot -Recurse
}
Copy-Item -LiteralPath $uiRoot -Destination (Join-Path $outRoot $uiFolder) -Recurse
if ($migrateSource) {
  Copy-Item -LiteralPath $migrateSource -Destination (Join-Path $outRoot $migratorName) -Force
}
if ($TestBuild) { New-Item -ItemType File -Path (Join-Path $outRoot $testMarker) -Force | Out-Null }

$uiFiles = @(Get-ChildItem -LiteralPath (Join-Path $outRoot $uiFolder) -Recurse -File).Count
$migratorNote = if ($migrateSource) { ", bundled $migratorName" } else { "" }
Write-Output "WebUI shell assembled in $outRoot ($uiFiles UI files in $uiFolder$migratorNote); start it with: $engineLauncher --ardia-shell=webui"
