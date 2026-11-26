$ErrorActionPreference = "Stop"

$failures = @()

function Check([string]$Name, $Expected, $Actual) {
  if ("$Expected" -eq "$Actual") { Write-Host "pass: $Name" } else { $script:failures += "$Name`: expected '$Expected', got '$Actual'" }
}

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("ardia-update-verify-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
$savedPath = $env:PATH
$savedTargetDir = $env:CARGO_TARGET_DIR
try {
  $caller = Join-Path $scratch "caller"
  $fakeCore = Join-Path $scratch "fake-core"
  $fakeBin = Join-Path $scratch "fake-bin"
  $fakeTarget = Join-Path $fakeCore "target\x86_64-pc-windows-msvc\release"
  New-Item -ItemType Directory -Force -Path $caller, $fakeCore, $fakeBin, $fakeTarget | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $fakeBin "rustup.cmd"), "@echo off`r`nexit /b 0`r`n")
  [System.IO.File]::WriteAllText((Join-Path $fakeBin "cargo.cmd"), "@echo off`r`nexit /b 0`r`n")
  [System.IO.File]::WriteAllBytes((Join-Path $fakeTarget "ardia-update-verify.exe"), [byte[]](0x4d, 0x5a, 0x90, 0x00))

  $env:PATH = "$fakeBin;$savedPath"
  Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue

  Push-Location $caller
  try {
    $relativeOut = "ArdiaWebUI\update-verify"
    $copied = & (Join-Path $PSScriptRoot "update-verify.ps1") -Cpu x64 -Out $relativeOut -CoreDir $fakeCore
    $expected = Join-Path $caller "$relativeOut\ardia-update-verify.exe"
    $wrong = Join-Path $fakeCore "$relativeOut\ardia-update-verify.exe"
    Check "relative -Out returns the caller-relative destination" $expected $copied
    Check "relative -Out copies ardia-update-verify.exe under the caller directory" $true (Test-Path -LiteralPath $expected -PathType Leaf)
    Check "relative -Out does not write under packages/core-rs" $false (Test-Path -LiteralPath $wrong -PathType Leaf)
  } finally {
    Pop-Location
  }

} finally {
  $env:PATH = $savedPath
  if ($null -eq $savedTargetDir) { Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue } else { $env:CARGO_TARGET_DIR = $savedTargetDir }
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count) {
  $failures | ForEach-Object { Write-Host "::error::$_" }
  exit 1
}
Write-Host "update-verify.ps1 path checks passed."
