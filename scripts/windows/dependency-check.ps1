param(
  [Parameter(Mandatory = $true)][string]$App,
  [switch]$ListSystem
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "pe-imports.ps1")
. (Join-Path $PSScriptRoot "shell-layout.ps1")

$windowsShips = @(
  "advapi32.dll", "bcp47langs.dll", "bcp47mrm.dll", "bcrypt.dll", "bcryptprimitives.dll", "bthprops.cpl",
  "cfgmgr32.dll", "chakra.dll", "combase.dll", "comctl32.dll", "comdlg32.dll", "coremessaging.dll", "credui.dll",
  "crypt32.dll", "cryptui.dll", "d2d1.dll", "d3d11.dll", "d3d12.dll", "dbghelp.dll", "dcomp.dll", "dhcpcsvc.dll",
  "dwmapi.dll", "dwrite.dll", "dxcore.dll", "dxgi.dll", "elscore.dll", "esent.dll", "gdi32.dll", "hid.dll", "icu.dll",
  "imm32.dll", "iphlpapi.dll", "kernel32.dll", "kernelbase.dll", "mf.dll", "mfplat.dll", "mfreadwrite.dll", "mmdevapi.dll",
  "mscms.dll", "msvcrt.dll", "ncrypt.dll", "ndfapi.dll", "netapi32.dll", "ninput.dll", "ntdll.dll", "ole32.dll",
  "oleacc.dll", "oleaut32.dll", "pdh.dll", "powrprof.dll", "profapi.dll", "propsys.dll", "rometadata.dll", "rpcrt4.dll",
  "secur32.dll", "setupapi.dll", "shcore.dll", "shell32.dll", "shlwapi.dll", "tbs.dll", "ucrtbase.dll",
  "uiautomationcore.dll", "urlmon.dll", "user32.dll", "userenv.dll", "usp10.dll", "uxtheme.dll", "version.dll",
  "wevtapi.dll", "windowscodecs.dll", "winhttp.dll", "wininet.dll", "winmm.dll", "winspool.drv", "winsqlite3.dll",
  "wintrust.dll", "winusb.dll", "ws2_32.dll", "wtsapi32.dll", "xmllite.dll"
)

if ($ListSystem) {
  $windowsShips
  exit 0
}

if (-not (Test-Path -LiteralPath $App -PathType Container)) { throw "'$App' is not a folder" }
$root = (Resolve-Path -LiteralPath $App).Path
$shellKind = Get-ShellLayout $root
if ($shellKind -eq "mixed") { Write-Host "::error::'$App' holds both the React Native shell's $($ShellLayout.RnwLibrary) and the WebUI shell's $($ShellLayout.UiEntry)"; exit 1 }
if ($shellKind -eq "webui") {
  $layoutProblems = Get-ShellLayoutProblems $root "webui" -AllowTestBuild
  foreach ($problem in $layoutProblems) { Write-Host "::error::the WebUI build $problem" }
  if ($layoutProblems.Count) { exit 1 }
}
$files = @(Get-PeFiles $root)
if (-not $files.Count) { throw "'$App' holds no PE files" }
$unmet = @(Find-UnmetDependencies $root $windowsShips $files)
$cpus = ($files | ForEach-Object { $_.Image.Cpu } | Group-Object | Sort-Object Count -Descending | ForEach-Object { "$($_.Count) $($_.Name)" }) -join ", "

$layoutNote = if ($shellKind -eq "none") { "" } else { "$shellKind shell, " }
if (-not $unmet.Count) {
  Write-Host "dependency-check: ${layoutNote}every import, delay-load and forwarded export of the $($files.Count) PE files in $root ($cpus) is in the app folder, an API set or part of a clean Windows 11"
  exit 0
}

foreach ($group in ($unmet | Group-Object Name | Sort-Object Name)) {
  $what = if ($group.Group[0].VcRuntime) { "a Visual C++ runtime DLL the app folder lacks (Windows doesn't ship it; the redist must sit beside Ardia.exe)" } else { "neither in the app folder nor on the list of DLLs a clean Windows 11 ships" }
  $users = ($group.Group | ForEach-Object { "$($_.By) ($($_.Kind))" } | Sort-Object -Unique) -join ", "
  Write-Host "::error::$($group.Name) is $what; needed by $users"
}
Write-Host "dependency-check: $(@($unmet | Group-Object Name).Count) DLLs that $($files.Count) PE files in $root ($cpus) need would be missing on a clean Windows 11"
exit 1
