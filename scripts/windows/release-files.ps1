param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Identity,
  [Parameter(Mandatory = $true)][ValidateSet("x64", "arm64")][string]$Cpu,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = "Stop"

$setup = Join-Path $Installer "Ardia-Setup-$Cpu.exe"
if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw "'$Installer' has no Ardia-Setup-$Cpu.exe" }
if (-not (Test-Path -LiteralPath $Identity -PathType Leaf)) { throw "no build identity at '$Identity'" }
$stamped = Get-Content -LiteralPath $Identity -Raw | ConvertFrom-Json
if (-not ($stamped.version -match '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$') -or -not ($stamped.build -gt 0)) { throw "'$Identity' names no version and build" }

Copy-Item -LiteralPath $Identity -Destination (Join-Path $Installer "Ardia.build.json") -Force
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$name = "Ardia-$($stamped.version)-windows-$Cpu-setup.exe"
$target = Join-Path $Out $name
Copy-Item -LiteralPath $setup -Destination $target -Force
Copy-Item -LiteralPath $Identity -Destination (Join-Path $Out "Ardia.build.json") -Force
$hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText("$target.sha256", "$hash  $name`n", (New-Object System.Text.UTF8Encoding $false))
Write-Host "release-files: $name is Ardia $($stamped.version), build $($stamped.build), SHA-256 $hash"
