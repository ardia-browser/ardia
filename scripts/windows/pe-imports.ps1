$script:PeMachines = @{ 0x014c = "x86"; 0x8664 = "x64"; 0xaa64 = "arm64" }
$script:PeExtensions = @(".dll", ".exe", ".node", ".cpl", ".drv", ".ocx")
$script:VcRuntimePattern = '^(vcruntime|msvcp|concrt|vccorlib|vcomp|vcamp|ucrtbased|mfc|vcpkgsrv)[0-9a-z_]*\.dll$'

function Test-VcRuntimeName([string]$Name) {
  return $Name.ToLowerInvariant() -match $script:VcRuntimePattern
}

function Test-ApiSetName([string]$Name) {
  $lower = $Name.ToLowerInvariant()
  return $lower.StartsWith("api-ms-win-") -or $lower.StartsWith("ext-ms-")
}

function Read-PeImage([byte[]]$Bytes) {
  if ($Bytes.Length -lt 0x40 -or $Bytes[0] -ne 0x4d -or $Bytes[1] -ne 0x5a) { return $null }
  $header = [BitConverter]::ToInt32($Bytes, 0x3c)
  if ($header -lt 0 -or $header + 24 -gt $Bytes.Length) { return $null }
  if ([BitConverter]::ToUInt32($Bytes, $header) -ne 0x00004550) { return $null }
  $machine = [BitConverter]::ToUInt16($Bytes, $header + 4)
  $sectionCount = [BitConverter]::ToUInt16($Bytes, $header + 6)
  $optionalSize = [BitConverter]::ToUInt16($Bytes, $header + 20)
  $optional = $header + 24
  $magic = [BitConverter]::ToUInt16($Bytes, $optional)
  switch ($magic) {
    0x10b { $imageBase = [uint64][BitConverter]::ToUInt32($Bytes, $optional + 28); $directories = $optional + 96 }
    0x20b { $imageBase = [BitConverter]::ToUInt64($Bytes, $optional + 24); $directories = $optional + 112 }
    default { throw "PE optional header magic 0x$('{0:x}' -f $magic) is neither PE32 nor PE32+" }
  }
  $directoryCount = [BitConverter]::ToUInt32($Bytes, $directories - 4)

  $sections = @()
  $sectionTable = $optional + $optionalSize
  for ($i = 0; $i -lt $sectionCount; $i++) {
    $entry = $sectionTable + 40 * $i
    $virtualSize = [BitConverter]::ToUInt32($Bytes, $entry + 8)
    $rawSize = [BitConverter]::ToUInt32($Bytes, $entry + 16)
    $sections += [pscustomobject]@{
      Address = [BitConverter]::ToUInt32($Bytes, $entry + 12)
      Size = [Math]::Max($virtualSize, $rawSize)
      Raw = [BitConverter]::ToUInt32($Bytes, $entry + 20)
    }
  }

  $toOffset = {
    param([uint64]$rva)
    foreach ($section in $sections) {
      if ($rva -ge $section.Address -and $rva -lt $section.Address + $section.Size) {
        $offset = $rva - $section.Address + $section.Raw
        if ($offset -lt $Bytes.Length) { return [int64]$offset }
      }
    }
    throw "RVA 0x$('{0:x}' -f $rva) is in no section"
  }
  $readName = {
    param([uint64]$rva)
    $start = & $toOffset $rva
    $end = [Array]::IndexOf($Bytes, [byte]0, [int]$start)
    if ($end -lt 0) { throw "the name at RVA 0x$('{0:x}' -f $rva) has no end" }
    return [System.Text.Encoding]::ASCII.GetString($Bytes, [int]$start, [int]($end - $start))
  }
  $directory = {
    param([int]$index)
    if ($index -ge $directoryCount) { return @(0, 0) }
    return @([BitConverter]::ToUInt32($Bytes, $directories + 8 * $index), [BitConverter]::ToUInt32($Bytes, $directories + 8 * $index + 4))
  }

  $imports = [System.Collections.Generic.List[string]]::new()
  $importTable = & $directory 1
  if ($importTable[0]) {
    $entry = & $toOffset $importTable[0]
    while ($true) {
      $name = [BitConverter]::ToUInt32($Bytes, [int]$entry + 12)
      if ($name -eq 0) { break }
      $imports.Add((& $readName $name))
      $entry += 20
    }
  }

  $delayed = [System.Collections.Generic.List[string]]::new()
  $delayTable = & $directory 13
  if ($delayTable[0]) {
    $entry = & $toOffset $delayTable[0]
    while ($true) {
      $attributes = [BitConverter]::ToUInt32($Bytes, [int]$entry)
      $name = [uint64][BitConverter]::ToUInt32($Bytes, [int]$entry + 4)
      if ($name -eq 0) { break }
      if (($attributes -band 1) -eq 0) { $name -= $imageBase }
      $delayed.Add((& $readName $name))
      $entry += 32
    }
  }

  $forwarded = [System.Collections.Generic.List[string]]::new()
  $exportTable = & $directory 0
  if ($exportTable[0]) {
    $exports = & $toOffset $exportTable[0]
    $functionCount = [BitConverter]::ToUInt32($Bytes, [int]$exports + 20)
    $functions = & $toOffset ([BitConverter]::ToUInt32($Bytes, [int]$exports + 28))
    $seen = @{}
    for ($i = 0; $i -lt $functionCount; $i++) {
      $address = [BitConverter]::ToUInt32($Bytes, [int]($functions + 4 * $i))
      if ($address -lt $exportTable[0] -or $address -ge $exportTable[0] + $exportTable[1]) { continue }
      $forward = & $readName $address
      $dot = $forward.LastIndexOf('.')
      if ($dot -le 0) { continue }
      $module = $forward.Substring(0, $dot)
      if (-not $module.ToLowerInvariant().EndsWith(".dll")) { $module += ".dll" }
      if ($seen.ContainsKey($module.ToLowerInvariant())) { continue }
      $seen[$module.ToLowerInvariant()] = $true
      $forwarded.Add($module)
    }
  }

  $cpu = $script:PeMachines[[int]$machine]
  if (-not $cpu) { $cpu = "0x$('{0:x4}' -f $machine)" }
  return [pscustomobject]@{ Cpu = $cpu; Imports = @($imports); Delayed = @($delayed); Forwarded = @($forwarded) }
}

function Get-PeFiles([string]$Root) {
  $Root = (Resolve-Path -LiteralPath $Root).Path
  $prefix = $Root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  foreach ($file in Get-ChildItem -LiteralPath $Root -Recurse -File -Force) {
    if ($script:PeExtensions -notcontains $file.Extension.ToLowerInvariant()) { continue }
    $image = Read-PeImage ([System.IO.File]::ReadAllBytes($file.FullName))
    if (-not $image) { continue }
    [pscustomobject]@{
      Path = $file.FullName
      Relative = $file.FullName.Substring($prefix.Length)
      Folder = $file.DirectoryName
      Image = $image
    }
  }
}

function Find-UnmetDependencies([string]$Root, [string[]]$System, [object[]]$Files = $null) {
  $root = (Resolve-Path -LiteralPath $Root).Path
  $badSystem = @($System | Where-Object { (Test-VcRuntimeName $_) -or (Test-ApiSetName $_) })
  if ($badSystem.Count) { throw "these can never count as part of Windows: $($badSystem -join ', ')" }
  $windowsNames = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $System) { [void]$windowsNames.Add($name) }
  if ($null -eq $Files) { $Files = @(Get-PeFiles $root) }
  $byFolder = @{}
  $present = {
    param([string]$folder, [string]$name)
    if (-not $byFolder.ContainsKey($folder)) {
      $names = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
      foreach ($file in Get-ChildItem -LiteralPath $folder -File -Force) { [void]$names.Add($file.Name) }
      $byFolder[$folder] = $names
    }
    return $byFolder[$folder].Contains($name)
  }
  foreach ($file in $Files) {
    $needs = @()
    $needs += $file.Image.Imports | ForEach-Object { [pscustomobject]@{ Name = $_; Kind = "import" } }
    $needs += $file.Image.Delayed | ForEach-Object { [pscustomobject]@{ Name = $_; Kind = "delay-load" } }
    $needs += $file.Image.Forwarded | ForEach-Object { [pscustomobject]@{ Name = $_; Kind = "forwarded export" } }
    foreach ($need in $needs) {
      if (Test-ApiSetName $need.Name) { continue }
      if ((& $present $root $need.Name) -or (& $present $file.Folder $need.Name)) { continue }
      if ($windowsNames.Contains($need.Name)) { continue }
      [pscustomobject]@{ Name = $need.Name.ToLowerInvariant(); Kind = $need.Kind; By = $file.Relative; VcRuntime = (Test-VcRuntimeName $need.Name) }
    }
  }
}
