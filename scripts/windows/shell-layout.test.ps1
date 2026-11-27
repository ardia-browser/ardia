$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "shell-layout.ps1")

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

function Touch([string]$Root, [string[]]$Names) {
  foreach ($name in $Names) {
    $path = Join-Path $Root $name
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
    [System.IO.File]::WriteAllText($path, $name)
  }
}

function New-Folder([string]$Name) {
  $path = Join-Path $scratch $Name
  New-Item -ItemType Directory -Force -Path $path | Out-Null
  return $path
}

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("ardia-shell-layout-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
try {
  $rnw = New-Folder "rnw"
  Touch $rnw "Ardia.exe", "ArdiaApp.dll", "chrome.dll"
  $webui = New-Folder "webui"
  Touch $webui "Ardia.exe", "chrome.dll", "Ardia.build.json", "ardia-update-verify.exe", "windows-update.pem", "ardia-ui\index.html", "ardia-ui\assets\app.js", "ardia-webui-migrate.exe", "locales\en-US.pak"
  $mixed = New-Folder "mixed"
  Touch $mixed "Ardia.exe", "chrome.dll", "ArdiaApp.dll", "ardia-ui\index.html"
  $bare = New-Folder "bare"
  Touch $bare "chrome.exe", "chrome.dll"

  Check "a folder with ArdiaApp.dll is the React Native shell" "rnw" (Get-ShellLayout $rnw)
  Check "a folder with ardia-ui\index.html is the WebUI shell" "webui" (Get-ShellLayout $webui)
  Check "a folder with both is mixed" "mixed" (Get-ShellLayout $mixed)
  Check "a bare engine is neither" "none" (Get-ShellLayout $bare)
  Check "auto picks the WebUI shell from the folder" "webui" (Resolve-ShellLayout $webui "auto")
  Check "auto picks the React Native shell from the folder" "rnw" (Resolve-ShellLayout $rnw)
  Check-Throws "a mixed folder is refused" "both ArdiaApp.dll and ardia-ui" { Resolve-ShellLayout $mixed }
  Check-Throws "a bare engine is refused" "neither ArdiaApp.dll nor ardia-ui" { Resolve-ShellLayout $bare }
  Check-Throws "asking for the WebUI shell over a React Native folder is refused" "is the rnw shell, not the webui shell" { Resolve-ShellLayout $rnw "webui" }

  Check "the React Native shell launches with no switch" "" (Get-ShellLaunchSwitch "rnw")
  Check "the WebUI shell launches with --ardia-shell=webui" "--ardia-shell=webui" (Get-ShellLaunchSwitch "webui")
  Check "the React Native open command is the launcher alone" '"C:\A\Ardia.exe"' (Get-ShellOpenCommand "C:\A\Ardia.exe" "rnw")
  Check "the WebUI open command carries the switch" '"C:\A\Ardia.exe" --ardia-shell=webui' (Get-ShellOpenCommand "C:\A\Ardia.exe" "webui")
  Check "the React Native document command is unchanged" '"C:\A\Ardia.exe" --single-argument %1' (Get-ShellDocumentCommand "C:\A\Ardia.exe" "rnw")
  Check "the WebUI document command puts the switch before --single-argument" '"C:\A\Ardia.exe" --ardia-shell=webui --single-argument %1' (Get-ShellDocumentCommand "C:\A\Ardia.exe" "webui")
  Check "the React Native install ships ArdiaApp.dll and the update verifier" "Ardia.exe,ArdiaApp.dll,chrome.dll,Ardia.ico,Ardia.build.json,ardia-update-verify.exe,windows-update.pem,unins000.exe,ardia-rnw-files.txt" ((Get-ShellInstalledFiles "rnw") -join ",")
  Check "the WebUI install ships the UI, the migrator and the update verifier" "Ardia.exe,chrome.dll,Ardia.ico,Ardia.build.json,ardia-update-verify.exe,windows-update.pem,unins000.exe,ardia-ui\index.html,ardia-webui-migrate.exe,ardia-webui-files.txt" ((Get-ShellInstalledFiles "webui") -join ",")

  Check "a complete WebUI folder has no problems" 0 (Get-ShellLayoutProblems $webui "webui").Count
  Check "a complete React Native folder has no problems" 0 (Get-ShellLayoutProblems $rnw "rnw").Count
  $noMigrator = New-Folder "no-migrator"
  Touch $noMigrator "Ardia.exe", "chrome.dll", "Ardia.build.json", "ardia-update-verify.exe", "windows-update.pem", "ardia-ui\index.html"
  Check "a WebUI folder without the migrator is a problem" "it has no ardia-webui-migrate.exe, so an upgrade from the React Native shell would start empty" ((Get-ShellLayoutProblems $noMigrator "webui") -join "|")
  $noIdentity = New-Folder "no-identity"
  Touch $noIdentity "Ardia.exe", "chrome.dll", "ardia-update-verify.exe", "windows-update.pem", "ardia-ui\index.html", "ardia-webui-migrate.exe"
  Check "a WebUI folder without Ardia.build.json is a problem" "it has no Ardia.build.json, so updates can't tell its version and build" ((Get-ShellLayoutProblems $noIdentity "webui") -join "|")
  $noVerifier = New-Folder "no-verifier"
  Touch $noVerifier "Ardia.exe", "chrome.dll", "Ardia.build.json", "ardia-ui\index.html", "ardia-webui-migrate.exe"
  Check "a WebUI folder without the update verifier and key names both" "it has no ardia-update-verify.exe, so it can't verify the updates it downloads|it has no windows-update.pem, so it can't verify the updates it downloads" ((Get-ShellLayoutProblems $noVerifier "webui") -join "|")
  $noKey = New-Folder "no-key"
  Touch $noKey "Ardia.exe", "chrome.dll", "Ardia.build.json", "ardia-update-verify.exe", "ardia-ui\index.html", "ardia-webui-migrate.exe"
  Check "a WebUI folder without the pinned key is a problem" "it has no windows-update.pem, so it can't verify the updates it downloads" ((Get-ShellLayoutProblems $noKey "webui") -join "|")
  $leftover = New-Folder "leftover"
  Touch $leftover "Ardia.exe", "chrome.exe", "chrome.dll", "Ardia.build.json", "ardia-update-verify.exe", "windows-update.pem", "Microsoft.ReactNative.dll", "Bundle\index.windows.bundle", "de-DE\Microsoft.ui.xaml.dll.mui", "ardia-ui\index.html", "ardia-webui-migrate.exe"
  Check "a WebUI folder with chrome.exe and React Native files has two problems" 2 (Get-ShellLayoutProblems $leftover "webui").Count
  Check "the React Native files left in a WebUI folder are named" "it still holds 3 of the rnw shell's files: Microsoft.ReactNative.dll, de-DE\Microsoft.ui.xaml.dll.mui, Bundle\" ((Get-ShellLayoutProblems $leftover "webui") | Where-Object { $_ -match "rnw shell" })
  $rolledBack = New-Folder "rolled-back"
  Touch $rolledBack "Ardia.exe", "chrome.dll", "ArdiaApp.dll", "ardia-ui\index.html", "ardia-webui-migrate.exe"
  Check "a React Native folder that kept the WebUI files names both" "it still holds 2 of the webui shell's files: ardia-webui-migrate.exe, ardia-ui\" ((Get-ShellLayoutProblems $rolledBack "rnw") -join "|")
  $marked = New-Folder "marked"
  Touch $marked "Ardia.exe", "chrome.dll", "Ardia.build.json", "ardia-update-verify.exe", "windows-update.pem", "ardia-ui\index.html", "ardia-webui-migrate.exe", "sub\Ardia.test-build"
  Check "a test-build marker anywhere is a problem" 1 (Get-ShellLayoutProblems $marked "webui").Count
  Check "a test-build marker is allowed when asked" 0 (Get-ShellLayoutProblems $marked "webui" -AllowTestBuild).Count
  Check "an unknown shell is a problem" "'other' is not a shell: rnw or webui" ((Get-ShellLayoutProblems $webui "other") -join "|")

  $rnwOwned = Get-ShellOwnedEntries "rnw"
  $webuiOwned = Get-ShellOwnedEntries "webui"
  Check "the React Native shell owns its library, bundle and XAML resources" $true (($rnwOwned -contains "ArdiaApp.dll") -and ($rnwOwned -contains "Bundle\index.windows.bundle") -and ($rnwOwned -contains "Microsoft.ReactNative.dll") -and ($rnwOwned -contains "*\Microsoft.ui.xaml.dll.mui"))
  Check "the WebUI shell owns its UI and migrator" "ardia-ui\index.html,ardia-webui-migrate.exe" ($webuiOwned -join ",")
  Check "every fallback entry names a file, never a whole folder" "" ((@($rnwOwned) + @($webuiOwned) | Where-Object { $_.EndsWith("\") }) -join ",")
  Check "each shell's own folders" "Bundle,Microsoft.UI.Xaml,NpuDetect|ardia-ui" (($ShellOwnedFolders.rnw -join ",") + "|" + ($ShellOwnedFolders.webui -join ","))
  Check "no file is owned by both shells" "" (($rnwOwned | Where-Object { $webuiOwned -contains $_ }) -join ",")
  Check "both shells keep the update verifier and its pinned key" $true (($ShellKept -contains "ardia-update-verify.exe") -and ($ShellKept -contains "windows-update.pem"))
  Check "neither shell owns the launcher, the engine, the identity, the update verifier, the locales or the uninstaller" "" ((@($rnwOwned) + @($webuiOwned) | Where-Object { $ShellKept -contains $_ }) -join ",")
  Check "the React Native shell owns nothing the WebUI install ships" "" (($rnwOwned | Where-Object { (Get-ShellInstalledFiles "webui") -contains $_ }) -join ",")
  Check "the WebUI shell owns nothing the React Native install ships" "" (($webuiOwned | Where-Object { (Get-ShellInstalledFiles "rnw") -contains $_ }) -join ",")
  Check "no owned entry climbs out of the install folder" "" ((@($rnwOwned) + @($webuiOwned) | Where-Object { $_ -match '\.\.|:|^\\' }) -join ",")
  $installedRnw = New-Folder "installed-rnw"
  Touch $installedRnw "Ardia.exe", "ArdiaApp.dll", "chrome.dll", "Bundle\index.windows.bundle", "en-US\Microsoft.ui.xaml.dll.mui", "locales\en-US.pak", "unins000.exe"
  Check "the React Native files in an install are found, locale resources included" "ArdiaApp.dll,en-US\Microsoft.ui.xaml.dll.mui,Bundle\" ((Find-ShellOwnedEntries $installedRnw "rnw") -join ",")
  Check "the WebUI shell retires the React Native list" "rnw" (Get-OtherShell "webui")
  Check "the React Native shell retires the WebUI list" "webui" (Get-OtherShell "rnw")
  Check "the WebUI shell's marker is its UI entry" "ardia-ui\index.html" (Get-ShellMarker "webui")
  Check "the React Native shell's marker is its library" "ArdiaApp.dll" (Get-ShellMarker "rnw")
  $retired = Join-Path $scratch "retired.txt"
  Write-RetiredShellList "webui" $retired
  Check "the WebUI installer is handed the React Native list, one entry a line" ($rnwOwned -join "|") (((Get-Content -LiteralPath $retired) | Where-Object { $_ }) -join "|")
  Write-RetiredShellList "rnw" $retired
  Check "the React Native installer is handed the WebUI list" "ardia-ui\index.html|ardia-webui-migrate.exe" (((Get-Content -LiteralPath $retired) | Where-Object { $_ }) -join "|")
  Check "neither retired list names the update verifier or its key" "" ((@($rnwOwned) + @($webuiOwned) | Where-Object { $_ -in @("ardia-update-verify.exe", "windows-update.pem") }) -join ",")
  $keptList = Join-Path $scratch "kept-files.txt"
  Write-KeptFileList $keptList
  Check "the installer is handed every kept file, never a folder" (($ShellKept | Where-Object { -not $_.EndsWith("\") }) -join "|") (((Get-Content -LiteralPath $keptList) | Where-Object { $_ }) -join "|")

  Check "each shell names its manifest" "ardia-rnw-files.txt|ardia-webui-files.txt" ((Get-ShellManifestName "rnw") + "|" + (Get-ShellManifestName "webui"))
  $rnwPayload = New-Folder "rnw-payload"
  Touch $rnwPayload "Ardia.exe", "ArdiaApp.dll", "chrome.dll", "Microsoft.ReactNative.dll", "Bundle\index.windows.bundle", "Bundle\assets\assets\logo-3f2a.png", "fr-FR\Microsoft.ui.xaml.dll.mui", "NpuDetect\NPUDetect.dll", "locales\fr.pak", "vcruntime140.dll"
  Check "a React Native payload lists exactly its own files, bundle assets included" "ArdiaApp.dll,Bundle\assets\assets\logo-3f2a.png,Bundle\index.windows.bundle,fr-FR\Microsoft.ui.xaml.dll.mui,Microsoft.ReactNative.dll,NpuDetect\NPUDetect.dll" ((Get-ShellShippedFiles $rnwPayload "rnw") -join ",")
  $webuiPayload = New-Folder "webui-payload"
  Touch $webuiPayload "Ardia.exe", "chrome.dll", "Ardia.build.json", "ardia-ui\index.html", "ardia-ui\assets\index-DR2puOJK.js", "ardia-ui\assets\fonts\inter.woff2", "ardia-webui-migrate.exe", "locales\fr.pak"
  $manifest = Join-Path $scratch "ardia-webui-files.txt"
  Write-ShellManifest $webuiPayload "webui" $manifest
  Check "a WebUI manifest lists every hashed UI asset and the migrator, and nothing of the engine" "ardia-ui\assets\fonts\inter.woff2|ardia-ui\assets\index-DR2puOJK.js|ardia-ui\index.html|ardia-webui-migrate.exe" (((Get-Content -LiteralPath $manifest) | Where-Object { $_ }) -join "|")
  Check "the manifest is CRLF text with no byte order mark" "97,114" ((([System.IO.File]::ReadAllBytes($manifest))[0..1]) -join ",")
  Check-Throws "a manifest of a payload with none of the shell's files is refused" "ships none of the webui shell's own files" { Write-ShellManifest $rnwPayload "webui" (Join-Path $scratch "empty.txt") }
  $rnwShipped = Get-ShellShippedFiles $rnwPayload "rnw"
  $webuiShipped = Get-ShellShippedFiles $webuiPayload "webui"
  Check "no shell's manifest lists the launcher, the engine, the identity, the locales or the uninstaller" "" (($rnwShipped + $webuiShipped | Where-Object { $file = $_; $ShellKept | Where-Object { $file -eq $_ -or ($_.EndsWith("\") -and $file.StartsWith($_)) } }) -join ",")

  $assemble = Join-Path $PSScriptRoot "assemble-webui.ps1"
  $engine = New-Folder "engine"
  Touch $engine "chrome.exe", "chrome.dll", "RUN.txt", "Ardia.test-build", "locales\en-US.pak"
  $ui = New-Folder "ui"
  Touch $ui "index.html", "assets\app.js"
  $migrator = Join-Path (New-Folder "migrator") "ardia-webui-migrate.exe"
  Touch (Split-Path -Parent $migrator) "ardia-webui-migrate.exe"
  $verifier = Join-Path (New-Folder "verifier") "ardia-update-verify.exe"
  Touch (Split-Path -Parent $verifier) "ardia-update-verify.exe"

  $cleanEngine = New-Folder "clean-engine"
  Touch $cleanEngine "chrome.exe", "chrome.dll"

  $pilot = Join-Path $scratch "out-pilot"
  & $assemble -Engine $engine -Ui $ui -Out $pilot | Out-Null
  Check "a pilot assembly keeps chrome.exe" $true (Test-Path -LiteralPath (Join-Path $pilot "chrome.exe"))
  Check "a pilot assembly copies the UI as ardia-ui" $true (Test-Path -LiteralPath (Join-Path $pilot "ardia-ui\assets\app.js"))
  Check "a pilot assembly leaves out the engine's notes" $false (Test-Path -LiteralPath (Join-Path $pilot "RUN.txt"))
  Check "a pilot assembly without -TestBuild drops the engine's test marker" $false (Test-Path -LiteralPath (Join-Path $pilot "Ardia.test-build"))
  Check "a pilot assembly bundles no migrator unless asked" $false (Test-Path -LiteralPath (Join-Path $pilot "ardia-webui-migrate.exe"))
  Check "a pilot assembly copies the engine's folders" $true (Test-Path -LiteralPath (Join-Path $pilot "locales\en-US.pak"))

  $tested = Join-Path $scratch "out-test"
  & $assemble -Engine $engine -Ui $ui -Out $tested -MigrateBin $migrator -TestBuild | Out-Null
  Check "-TestBuild writes the marker" $true (Test-Path -LiteralPath (Join-Path $tested "Ardia.test-build"))
  Check "-MigrateBin bundles the migrator" $true (Test-Path -LiteralPath (Join-Path $tested "ardia-webui-migrate.exe"))
  Check "an assembly bundles no update verifier unless asked" $false (Test-Path -LiteralPath (Join-Path $tested "ardia-update-verify.exe"))

  $verified = Join-Path $scratch "out-verified"
  & $assemble -Engine $engine -Ui $ui -Out $verified -UpdateVerify $verifier | Out-Null
  Check "-UpdateVerify bundles the verifier" $true (Test-Path -LiteralPath (Join-Path $verified "ardia-update-verify.exe"))
  Check "-UpdateVerify bundles the pinned key from scripts/windows" ([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "windows-update.pem"))) ([System.IO.File]::ReadAllText((Join-Path $verified "windows-update.pem")))

  Check-Throws "an assembly into a folder that is not empty is refused" "is not empty" { & $assemble -Engine $engine -Ui $ui -Out $pilot }
  Check-Throws "a shippable assembly without the migrator is refused" "needs -MigrateBin" { & $assemble -Engine $cleanEngine -Ui $ui -Out (Join-Path $scratch "out-a") -Shippable -Build 1 }
  Check-Throws "a shippable assembly without the update verifier is refused" "needs -UpdateVerify" { & $assemble -Engine $cleanEngine -Ui $ui -Out (Join-Path $scratch "out-j") -Shippable -MigrateBin $migrator -Build 1 }
  Check-Throws "a missing update verifier is refused" "was not found" { & $assemble -Engine $engine -Ui $ui -Out (Join-Path $scratch "out-k") -UpdateVerify (Join-Path $scratch "nothing.exe") }
  Check-Throws "a shippable assembly that keeps chrome.exe is refused" "starts from Ardia.exe" { & $assemble -Engine $cleanEngine -Ui $ui -Out (Join-Path $scratch "out-b") -Shippable -LauncherName chrome.exe -MigrateBin $migrator -Build 1 }
  Check-Throws "a shippable assembly without a build number is refused" "needs -Build above 0" { & $assemble -Engine $cleanEngine -Ui $ui -Out (Join-Path $scratch "out-g") -Shippable -MigrateBin $migrator }
  Check-Throws "a shippable assembly marked as a test build is refused" "never carries Ardia.test-build" { & $assemble -Engine $cleanEngine -Ui $ui -Out (Join-Path $scratch "out-h") -Shippable -TestBuild -MigrateBin $migrator -Build 1 }
  Check-Throws "a shippable assembly from an engine with a test marker is refused" "carries Ardia.test-build" { & $assemble -Engine $engine -Ui $ui -Out (Join-Path $scratch "out-i") -Shippable -MigrateBin $migrator -Build 1 }
  Check "a refused shippable assembly writes nothing" $false ((Test-Path -LiteralPath (Join-Path $scratch "out-g")) -or (Test-Path -LiteralPath (Join-Path $scratch "out-h")) -or (Test-Path -LiteralPath (Join-Path $scratch "out-i")) -or (Test-Path -LiteralPath (Join-Path $scratch "out-j")) -or (Test-Path -LiteralPath (Join-Path $scratch "out-k")))
  Check-Throws "a launcher name with a path is refused" "is not a plain .exe name" { & $assemble -Engine $engine -Ui $ui -Out (Join-Path $scratch "out-c") -LauncherName "..\Ardia.exe" }
  Check-Throws "a missing migrator is refused" "was not found" { & $assemble -Engine $engine -Ui $ui -Out (Join-Path $scratch "out-d") -MigrateBin (Join-Path $scratch "nothing.exe") }
  Check-Throws "a missing app icon is refused" "is not a file" { & $assemble -Engine $engine -Ui $ui -Out (Join-Path $scratch "out-e") -AppIcon (Join-Path $scratch "nothing.ico") }
  $withApp = New-Folder "engine-with-app"
  Touch $withApp "chrome.exe", "chrome.dll", "ArdiaApp.dll"
  Check-Throws "an engine that holds the React Native app is refused" "holds the React Native app" { & $assemble -Engine $withApp -Ui $ui -Out (Join-Path $scratch "out-f") }
  Check "nothing was written for a refused assembly" $false (Test-Path -LiteralPath (Join-Path $scratch "out-a"))

  $installer = Join-Path $PSScriptRoot "make-installer.ps1"
  Check-Throws "the installer refuses a WebUI build without the migrator" "is not a shippable WebUI build" { & $installer -Source $noMigrator -Out (Join-Path $scratch "setup") -Cpu x64 -Version 1.0.0 }
  Check-Throws "the installer refuses a WebUI build without Ardia.build.json" "has no Ardia.build.json" { & $installer -Source $noIdentity -Out (Join-Path $scratch "setup") -Cpu x64 -Version 1.0.0 }
  Check-Throws "the installer refuses a WebUI build that still holds React Native files" "still holds 3 of the rnw shell's files" { & $installer -Source $leftover -Out (Join-Path $scratch "setup") -Cpu x64 -Version 1.0.0 }
  Check-Throws "the installer refuses a folder that is both shells" "neither the React Native shell nor the WebUI shell" { & $installer -Source $mixed -Out (Join-Path $scratch "setup") -Cpu x64 -Version 1.0.0 }
  Check-Throws "the installer refuses a React Native build" "is the rnw shell, not the webui shell" { & $installer -Source $rnw -Out (Join-Path $scratch "setup") -Cpu x64 -Version 1.0.0 }
  Check-Throws "the installer refuses a WebUI build with a test marker" "Ardia.test-build marker" { & $installer -Source $marked -Out (Join-Path $scratch "setup") -Cpu x64 -Version 1.0.0 }

  $script = Get-Content -LiteralPath (Join-Path $PSScriptRoot "installer\Ardia.iss") -Raw
  Check "the installer script is the WebUI shell's only" $true ($script -match '^#define Shell "webui"\s+#define LaunchSwitch "--ardia-shell=webui"\s+#define OpenSuffix " --ardia-shell=webui"\s+#define ShellMarker "ardia-ui\\index.html"\s+#define RetiredShell "rnw"\s+#define RetiredMarker "ArdiaApp.dll"')
  Check "the installer script takes no shell from its caller" $false ($script -match '#ifndef Shell|#if Shell|#else')
  Check "the other shell's files go only after this shell's files are installed" $true ($script -match "else if CurStep = ssPostInstall then\s+RemoveFilesNoLongerShipped;")
  Check "the install step only notes what is there before the copy" $true ($script -match "if CurStep = ssInstall then\s+NoteInstalledShells")
  Check "before the copy it notes the other shell and reads this shell's last manifest" $true ($script -match "(?s)procedure NoteInstalledShells;.*RetiredShellFound := FileExists\(Folder \+ '\\\{#RetiredMarker\}'\).*PreviousOwnFound := ReadManifest\(Folder, 'ardia-\{#Shell\}-files.txt', PreviousOwn\);")
  Check "folders go only once they are empty and nothing on their path is a link" $true ($script -match "if not PathWithoutLinks\(Folder, Relative\) then Break;\s+if not RemoveDir\(Dir\) then Break;")
  Check "the other shell's own manifest comes before the fallback list" $true ($script -match "(?s)Manifest := 'ardia-\{#RetiredShell\}-files.txt';\s+FromManifest := FileExists\(Folder \+ '\\' \+ Manifest\);.*ExtractTemporaryFile\('retired-shell.txt'\)")
  Check "attributes come from GetFileAttributesW" $true ($script -match "external 'GetFileAttributesW@kernel32.dll stdcall';")
  Check "a reparse point is the attribute 0x400" $true ($script -match "ReparsePointAttribute = \`$400;")
  Check "the install folder, every folder on the way and the target must not be links" $true ($script -match "(?s)function PathWithoutLinks\(Folder, Relative: String\): Boolean;.*if IsReparsePoint\(Folder\) then Exit;.*if IsReparsePoint\(Path\) then Exit;.*Result := not IsReparsePoint\(Path \+ '\\' \+ Rest\);")
  Check "a file is deleted only when nothing on its path is a link" $true ($script -match "(?s)procedure RemoveOwnedFile.*if not PathWithoutLinks\(Folder, Relative\) then.*if DeleteFile\(Path\) then")
  Check "a manifest on disk is read only when it is not behind a link" $true ($script -match "(?s)function ReadManifest.*if not PathWithoutLinks\(Folder, Name\) then.*LoadStringsFromFile\(Folder \+ '\\' \+ Name, Entries\)")
  Check "installed manifests take exact paths only, wildcards only from the fixed list" $true ($script -match "if ExactEntryValid\(Entry\) then\s+RemoveOwnedFile\(Folder, Entry, Removed, Failed\)\s+else if not FromManifest and OwnedEntryValid\(Entry\) and \(Copy\(Entry, 1, 2\) = '\*\\'\) then")
  Check "an exact entry has no * or ?" $true ($script -match "Result := OwnedEntryValid\(Entry\) and \(Pos\('\*', Entry\) = 0\) and \(Pos\('\?', Entry\) = 0\);")
  Check "an update of the same shell removes files only the last build listed" $true ($script -match "if ExactEntryValid\(Entry\) and not InList\(Kept, Entry\) then\s+RemoveOwnedFile")
  Check "a file that can't be removed stays in the manifest" $true (($script -match "(?s)procedure KeepOwnership.*SaveStringToFile\(Path, Failed\[I\] \+ #13#10, True\)") -and ($script -match "KeepOwnership\(Folder \+ '\\' \+ Manifest, Failed\);"))
  Check "the cleanup refuses an install folder that is a link" $true ($script -match "if IsReparsePoint\(Folder\) then\s+begin\s+Log\('Owned files: ' \+ Folder \+ ' is a link, so no file is removed'\);")
  $listedInstall = New-Folder "listed-install"
  Touch $listedInstall "Ardia.exe", "chrome.dll", "Ardia.build.json", "ardia-update-verify.exe", "windows-update.pem", "ardia-ui\index.html", "ardia-ui\assets\index-NEW.js", "ardia-ui\assets\index-OLD.js", "ardia-webui-migrate.exe"
  [System.IO.File]::WriteAllText((Join-Path $listedInstall "ardia-webui-files.txt"), "ardia-ui\index.html`r`nARDIA-UI\assets\index-NEW.js`r`nardia-webui-migrate.exe`r`n")
  Check "files in a shell's folders that its manifest doesn't list are found, ignoring case" "ardia-ui\assets\index-OLD.js" ((Find-UnlistedOwnedFiles $listedInstall "webui") -join ",")
  Check "an install holding a file its manifest doesn't list fails the layout check" "it holds 1 files in its own folders that ardia-webui-files.txt doesn't list: ardia-ui\assets\index-OLD.js" ((Get-ShellLayoutProblems $listedInstall "webui") -join "|")
  Check "a folder without a manifest has nothing unlisted" 0 (Find-UnlistedOwnedFiles $webui "webui").Count
  Check "nothing is deleted before the new files are copied" $false ($script -match "\[InstallDelete\]")
  Check "the cleanup runs only when the other shell was there before the install" $true ($script -match "if not RetiredShellFound then Exit;")
  Check "no folder is deleted with what's inside it" $false ($script -match "DelTree")
  Check "both cleanups keep the files both shells keep" $true (($script -match "(?s)procedure RemoveRetiredShell.*ReadKeptFiles\(Kept\);.*if InList\(Kept, Entry\) then") -and ($script -match "(?s)procedure RemoveStaleOwnFiles.*ReadKeptFiles\(Kept\);"))
  Check "each install carries its own manifest" $true ($script -match 'Source: "\{#ShellManifest\}"; DestDir: "\{app\}"; DestName: "ardia-\{#Shell\}-files.txt"')
  Check "the cleanup stops when this shell's marker is missing" $true ($script -match "if not FileExists\(Folder \+ '\\\{#ShellMarker\}'\) then")
  Check "the cleanup removes only the listed entries" $true ($script -match "LoadStringsFromFile\(ExpandConstant\('\{tmp\}\\retired-shell.txt'\), Entries\)")
  Check "make-installer writes this shell's manifest from the payload" $true ((Get-Content -LiteralPath (Join-Path $PSScriptRoot "make-installer.ps1") -Raw) -match 'Write-ShellManifest \$sourceRoot \$shellKind \$manifest')
  Check "the installer carries the list without installing it" $true ($script -match 'Source: "\{#RetiredList\}"; DestName: "retired-shell.txt"; Flags: dontcopy')
  Check "make-installer hands the installer the retired shell's list" $true ((Get-Content -LiteralPath (Join-Path $PSScriptRoot "make-installer.ps1") -Raw) -match '"/DRetiredList=\$retired"')
} finally {
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count) {
  $failures | ForEach-Object { Write-Host "::error::$_" }
  exit 1
}
Write-Host "The shell layouts, the WebUI assembly and the installer's refusals behave as the packaging expects."
