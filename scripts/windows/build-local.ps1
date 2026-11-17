param(
  [ValidateSet("x64", "ARM64")][string]$Cpu = "x64",
  [string]$LogDirectory = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$app = Join-Path $root "apps/browser"
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) { throw "Install Visual Studio Build Tools with the C++ desktop workload." }
$component = if ($Cpu -eq "ARM64") { "Microsoft.VisualStudio.Component.VC.Tools.ARM64" } else { "Microsoft.VisualStudio.Component.VC.Tools.x86.x64" }
$vs = & $vswhere -latest -products '*' -version '[17.0,19.0)' -requires Microsoft.Component.MSBuild $component -property installationPath
if (-not $vs) { throw "No complete Visual Studio installation with MSBuild and $component was found." }
$msbuild = Join-Path $vs "MSBuild/Current/Bin/amd64/MSBuild.exe"
if (-not (Test-Path -LiteralPath $msbuild)) { throw "No x64 MSBuild at $msbuild" }
if (-not $LogDirectory) { $LogDirectory = Join-Path $app "build-windows-logs" }
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
$logs = (Resolve-Path -LiteralPath $LogDirectory).Path
$cli = Join-Path $root "node_modules/@react-native-community/cli/build/bin.js"
if (-not (Test-Path -LiteralPath $cli)) { throw "Run pnpm install --frozen-lockfile first." }
Push-Location $app
try {
  & node $cli autolink-windows --sln windows/Ardia.sln --proj windows/Ardia/Ardia.vcxproj --no-telemetry
  if ($LASTEXITCODE) { throw "Windows autolinking failed ($LASTEXITCODE)." }
  & $msbuild windows/Ardia.sln /nologo /restore /p:RestorePackagesConfig=true /p:Configuration=Release "/p:Platform=$Cpu" /p:AppxBundle=Never /p:RunAutolinkCheck=false /p:PreferredToolArchitecture=x64 "/bl:$logs/build-$Cpu.binlog" "/flp:logfile=$logs/build-$Cpu.log;verbosity=normal" /verbosity:minimal
  if ($LASTEXITCODE) { throw "Native Windows build failed ($LASTEXITCODE). See $logs." }
  $library = Join-Path $app "windows/$Cpu/Release/ArdiaApp.dll"
  if (-not (Test-Path -LiteralPath $library)) { throw "MSBuild succeeded but $library is missing." }
  Write-Host "Built $library. Assemble it with the pinned Chromium engine before packaging."
} finally {
  Pop-Location
}
