$ShellLayout = @{
  Launcher = "Ardia.exe"
  Engine = "chrome.dll"
  EngineLauncher = "chrome.exe"
  RnwLibrary = "ArdiaApp.dll"
  UiFolder = "ardia-ui"
  UiEntry = "ardia-ui\index.html"
  Migrator = "ardia-webui-migrate.exe"
  BuildIdentity = "Ardia.build.json"
  UpdateVerifier = "ardia-update-verify.exe"
  UpdateKey = "windows-update.pem"
  TestMarker = "Ardia.test-build"
  WebUISwitch = "--ardia-shell=webui"
  AppUserModelId = "Ardia.Browser"
}

$ShellOwned = @{
  rnw = @(
    "ArdiaApp.dll", "ArdiaApp.winrt.manifest", "Ardia.pri", "RestartAgent.exe",
    "concrt140_app.dll", "msvcp140_app.dll", "msvcp140_1_app.dll", "msvcp140_2_app.dll", "vcamp140_app.dll", "vccorlib140_app.dll",
    "vcomp140_app.dll", "vcruntime140_app.dll", "vcruntime140_1_app.dll",
    "CoreMessagingXP.dll", "dcompi.dll", "DirectML.dll", "dwmcorei.dll", "DwmSceneI.dll", "DWriteCore.dll", "hermes.dll",
    "hermes-icu.dll", "marshal.dll", "MRM.dll", "onnxruntime.dll", "onnxruntime_providers_shared.dll",
    "PushNotificationsLongRunningTask.ProxyStub.dll", "SessionHandleIPCProxyStub.dll", "WinUIEdit.dll", "wuceffectsi.dll",
    "Microsoft.DirectManipulation.dll", "Microsoft.Graphics.Display.dll", "Microsoft.Graphics.Imaging.dll",
    "Microsoft.InputStateManager.dll", "Microsoft.Internal.FrameworkUdk.dll", "Microsoft.ReactNative.dll", "Microsoft.ReactNative.pri",
    "Microsoft.UI.Composition.OSSupport.dll", "Microsoft.UI.Designer.dll", "Microsoft.UI.dll", "Microsoft.UI.Input.dll", "Microsoft.UI.pri",
    "Microsoft.UI.Windowing.Core.dll", "Microsoft.UI.Windowing.dll", "Microsoft.UI.Xaml.Controls.dll", "Microsoft.UI.Xaml.Controls.pri",
    "Microsoft.ui.xaml.dll", "Microsoft.UI.Xaml.Internal.dll", "Microsoft.UI.Xaml.Phone.dll", "Microsoft.ui.xaml.resources.19h1.dll",
    "Microsoft.ui.xaml.resources.common.dll", "Microsoft.Web.WebView2.Core.dll", "Microsoft.Windows.AI.AICapabilities.dll",
    "Microsoft.Windows.AI.ContentSafety.dll", "Microsoft.Windows.AI.Imaging.dll", "Microsoft.Windows.AI.MachineLearning.dll",
    "Microsoft.Windows.AI.Text.dll", "Microsoft.Windows.ApplicationModel.Resources.dll", "Microsoft.Windows.Widgets.dll",
    "Microsoft.Windows.Workloads.dll", "Microsoft.Windows.Workloads.Resources.dll", "Microsoft.Windows.Workloads.Resources_ec.dll",
    "Microsoft.WindowsAppRuntime.Bootstrap.dll", "Microsoft.WindowsAppRuntime.dll", "Microsoft.WindowsAppRuntime.Insights.Resource.dll",
    "Microsoft.WindowsAppRuntime.pri", "WindowsAppRuntime.DeploymentExtensions.OneCore.dll", "WindowsAppRuntime.png",
    "WindowsAppSdk.AppxDeploymentExtensions.Desktop-EventLog-Instrumentation.dll", "WindowsAppSdk.AppxDeploymentExtensions.Desktop.dll",
    "workloads.json", "workloads.365.json", "workloads.j32.json", "workloads.lnl.json", "workloads.qnn.json", "workloads.stx.json",
    "Bundle\index.windows.bundle", "Microsoft.UI.Xaml\Assets\map.html", "Microsoft.UI.Xaml\Assets\NoiseAsset_256X256_PNG.png",
    "NpuDetect\NPUDetect.dll", "*\Microsoft.ui.xaml.dll.mui", "*\Microsoft.UI.Xaml.Phone.dll.mui"
  )
  webui = @("ardia-ui\index.html", "ardia-webui-migrate.exe")
}

$ShellOwnedFolders = @{
  rnw = @("Bundle", "Microsoft.UI.Xaml", "NpuDetect")
  webui = @("ardia-ui")
}

$ShellKept = @("Ardia.exe", "Ardia.ico", "Ardia.build.json", "ardia-update-verify.exe", "windows-update.pem", "chrome.dll", "chrome_elf.dll", "locales\", "unins000.exe", "unins000.dat")

function Get-OtherShell([string]$shell) {
  if ($shell -eq "webui") { return "rnw" }
  return "webui"
}

function Get-ShellOwnedEntries([string]$shell) {
  if (-not $ShellOwned.ContainsKey($shell)) { throw "'$shell' is not a shell: rnw or webui" }
  return ,$ShellOwned[$shell]
}

function Get-ShellManifestName([string]$shell) {
  if (-not $ShellOwned.ContainsKey($shell)) { throw "'$shell' is not a shell: rnw or webui" }
  return "ardia-$shell-files.txt"
}

function Get-RelativeFiles([string]$root, [string]$folder) {
  $base = (Resolve-Path -LiteralPath $root).Path.TrimEnd('\', '/')
  $path = Join-Path $base $folder
  if (-not (Test-Path -LiteralPath $path -PathType Container)) { return ,@() }
  ,@(Get-ChildItem -LiteralPath $path -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($base.Length + 1).Replace('/', '\') })
}

function Find-OwnedFiles([string]$root, [string]$shell) {
  $found = @()
  foreach ($entry in (Get-ShellOwnedEntries $shell)) {
    if ($entry.StartsWith("*\")) {
      $name = $entry.Substring(2)
      foreach ($folder in @(Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction SilentlyContinue)) {
        if (Test-Path -LiteralPath (Join-Path $folder.FullName $name) -PathType Leaf) { $found += "$($folder.Name)\$name" }
      }
    } elseif (Test-Path -LiteralPath (Join-Path $root $entry) -PathType Leaf) {
      $found += $entry
    }
  }
  ,$found
}

function Get-ShellShippedFiles([string]$root, [string]$shell) {
  $files = @()
  $files += Find-OwnedFiles $root $shell
  foreach ($folder in $ShellOwnedFolders[$shell]) { $files += Get-RelativeFiles $root $folder }
  ,@($files | Sort-Object -Unique)
}

function Write-Lines([string]$path, [string[]]$lines) {
  [System.IO.File]::WriteAllText($path, (($lines -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding $false))
}

function Write-ShellManifest([string]$root, [string]$shell, [string]$path) {
  $files = Get-ShellShippedFiles $root $shell
  if (-not $files.Count) { throw "'$root' ships none of the $shell shell's own files" }
  Write-Lines $path $files
}

function Find-ShellOwnedEntries([string]$root, [string]$shell) {
  $files = Find-OwnedFiles $root $shell
  $found = @($files | Where-Object { $entry = $_; -not ($ShellOwnedFolders[$shell] | Where-Object { $entry.StartsWith("$_\") }) })
  foreach ($folder in $ShellOwnedFolders[$shell]) {
    if (Test-Path -LiteralPath (Join-Path $root $folder) -PathType Container) { $found += "$folder\" }
  }
  if (Test-Path -LiteralPath (Join-Path $root (Get-ShellManifestName $shell)) -PathType Leaf) { $found += Get-ShellManifestName $shell }
  ,$found
}

function Find-UnlistedOwnedFiles([string]$root, [string]$shell) {
  $manifest = Join-Path $root (Get-ShellManifestName $shell)
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return ,@() }
  $listed = @{}
  foreach ($line in (Get-Content -LiteralPath $manifest)) { if ($line.Trim()) { $listed[$line.Trim().ToLowerInvariant()] = $true } }
  $files = @()
  foreach ($folder in $ShellOwnedFolders[$shell]) { $files += Get-RelativeFiles $root $folder }
  ,@($files | Where-Object { -not $listed.ContainsKey($_.ToLowerInvariant()) })
}

function Write-RetiredShellList([string]$shell, [string]$path) {
  Write-Lines $path (Get-ShellOwnedEntries (Get-OtherShell $shell))
}

function Write-KeptFileList([string]$path) {
  Write-Lines $path @($ShellKept | Where-Object { -not $_.EndsWith("\") })
}

function Get-ShellLayout([string]$root) {
  $rnw = Test-Path -LiteralPath (Join-Path $root $ShellLayout.RnwLibrary) -PathType Leaf
  $webui = Test-Path -LiteralPath (Join-Path $root $ShellLayout.UiEntry) -PathType Leaf
  if ($rnw -and $webui) { return "mixed" }
  if ($rnw) { return "rnw" }
  if ($webui) { return "webui" }
  return "none"
}

function Resolve-ShellLayout([string]$root, [string]$requested = "auto") {
  $found = Get-ShellLayout $root
  if (@("rnw", "webui") -notcontains $found) {
    $why = if ($found -eq "mixed") { "both $($ShellLayout.RnwLibrary) and $($ShellLayout.UiEntry)" } else { "neither $($ShellLayout.RnwLibrary) nor $($ShellLayout.UiEntry)" }
    throw "'$root' holds $why, so it is neither the React Native shell nor the WebUI shell"
  }
  if ($requested -and $requested -ne "auto" -and $requested -ne $found) { throw "'$root' is the $found shell, not the $requested shell asked for" }
  return $found
}

function Get-ShellMarker([string]$shell) {
  if ($shell -eq "webui") { return $ShellLayout.UiEntry }
  return $ShellLayout.RnwLibrary
}

function Get-ShellLaunchSwitch([string]$shell) {
  if ($shell -eq "webui") { return $ShellLayout.WebUISwitch }
  return ""
}

function Get-ShellOpenCommand([string]$exe, [string]$shell) {
  $switch = Get-ShellLaunchSwitch $shell
  if ($switch) { return "`"$exe`" $switch" }
  return "`"$exe`""
}

function Get-ShellDocumentCommand([string]$exe, [string]$shell) {
  $switch = Get-ShellLaunchSwitch $shell
  if ($switch) { return "`"$exe`" $switch --single-argument %1" }
  return "`"$exe`" --single-argument %1"
}

function Get-ShellInstalledFiles([string]$shell) {
  if ($shell -eq "webui") { return @($ShellLayout.Launcher, $ShellLayout.Engine, "Ardia.ico", "Ardia.build.json", $ShellLayout.UpdateVerifier, $ShellLayout.UpdateKey, "unins000.exe", $ShellLayout.UiEntry, $ShellLayout.Migrator, (Get-ShellManifestName "webui")) }
  return @($ShellLayout.Launcher, $ShellLayout.RnwLibrary, $ShellLayout.Engine, "Ardia.ico", "Ardia.build.json", $ShellLayout.UpdateVerifier, $ShellLayout.UpdateKey, "unins000.exe", (Get-ShellManifestName "rnw"))
}

function Find-TestMarkers([string]$root) {
  return @(Get-ChildItem -LiteralPath $root -Recurse -File -Force -Filter $ShellLayout.TestMarker -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
}

function Get-ShellLayoutProblems([string]$root, [string]$shell, [switch]$AllowTestBuild) {
  $problems = @()
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { return ,@("'$root' is not a folder") }
  if (@("rnw", "webui") -notcontains $shell) { return ,@("'$shell' is not a shell: rnw or webui") }
  foreach ($name in $ShellLayout.Launcher, $ShellLayout.Engine) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $name) -PathType Leaf)) { $problems += "it has no $name" }
  }
  if ($shell -eq "webui") {
    if (-not (Test-Path -LiteralPath (Join-Path $root $ShellLayout.UiEntry) -PathType Leaf)) { $problems += "it has no $($ShellLayout.UiEntry)" }
    if (-not (Test-Path -LiteralPath (Join-Path $root $ShellLayout.Migrator) -PathType Leaf)) { $problems += "it has no $($ShellLayout.Migrator), so an upgrade from the React Native shell would start empty" }
    if (-not (Test-Path -LiteralPath (Join-Path $root $ShellLayout.BuildIdentity) -PathType Leaf)) { $problems += "it has no $($ShellLayout.BuildIdentity), so updates can't tell its version and build" }
    foreach ($name in $ShellLayout.UpdateVerifier, $ShellLayout.UpdateKey) {
      if (-not (Test-Path -LiteralPath (Join-Path $root $name) -PathType Leaf)) { $problems += "it has no $name, so it can't verify the updates it downloads" }
    }
    if (Test-Path -LiteralPath (Join-Path $root $ShellLayout.EngineLauncher)) { $problems += "it still holds $($ShellLayout.EngineLauncher) beside $($ShellLayout.Launcher)" }
  } elseif (-not (Test-Path -LiteralPath (Join-Path $root $ShellLayout.RnwLibrary) -PathType Leaf)) {
    $problems += "it has no $($ShellLayout.RnwLibrary)"
  }
  $unlisted = Find-UnlistedOwnedFiles $root $shell
  if ($unlisted.Count) { $problems += "it holds $($unlisted.Count) files in its own folders that $(Get-ShellManifestName $shell) doesn't list: $(($unlisted | Select-Object -First 5) -join ', ')" }
  $other = Get-OtherShell $shell
  $leftover = Find-ShellOwnedEntries $root $other
  if ($leftover.Count) { $problems += "it still holds $($leftover.Count) of the $other shell's files: $(($leftover | Select-Object -First 5) -join ', ')" }
  if (-not $AllowTestBuild) {
    foreach ($marker in (Find-TestMarkers $root)) { $problems += "it carries a test-build marker at $marker, so it would read test keys" }
  }
  return ,$problems
}
