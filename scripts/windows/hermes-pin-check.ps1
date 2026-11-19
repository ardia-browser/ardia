param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Hermes,
  [Parameter(Mandatory = $true)][string]$Cpu,
  [string]$Props = "apps/browser/windows/ExperimentalFeatures.props",
  [int]$GeneratorRuns = 0
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$pinned = ([xml](Get-Content -LiteralPath $Props -Raw)).Project.PropertyGroup.HermesVersion | Where-Object { $_ } | Select-Object -First 1
if (-not $pinned) { throw "$Props pins no HermesVersion" }
if ($pinned -notmatch '^0\.0\.0-(\d+)\.(\d+)-[0-9a-f]+$') { throw "'$pinned' isn't a hermes-windows nightly version" }
$fileVersion = "0.0.$($Matches[1]).$($Matches[2])"
$dll = Join-Path $App "hermes.dll"
$problems = @()

foreach ($file in @($dll, $Hermes)) {
  $found = (Get-Item -LiteralPath $file).VersionInfo.FileVersion
  if ($found -ne $fileVersion) { $problems += "$file is $found, not $fileVersion" }
}

$scratch = Join-Path ([IO.Path]::GetTempPath()) "hermes-pin-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
try {
  $package = Join-Path $scratch "hermes.zip"
  Invoke-WebRequest -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.javascript.hermes/$pinned/microsoft.javascript.hermes.$pinned.nupkg" -OutFile $package
  $archive = [IO.Compression.ZipFile]::OpenRead($package)
  try {
    foreach ($pair in @(@("build/native/win32/$Cpu/hermes.dll", $dll), @("tools/native/release/x86/hermes.exe", $Hermes))) {
      $entry = $archive.Entries | Where-Object { $_.FullName -eq $pair[0] } | Select-Object -First 1
      if (-not $entry) { $problems += "the $pinned package has no $($pair[0])"; continue }
      $copy = Join-Path $scratch ([IO.Path]::GetFileName($pair[0]))
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $copy, $true)
      $expected = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash
      $actual = (Get-FileHash -LiteralPath $pair[1] -Algorithm SHA256).Hash
      Write-Host "hermes pin: $($pair[1]) SHA-256 $actual, package $($pair[0]) $expected"
      if ($expected -ne $actual) { $problems += "$($pair[1]) differs from the package's $($pair[0])" }
    }
  } finally {
    $archive.Dispose()
  }
} finally {
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

$versionText = (& $Hermes --version 2>&1) -join "`n"
$compilerBytecode = if ($versionText -match 'HBC bytecode version:\s*(\d+)') { [int]$Matches[1] } else { $null }
$bundle = [IO.File]::OpenRead((Join-Path $App "Bundle/index.windows.bundle"))
try {
  $head = New-Object byte[] 12
  $null = $bundle.Read($head, 0, 12)
} finally {
  $bundle.Dispose()
}
$bundleBytecode = [BitConverter]::ToUInt32($head, 8)
Write-Host "hermes pin: $pinned, file version $fileVersion, compiler bytecode $compilerBytecode, bundle bytecode $bundleBytecode"
if ($null -eq $compilerBytecode) { $problems += "hermes.exe --version names no bytecode version" }
elseif ($compilerBytecode -ne $bundleBytecode) { $problems += "the bundle is bytecode $bundleBytecode, the compiler makes $compilerBytecode" }

if ($GeneratorRuns -gt 0) {
  $source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot "hermes-key-set-state.js")) + "`n" + [IO.File]::ReadAllText((Join-Path $PSScriptRoot "hermes-key-set-flow.js"))
  $work = Join-Path ([IO.Path]::GetTempPath()) "hermes-key-set-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  try {
    foreach ($keys in @(14024, 50000)) {
      $died = 0
      foreach ($run in 1..$GeneratorRuns) {
        $script = Join-Path $work "key-set.js"
        [IO.File]::WriteAllText($script, "var N = $keys; var SHAPE = ''; var VARIANT = 'add'; var LABEL = 'pin'; var COPY = '';`n" + $source)
        $output = Join-Path $work "out.txt"
        $process = Start-Process -FilePath $Hermes -ArgumentList @("-gc-init-heap=32MiB", "-gc-max-heap=1GiB", "`"$script`"") -RedirectStandardOutput $output -RedirectStandardError "$output.err" -NoNewWindow -PassThru
        $null = $process.Handle
        if (-not $process.WaitForExit(300000)) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
        $process.WaitForExit()
        $text = @(Get-Content -LiteralPath $output -ErrorAction SilentlyContinue)
        $clean = $process.ExitCode -eq 0 -and @($text | Where-Object { $_ -match ': done$' }).Count -and -not @($text | Where-Object { $_ -match 'then \d+ records, [1-9]\d* wrong-typed' }).Count
        if (-not $clean) { $died++ }
      }
      Write-Host "hermes pin: the generated sync state with one key added, $keys keys: $died of $GeneratorRuns runs died"
      if ($died) { $problems += "the generated sync state at $keys keys died in $died of $GeneratorRuns runs" }
    }
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($problems.Count) {
  $problems | ForEach-Object { Write-Host "hermes pin: $_" }
  throw "the Hermes pin doesn't hold: $($problems.Count) problem(s)"
}
Write-Host "hermes pin: holds"
