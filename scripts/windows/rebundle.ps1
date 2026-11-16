param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Hermes,
  [Parameter(Mandatory = $true)][string]$Javascript,
  [switch]$Verify
)

$ErrorActionPreference = "Stop"

$library = "ArdiaApp.dll"
$bundleName = "index.windows.bundle"
$hermesMagic = [byte[]](0xC6, 0x1F, 0xBC, 0x03, 0xC1, 0x03, 0x19, 0x1F)

if (-not (Test-Path -LiteralPath (Join-Path $App $library) -PathType Leaf)) { throw "the built app '$App' has no $library" }
if (-not (Test-Path -LiteralPath $Hermes -PathType Leaf)) { throw "no Hermes compiler at '$Hermes'" }
$bundled = Join-Path $Javascript "Bundle"
if (-not (Test-Path -LiteralPath (Join-Path $bundled $bundleName) -PathType Leaf)) { throw "'$Javascript' holds no Bundle\$bundleName from Metro" }
$appRoot = (Resolve-Path -LiteralPath $App).Path
$compiler = (Resolve-Path -LiteralPath $Hermes).Path
$shipped = Join-Path $appRoot "Bundle"
$shippedMaps = Join-Path $appRoot "sourcemaps\react"

function Test-HermesBytecode([string]$path) {
  $stream = [System.IO.File]::OpenRead($path)
  try {
    $head = New-Object byte[] $hermesMagic.Length
    if ($stream.Read($head, 0, $head.Length) -ne $head.Length) { return $false }
    return -not (Compare-Object $head $hermesMagic -SyncWindow 0)
  } finally {
    $stream.Dispose()
  }
}

function Get-Digests([string]$folder) {
  $root = (Resolve-Path -LiteralPath $folder).Path
  $digests = @{}
  foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File) {
    $digests[$file.FullName.Substring($root.Length + 1)] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  return $digests
}

$scratch = Join-Path (Split-Path -Parent $appRoot) ("rebundle-" + [guid]::NewGuid().ToString("N"))
$fresh = Join-Path $scratch "Bundle"
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
  Copy-Item -LiteralPath $bundled -Destination $fresh -Recurse
  $javascript = Join-Path $fresh $bundleName
  $bytecode = "$javascript.hbc"
  & $compiler -emit-binary -out $bytecode $javascript -O -output-source-map
  if ($LASTEXITCODE -ne 0) { throw "Hermes did not compile $bundleName" }
  if (-not (Test-HermesBytecode $bytecode)) { throw "$bytecode is not Hermes bytecode" }
  Remove-Item -LiteralPath "$bytecode.map" -Force
  Move-Item -LiteralPath $bytecode -Destination $javascript -Force
  $made = Get-Digests $fresh
  $megabytes = [math]::Round((Get-Item -LiteralPath $javascript).Length / 1MB, 1)
  $summary = "$bundleName ($megabytes MB of Hermes bytecode, SHA-256 $($made[$bundleName])) and $($made.Count - 1) assets"

  if ($Verify) {
    $built = Get-Digests $shipped
    $names = @(@($built.Keys) + @($made.Keys) | Sort-Object -Unique)
    $differences = @()
    foreach ($name in $names) {
      if (-not $made.ContainsKey($name)) { $differences += "$name is in the build's bundle and not in the one bundled on Linux" }
      elseif (-not $built.ContainsKey($name)) { $differences += "$name is in the bundle from Linux and not in the build's" }
      elseif ($built[$name] -ne $made[$name]) { $differences += "$name differs: the build has $($built[$name]), Linux gives $($made[$name])" }
    }
    if ($differences.Count) {
      $differences | ForEach-Object { Write-Host $_ }
      throw "the JavaScript bundled on Linux is not what the build bundled: $($differences.Count) of $($names.Count) files differ"
    }
    Write-Host "rebundle: bundled on Linux and compiled here, $summary match the build's file for file"
    return
  }

  foreach ($stale in @($shipped, $shippedMaps)) {
    if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Recurse -Force }
  }
  Move-Item -LiteralPath $fresh -Destination $shipped
  Write-Host "rebundle: $summary are in $shipped"
} finally {
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
