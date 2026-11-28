$ErrorActionPreference = "Stop"

$failures = @()

function Check([string]$Name, $Expected, $Actual) {
  if ("$Expected" -eq "$Actual") { Write-Host "pass: $Name" } else { $script:failures += "$Name`: expected '$Expected', got '$Actual'" }
}

function Check-Throws([string]$Name, [string]$Pattern, [scriptblock]$Action) {
  try {
    & $Action | Out-Null
    $script:failures += "$Name`: nothing was thrown"
  } catch {
    if ($_.Exception.Message -match $Pattern) { Write-Host "pass: $Name" } else { $script:failures += "$Name`: threw '$($_.Exception.Message)'" }
  }
}

function ConvertFrom-BashPath([string]$path) {
  if ($path -match '^/([a-z])/(.*)$') { return "$($Matches[1].ToUpperInvariant()):\$($Matches[2].Replace('/', '\'))" }
  return $path
}

$fetch = Join-Path $PSScriptRoot "fetch-ubo.ps1"
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("ardia-fetch-ubo-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
$saved = @{ FAKE_ROOT = $env:FAKE_ROOT; FAKE_SEEN = $env:FAKE_SEEN; FAKE_EXIT = $env:FAKE_EXIT; FAKE_MANIFEST = $env:FAKE_MANIFEST }
try {
  $root = Join-Path $scratch "repo"
  $seen = Join-Path $scratch "seen"
  $fakeBin = Join-Path $scratch "fake-bin"
  New-Item -ItemType Directory -Force -Path (Join-Path $root "packages\ardiacore\scripts"), $seen, $fakeBin | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $root "packages\ardiacore\scripts\ubo.sh"), "")
  $recorder = @'
param([string]$Runner)
$file = if ($Runner -match '^/([a-z])/(.*)$') { "$($Matches[1].ToUpperInvariant()):\$($Matches[2].Replace('/', '\'))" } else { $Runner }
$shims = Split-Path -Parent $file
Get-ChildItem -LiteralPath $shims -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $env:FAKE_SEEN $_.Name) -Force }
Set-Content -LiteralPath (Join-Path $env:FAKE_SEEN 'shims-folder.txt') -Value $shims -NoNewline
if ($env:FAKE_MANIFEST -eq '1') {
  $ext = Join-Path $env:FAKE_ROOT 'packages\ardiacore\vendor\ubo\ext'
  New-Item -ItemType Directory -Force -Path $ext | Out-Null
  Set-Content -LiteralPath (Join-Path $ext 'manifest.json') -Value '{}' -NoNewline
}
exit [int]$env:FAKE_EXIT
'@
  [System.IO.File]::WriteAllText((Join-Path $fakeBin "record.ps1"), $recorder)
  $fakeBash = Join-Path $fakeBin "bash.cmd"
  [System.IO.File]::WriteAllText($fakeBash, "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0record.ps1`" %*`r`nexit /b %ERRORLEVEL%`r`n")
  $env:FAKE_ROOT = $root
  $env:FAKE_SEEN = $seen

  $env:FAKE_EXIT = "0"
  $env:FAKE_MANIFEST = "1"
  $printed = & $fetch -Bash $fakeBash -Root $root
  Check "it prints the prepared extension folder" (Join-Path $root "packages\ardiacore\vendor\ubo\ext") $printed
  Check "it makes the vendor folder ubo.sh writes into, since UBO_LOCKED skips ubo.sh's own mkdir" $true (Test-Path -LiteralPath (Join-Path $root "packages\ardiacore\vendor\ubo") -PathType Container)
  $runner = [System.IO.File]::ReadAllText((Join-Path $seen "run.sh"))
  $shims = [System.IO.File]::ReadAllText((Join-Path $seen "shims-folder.txt"))
  Check "the runner skips the lockf lock Git for Windows lacks" $true ($runner -match '(?m)^export UBO_LOCKED=1$')
  Check "the runner puts the stand-ins first on PATH" $true ($runner -match '(?m)^export PATH="([^"]+):\$PATH"$' -and (ConvertFrom-BashPath $Matches[1]) -eq $shims)
  Check "the runner runs the repository's own ubo.sh" $true ($runner -match '(?m)^exec bash "([^"]+)"$' -and (ConvertFrom-BashPath $Matches[1]) -eq (Join-Path $root "packages\ardiacore\scripts\ubo.sh"))
  $python = [System.IO.File]::ReadAllText((Join-Path $seen "python3"))
  Check "the python3 stand-in runs a real Python" $true ($python -match '(?m)^exec "([^"]+)" "\$@"$' -and (Test-Path -LiteralPath (ConvertFrom-BashPath $Matches[1]) -PathType Leaf))
  Check "the python3 stand-in sets nothing ubo.sh's python3 -I would ignore" $false ($python -cmatch '\bPYTHON[A-Z0-9_]*=')
  $shasum = [System.IO.File]::ReadAllText((Join-Path $seen "shasum"))
  Check "the shasum stand-in drops -a and runs sha256sum" $true (($shasum -match '-a\) shift 2') -and ($shasum -match '(?m)^exec sha256sum "\$@"$'))
  Check "the stand-ins are removed afterwards" $false (Test-Path -LiteralPath $shims)

  $env:FAKE_EXIT = "3"
  Check-Throws "a failing ubo.sh fails the fetch with its exit code" "ubo.sh failed with exit code 3" { & $fetch -Bash $fakeBash -Root $root }
  $env:FAKE_EXIT = "0"
  Remove-Item -LiteralPath (Join-Path $root "packages\ardiacore\vendor\ubo\ext") -Recurse -Force
  $env:FAKE_MANIFEST = "0"
  Check-Throws "a run that leaves no manifest fails the fetch" "no uBlock Origin at" { & $fetch -Bash $fakeBash -Root $root }
  Check-Throws "a missing bash is named" "needs Git for Windows' bash at" { & $fetch -Bash (Join-Path $scratch "nothing\bash.exe") -Root $root }
} finally {
  foreach ($name in $saved.Keys) {
    if ($null -eq $saved[$name]) { Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue } else { Set-Item -Path "Env:$name" -Value $saved[$name] }
  }
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count) {
  $failures | ForEach-Object { Write-Host "::error::$_" }
  exit 1
}
Write-Host "fetch-ubo.ps1 checks passed."
