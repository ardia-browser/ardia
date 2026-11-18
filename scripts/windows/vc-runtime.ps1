. (Join-Path $PSScriptRoot "pe-imports.ps1")

function Find-VcRedist([string]$cpu, [string]$folder) {
  if (-not $folder) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw "there is no vswhere at ${vswhere} to find the Visual C++ redist; pass -VcRedist <folder>" }
    $vs = & $vswhere -latest -products * -property installationPath
    if (-not $vs) { throw "vswhere found no Visual Studio to take the Visual C++ redist from" }
    $versionFile = Join-Path $vs "VC\Auxiliary\Build\Microsoft.VCRedistVersion.default.txt"
    if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) { throw "$vs has no ${versionFile}: its C++ tools are not installed" }
    $version = (Get-Content -LiteralPath $versionFile -TotalCount 1).Trim()
    $folder = Join-Path $vs "VC\Redist\MSVC\$version\$cpu"
  }
  if (-not (Test-Path -LiteralPath $folder -PathType Container)) { throw "the Visual C++ redist folder '$folder' is not there" }
  $found = @{}
  $parts = @(Get-ChildItem -LiteralPath $folder -Directory | Where-Object { $_.Name -match '^Microsoft\.VC[0-9]+\.(CRT|OpenMP|CXXAMP)$' })
  if (-not $parts.Count) { $parts = @(Get-Item -LiteralPath $folder) }
  foreach ($file in ($parts | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -File -Filter "*.dll" })) {
    if (Test-VcRuntimeName $file.Name) { $found[$file.Name.ToLowerInvariant()] = $file.FullName }
  }
  if (-not $found.ContainsKey("vcruntime140.dll")) { throw "the Visual C++ redist folder '$folder' has no vcruntime140.dll" }
  return [pscustomobject]@{ Folder = $folder; Files = $found }
}

function Add-VcRuntime([string]$root, [string]$cpu, [string]$folder) {
  $redist = $null
  $added = @()
  $dropped = @()
  for ($round = 0; $round -lt 8; $round++) {
    $files = @(Get-PeFiles $root)
    $unmet = @(Find-UnmetDependencies $root @() $files | Where-Object { $_.VcRuntime })
    if (-not $unmet.Count) { break }
    if (-not $redist) { $redist = Find-VcRedist $cpu $folder }
    $loaded = @{}
    foreach ($file in $files) {
      foreach ($name in @($file.Image.Imports) + @($file.Image.Delayed)) { $loaded[$name.ToLowerInvariant()] = $true }
    }
    foreach ($group in ($unmet | Group-Object Name)) {
      $source = $redist.Files[$group.Name]
      if ($source) {
        $image = Read-PeImage ([System.IO.File]::ReadAllBytes($source))
        if (-not $image -or $image.Cpu -ne $cpu) { throw "$source is not a $cpu DLL" }
        Copy-Item -LiteralPath $source -Destination (Join-Path $root ([System.IO.Path]::GetFileName($source)))
        $added += [System.IO.Path]::GetFileName($source)
        continue
      }
      $users = @($group.Group.By | Sort-Object -Unique)
      $unused = @($users | Where-Object { $_ -notmatch '[\\/]' -and $_ -match '_app\.dll$' -and -not $loaded.ContainsKey($_.ToLowerInvariant()) })
      if ($unused.Count -ne $users.Count) { throw "$($users -join ', ') need $($group.Name), which the Visual C++ redist in $($redist.Folder) doesn't have" }
      foreach ($user in $unused) {
        $path = Join-Path $root $user
        if (Test-Path -LiteralPath $path) {
          Remove-Item -LiteralPath $path
          $dropped += "$user (forwards to $($group.Name), which the redist lacks, and nothing loads it)"
        }
      }
    }
  }
  if ($round -ge 8) { throw "the Visual C++ runtime DLLs kept needing more after 8 rounds" }
  if ($added.Count) { Write-Host "assemble: the Visual C++ runtime from $($redist.Folder): $(($added | Sort-Object) -join ', ')" }
  foreach ($line in $dropped) { Write-Host "assemble: left out $line" }
}
