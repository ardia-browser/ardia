$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "vc-runtime.ps1")

$failures = @()
$machines = @{ x86 = 0x014c; x64 = 0x8664; arm64 = 0xaa64 }

function New-PeBytes {
  param([string]$Cpu = "x64", [string[]]$Imports = @(), [string[]]$Delayed = @(), [string[]]$Forwards = @(), [int]$Exports = 0, [switch]$Pe32, [switch]$OldDelay)
  $bytes = New-Object byte[] 0x3000
  $u16 = { param([int]$at, [int]$value) [BitConverter]::GetBytes([uint16]$value).CopyTo($bytes, $at) }
  $u32 = { param([int]$at, [uint32]$value) [BitConverter]::GetBytes([uint32]$value).CopyTo($bytes, $at) }
  $u64 = { param([int]$at, [uint64]$value) [BitConverter]::GetBytes([uint64]$value).CopyTo($bytes, $at) }
  $raw = 0x200
  $base = 0x1000
  $imageBase = if ($Pe32) { [uint64]0x400000 } else { [uint64]0x180000000 }
  $bytes[0] = 0x4d; $bytes[1] = 0x5a
  & $u32 0x3c 0x40
  & $u32 0x40 0x00004550
  & $u16 0x44 $machines[$Cpu]
  & $u16 0x46 1
  $optionalSize = if ($Pe32) { 224 } else { 240 }
  & $u16 0x54 $optionalSize
  $optional = 0x58
  if ($Pe32) {
    & $u16 $optional 0x10b
    & $u32 ($optional + 28) ([uint32]$imageBase)
    & $u32 ($optional + 92) 16
    $directories = $optional + 96
  } else {
    & $u16 $optional 0x20b
    & $u64 ($optional + 24) $imageBase
    & $u32 ($optional + 108) 16
    $directories = $optional + 112
  }
  $place = { param([int]$size) $at = $script:cursorBox.Value; $script:cursorBox.Value += $size; return $at }
  $script:cursorBox = [ref]0
  $string = {
    param([string]$text)
    $at = & $place ($text.Length + 1)
    [System.Text.Encoding]::ASCII.GetBytes($text).CopyTo($bytes, $raw + $at)
    return $at
  }
  $importTable = & $place (20 * ($Imports.Count + 1))
  $delayTable = & $place (32 * ($Delayed.Count + 1))
  for ($i = 0; $i -lt $Imports.Count; $i++) {
    $name = & $string $Imports[$i]
    & $u32 ($raw + $importTable + 20 * $i + 12) ($base + $name)
  }
  for ($i = 0; $i -lt $Delayed.Count; $i++) {
    $name = & $string $Delayed[$i]
    if ($OldDelay) {
      & $u32 ($raw + $delayTable + 32 * $i + 4) ([uint32]($imageBase + $base + $name))
    } else {
      & $u32 ($raw + $delayTable + 32 * $i) 1
      & $u32 ($raw + $delayTable + 32 * $i + 4) ($base + $name)
    }
  }
  if ($Imports.Count) { & $u32 ($directories + 8) ($base + $importTable); & $u32 ($directories + 12) (20 * ($Imports.Count + 1)) }
  if ($Delayed.Count) { & $u32 ($directories + 104) ($base + $delayTable); & $u32 ($directories + 108) (32 * ($Delayed.Count + 1)) }
  $functionCount = $Forwards.Count + $Exports
  if ($functionCount) {
    $exportDirectory = & $place 40
    $functions = & $place (4 * $functionCount)
    & $u32 ($raw + $exportDirectory + 20) $functionCount
    & $u32 ($raw + $exportDirectory + 28) ($base + $functions)
    for ($i = 0; $i -lt $Forwards.Count; $i++) {
      $text = & $string $Forwards[$i]
      & $u32 ($raw + $functions + 4 * $i) ($base + $text)
    }
    for ($i = 0; $i -lt $Exports; $i++) { & $u32 ($raw + $functions + 4 * ($Forwards.Count + $i)) 0x2000 }
    & $u32 $directories ($base + $exportDirectory)
    & $u32 ($directories + 4) ($script:cursorBox.Value - $exportDirectory)
  }
  $section = $optional + $optionalSize
  & $u32 ($section + 8) 0x2000
  & $u32 ($section + 12) $base
  & $u32 ($section + 16) 0x2000
  & $u32 ($section + 20) $raw
  return $bytes
}

function Check([string]$Name, $Expected, $Actual) {
  $want = @($Expected) -join "|"
  $got = @($Actual) -join "|"
  if ($want -ceq $got) { Write-Host "pass: $Name" } else { $script:failures += "$Name`: expected '$want', got '$got'" }
}

function Check-Throws([string]$Name, [string]$Pattern, [scriptblock]$Action) {
  try {
    & $Action | Out-Null
    $script:failures += "$Name`: nothing was thrown"
  } catch {
    if ($_.Exception.Message -match $Pattern) { Write-Host "pass: $Name" } else { $script:failures += "$Name`: threw '$($_.Exception.Message)'" }
  }
}

function Write-Pe([string]$Path, [byte[]]$Bytes) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllBytes($Path, $Bytes)
}

$image = Read-PeImage (New-PeBytes -Imports "KERNEL32.dll", "vcruntime140_app.dll" -Delayed "USER32.dll" -Forwards "VCRUNTIME140.memcpy", "VCRUNTIME140.memset", "NTDLL.RtlAllocateHeap", "api-ms-win-core-synch-l1-2-0.WaitOnAddress", "MSVCP140.#12" -Exports 2)
Check "a PE32+ image is read as x64" "x64" $image.Cpu
Check "imports are read in order" @("KERNEL32.dll", "vcruntime140_app.dll") $image.Imports
Check "delay-load imports are read" @("USER32.dll") $image.Delayed
Check "forwarded exports name each target DLL once, with .dll added" @("VCRUNTIME140.dll", "NTDLL.dll", "api-ms-win-core-synch-l1-2-0.dll", "MSVCP140.dll") $image.Forwarded

$old = Read-PeImage (New-PeBytes -Cpu x86 -Pe32 -OldDelay -Delayed "WINMM.dll")
Check "a PE32 image is read as x86" "x86" $old.Cpu
Check "an old delay-load descriptor holds an address, not an RVA" @("WINMM.dll") $old.Delayed
Check "an image with no tables has no imports" 0 @($old.Imports).Count

Check "an ARM64 image is read as arm64" "arm64" (Read-PeImage (New-PeBytes -Cpu arm64)).Cpu
Check "a file that is not a PE image reads as nothing" $true ($null -eq (Read-PeImage ([System.Text.Encoding]::ASCII.GetBytes("MZ is not enough to be a program, it needs a PE header too"))))

Check "the Visual C++ runtime DLLs never count as Windows" @($true, $true, $true, $true, $true, $true) @("VCRUNTIME140.dll", "vcruntime140_1.dll", "MSVCP140_2.dll", "concrt140.dll", "vccorlib140.dll", "ucrtbased.dll" | ForEach-Object { Test-VcRuntimeName $_ })
Check "ucrtbase and msvcrt are part of Windows, not the redist" @($false, $false) @("ucrtbase.dll", "msvcrt.dll" | ForEach-Object { Test-VcRuntimeName $_ })

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("ardia-pe-test-" + [guid]::NewGuid().ToString("N"))
try {
  $app = Join-Path $scratch "app"
  Write-Pe (Join-Path $app "Ardia.exe") (New-PeBytes -Imports "KERNEL32.dll", "Helper.dll", "msvcp140_app.dll", "api-ms-win-crt-runtime-l1-1-0.dll" -Delayed "NotThere.dll")
  Write-Pe (Join-Path $app "helper.dll") (New-PeBytes -Imports "kernel32.dll")
  Write-Pe (Join-Path $app "msvcp140_app.dll") (New-PeBytes -Imports "VCRUNTIME140.dll" -Forwards "MSVCP140.foo", "msvcp140.bar")
  Write-Pe (Join-Path $app "vcamp140_app.dll") (New-PeBytes -Imports "VCRUNTIME140.dll" -Forwards "vcamp140.foo")
  Write-Pe (Join-Path $app "Nested" "Plugin.dll") (New-PeBytes -Imports "Sibling.dll", "kernel32.dll")
  Write-Pe (Join-Path $app "Nested" "Sibling.dll") (New-PeBytes)
  [System.IO.File]::WriteAllText((Join-Path $app "resources.pak"), "not a program")

  $unmet = @(Find-UnmetDependencies $app @("kernel32.dll") | Sort-Object Name, By, Kind)
  Check "unmet: the redist DLLs, and an unknown delay-load" @("msvcp140.dll", "notthere.dll", "vcamp140.dll", "vcruntime140.dll", "vcruntime140.dll") @($unmet.Name)
  Check "unmet: who needs each, and how" @("msvcp140_app.dll forwarded export", "Ardia.exe delay-load", "vcamp140_app.dll forwarded export", "msvcp140_app.dll import", "vcamp140_app.dll import") @($unmet | ForEach-Object { "$($_.By) $($_.Kind)" })
  Check "unmet: only the redist DLLs are marked as the Visual C++ runtime" @($true, $false, $true, $true, $true) @($unmet.VcRuntime)
  Check-Throws "the Visual C++ runtime can't be listed as part of Windows" "never count" { Find-UnmetDependencies $app @("kernel32.dll", "VCRUNTIME140.dll") }
  Check-Throws "an API set can't be listed as part of Windows" "never count" { Find-UnmetDependencies $app @("api-ms-win-core-file-l1-1-0.dll") }

  $redist = Join-Path $scratch "redist"
  Write-Pe (Join-Path $redist "Microsoft.VC145.CRT" "msvcp140.dll") (New-PeBytes -Imports "VCRUNTIME140.dll", "KERNEL32.dll")
  Write-Pe (Join-Path $redist "Microsoft.VC145.CRT" "vcruntime140.dll") (New-PeBytes -Imports "KERNEL32.dll")
  Write-Pe (Join-Path $redist "Microsoft.VC145.CRT" "vcruntime140_1.dll") (New-PeBytes -Imports "VCRUNTIME140.dll")
  Write-Pe (Join-Path $redist "Microsoft.VC145.MFC" "mfc140u.dll") (New-PeBytes)
  Remove-Item -LiteralPath (Join-Path $app "Ardia.exe")
  Write-Pe (Join-Path $app "Ardia.exe") (New-PeBytes -Imports "KERNEL32.dll", "msvcp140_app.dll")
  Add-VcRuntime $app "x64" $redist
  [string[]]$names = @(Get-ChildItem -LiteralPath $app -File | ForEach-Object { $_.Name.ToLowerInvariant() })
  [Array]::Sort($names, [StringComparer]::Ordinal)
  Check "the runtime DLLs the app needs are copied in, with what they need in turn, and an unused forwarder with no target is left out" @("ardia.exe", "helper.dll", "msvcp140.dll", "msvcp140_app.dll", "resources.pak", "vcruntime140.dll") $names
  Check "after that nothing is unmet" 0 @(Find-UnmetDependencies $app @("kernel32.dll")).Count

  Write-Pe (Join-Path $app "vcamp140_app.dll") (New-PeBytes -Imports "VCRUNTIME140.dll" -Forwards "vcamp140.foo")
  Write-Pe (Join-Path $app "Nested" "Plugin.dll") (New-PeBytes -Imports "Sibling.dll", "vcamp140_app.dll")
  Check-Throws "a forwarder something loads, whose target the redist lacks, fails the assembly" "vcamp140\.dll, which the Visual C\+\+ redist" { Add-VcRuntime $app "x64" $redist }
  Remove-Item -LiteralPath (Join-Path $app "vcamp140_app.dll")
  Write-Pe (Join-Path $app "Nested" "Plugin.dll") (New-PeBytes -Imports "Sibling.dll")

  $arm = Join-Path $scratch "arm-redist"
  Write-Pe (Join-Path $arm "Microsoft.VC145.CRT" "vcruntime140.dll") (New-PeBytes -Cpu arm64)
  Write-Pe (Join-Path $arm "Microsoft.VC145.CRT" "vcruntime140_1.dll") (New-PeBytes -Cpu arm64)
  Write-Pe (Join-Path $app "vcruntime140_1_app.dll") (New-PeBytes -Forwards "VCRUNTIME140_1.foo")
  Write-Pe (Join-Path $app "Ardia.exe") (New-PeBytes -Imports "KERNEL32.dll", "vcruntime140_1_app.dll")
  Check-Throws "a redist DLL for another CPU is refused" "is not a x64 DLL" { Add-VcRuntime $app "x64" $arm }
  Check-Throws "a redist folder without vcruntime140.dll is refused" "has no vcruntime140.dll" { Add-VcRuntime $app "x64" (Join-Path $redist "Microsoft.VC145.MFC") }
} finally {
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count) {
  $failures | ForEach-Object { Write-Host "::error::$_" }
  exit 1
}
Write-Host "PE imports, delay-loads and forwarders are read, and the Visual C++ runtime is found and deployed."
