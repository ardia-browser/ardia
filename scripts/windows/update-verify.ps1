param(
  [Parameter(Mandatory = $true)][ValidateSet("x64", "arm64")][string]$Cpu,
  [string]$Out = "",
  [string]$CoreDir = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$core = if ($CoreDir) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($CoreDir) } else { Join-Path $root "packages\core-rs" }
$resolvedOut = if ($Out) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out) } else { "" }
$targets = @{
  x64 = "x86_64-pc-windows-msvc"
  arm64 = "aarch64-pc-windows-msvc"
}
$target = $targets[$Cpu]

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
  if (Test-Path -LiteralPath $cargoBin) { $env:PATH = "$cargoBin;$env:PATH" }
}
foreach ($tool in @("cargo", "rustup")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "update-verify.ps1: $tool is required (https://rustup.rs)"
  }
}

Push-Location $core
try {
  & rustup target add $target | Out-Null
  $previousFlags = $env:RUSTFLAGS
  $env:RUSTFLAGS = if ($previousFlags) { "$previousFlags -C target-feature=+crt-static" } else { "-C target-feature=+crt-static" }
  try {
    & cargo build --locked --release --quiet -p ardia-update-verify --target $target
    if ($LASTEXITCODE -ne 0) { throw "cargo build ardia-update-verify failed with $LASTEXITCODE" }
  } finally {
    $env:RUSTFLAGS = $previousFlags
  }
  $targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $core "target" }
  if (-not [System.IO.Path]::IsPathRooted($targetDir)) { $targetDir = Join-Path $core $targetDir }
  $binary = Join-Path $targetDir "$target\release\ardia-update-verify.exe"
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "update-verify.ps1: cargo built no $binary" }
  if ($resolvedOut) {
    New-Item -ItemType Directory -Force -Path $resolvedOut | Out-Null
    $dest = Join-Path (Resolve-Path -LiteralPath $resolvedOut).Path "ardia-update-verify.exe"
    Copy-Item -LiteralPath $binary -Destination $dest -Force
    $binary = $dest
  }
  Write-Output $binary
} finally {
  Pop-Location
}
