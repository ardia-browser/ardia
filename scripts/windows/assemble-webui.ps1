param(
  [Parameter(Mandatory = $true)][string]$Engine,
  [Parameter(Mandatory = $true)][string]$Ui,
  [Parameter(Mandatory = $true)][string]$Out,
  [switch]$TestBuild
)

$ErrorActionPreference = "Stop"

$engineLauncher = "chrome.exe"
$engineNotes = "RUN.txt"
$uiFolder = "ardia-ui"
$testMarker = "Ardia.test-build"

function Resolve-Folder([string]$path, [string]$what, [string]$marker) {
  if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "$what '$path' is not a folder" }
  $resolved = (Resolve-Path -LiteralPath $path).Path
  if (-not (Test-Path -LiteralPath (Join-Path $resolved $marker) -PathType Leaf)) { throw "$what '$path' has no $marker" }
  return $resolved
}

$engineRoot = Resolve-Folder $Engine "The engine" $engineLauncher
$uiRoot = Resolve-Folder $Ui "The desktop UI build (apps/desktop/dist/linux)" "index.html"
if (Test-Path -LiteralPath (Join-Path $engineRoot "ArdiaApp.dll")) { throw "The engine '$Engine' holds the React Native app; the WebUI shell is assembled from a bare engine" }
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
if ($TestBuild) { New-Item -ItemType File -Path (Join-Path $outRoot $testMarker) -Force | Out-Null }

$uiFiles = @(Get-ChildItem -LiteralPath (Join-Path $outRoot $uiFolder) -Recurse -File).Count
Write-Output "WebUI shell assembled in $outRoot ($uiFiles UI files in $uiFolder); start it with: $engineLauncher --ardia-shell=webui"
