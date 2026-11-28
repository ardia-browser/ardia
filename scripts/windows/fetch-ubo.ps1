param(
  [string]$Bash = (Join-Path $env:ProgramFiles "Git\bin\bash.exe"),
  [string]$Root = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = "Stop"
$uboScript = Join-Path $Root "packages\ardiacore\scripts\ubo.sh"
$vendor = Join-Path $Root "packages\ardiacore\vendor\ubo"
$extension = Join-Path $vendor "ext"
if (-not (Test-Path -LiteralPath $Bash -PathType Leaf)) { throw "fetch-ubo.ps1 needs Git for Windows' bash at $Bash" }

function Find-Python {
  $candidates = @(@("py", "-3"), @("python"), @("python3"))
  foreach ($candidate in $candidates) {
    $command = Get-Command $candidate[0] -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { continue }
    $arguments = @($candidate | Select-Object -Skip 1) + @("-c", "import sys; print(sys.executable)")
    try {
      $found = @(& $command.Source @arguments 2>$null)[0]
    } catch {
      continue
    }
    if ($LASTEXITCODE -eq 0 -and $found -and (Test-Path -LiteralPath $found -PathType Leaf)) { return $found }
  }
  throw "fetch-ubo.ps1 needs Python 3: install it from python.org or with winget install Python.Python.3.12"
}

function ConvertTo-BashPath([string]$path) {
  $full = [System.IO.Path]::GetFullPath($path)
  "/" + $full.Substring(0, 1).ToLowerInvariant() + $full.Substring(2).Replace('\', '/')
}

$python = Find-Python
New-Item -ItemType Directory -Force -Path $vendor | Out-Null
$shims = Join-Path ([System.IO.Path]::GetTempPath()) ("ardia-fetch-ubo-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $shims | Out-Null
try {
  $utf8 = New-Object System.Text.UTF8Encoding $false
  $pythonShim = "#!/usr/bin/env bash`nexec `"$(ConvertTo-BashPath $python)`" `"`$@`"`n"
  $shasumShim = "#!/usr/bin/env bash`nset -euo pipefail`nwhile [ `$# -gt 0 ]; do`n  case `"`$1`" in`n    -a) shift 2 ;;`n    *) break ;;`n  esac`ndone`nexec sha256sum `"`$@`"`n"
  $runner = "#!/usr/bin/env bash`nset -euo pipefail`nexport PATH=`"$(ConvertTo-BashPath $shims):`$PATH`"`nexport UBO_LOCKED=1`nexec bash `"$(ConvertTo-BashPath $uboScript)`"`n"
  [System.IO.File]::WriteAllText((Join-Path $shims "python3"), $pythonShim, $utf8)
  [System.IO.File]::WriteAllText((Join-Path $shims "shasum"), $shasumShim, $utf8)
  [System.IO.File]::WriteAllText((Join-Path $shims "run.sh"), $runner, $utf8)
  & $Bash (ConvertTo-BashPath (Join-Path $shims "run.sh")) | ForEach-Object { [Console]::Error.WriteLine($_) }
  if ($LASTEXITCODE -ne 0) { throw "ubo.sh failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item -LiteralPath $shims -Recurse -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path -LiteralPath (Join-Path $extension "manifest.json") -PathType Leaf)) { throw "fetch-ubo.ps1: no uBlock Origin at $extension" }
Write-Output $extension
