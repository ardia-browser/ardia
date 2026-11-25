param(
  [string]$Label = 'upgrade',
  [Parameter(Mandatory = $true)][string]$Migrator,
  [string]$RnwApp = '',
  [int]$CrashPoints = 60,
  [switch]$SkipWebUILaunch,
  [string]$RnwInstaller = '',
  [string]$WebUIInstaller = ''
)
. C:\pilot\lib.ps1
$installed = [bool]($RnwInstaller -or $WebUIInstaller)
if ($installed) {
  if (-not $RnwInstaller -or -not $WebUIInstaller) { throw '-RnwInstaller and -WebUIInstaller go together' }
  foreach ($setup in $RnwInstaller, $WebUIInstaller) { if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw "the installer '$setup' is not a file" } }
  $RnwInstaller = (Resolve-Path -LiteralPath $RnwInstaller).Path
  $WebUIInstaller = (Resolve-Path -LiteralPath $WebUIInstaller).Path
  $packaging = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'shell-layout.ps1')) { $PSScriptRoot } else { Split-Path -Parent $PSScriptRoot }
  . (Join-Path $packaging 'shell-layout.ps1')
}
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Security
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RnwWindows {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lparam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  public static int Close(int[] pids) {
    var owners = new HashSet<int>(pids);
    int posted = 0;
    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid); if (owners.Contains((int)pid) && IsWindowVisible(h)) { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); posted++; } return true; }, IntPtr.Zero);
    return posted;
  }
}
public static class RnwVault {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment; public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredEnumerateW(string filter, uint flags, out int count, out IntPtr credentials);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
  public static bool Write(string target, string comment, string user, byte[] blob) {
    CREDENTIAL c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.Comment = comment; c.UserName = user; c.Persist = 2;
    IntPtr memory = Marshal.AllocHGlobal(Math.Max(1, blob.Length));
    try { Marshal.Copy(blob, 0, memory, blob.Length); c.CredentialBlob = blob.Length == 0 ? IntPtr.Zero : memory; c.CredentialBlobSize = (uint)blob.Length; return CredWriteW(ref c, 0); }
    finally { Marshal.FreeHGlobal(memory); }
  }
  static CREDENTIAL At(IntPtr pointer) { return (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL)); }
  static byte[] BlobOf(CREDENTIAL c) { byte[] bytes = new byte[c.CredentialBlobSize]; if (c.CredentialBlobSize > 0) Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length); return bytes; }
  public static byte[] Blob(string target) { IntPtr p; if (!CredReadW(target, 1, 0, out p)) return null; try { return BlobOf(At(p)); } finally { CredFree(p); } }
  public static string Comment(string target) { IntPtr p; if (!CredReadW(target, 1, 0, out p)) return null; try { return At(p).Comment; } finally { CredFree(p); } }
  public static void Delete(string target) { CredDeleteW(target, 1, 0); }
  public static SortedDictionary<string, string> Snapshot(string prefix) {
    var found = new SortedDictionary<string, string>(StringComparer.Ordinal);
    int count; IntPtr list;
    if (!CredEnumerateW(prefix + "*", 0, out count, out list)) return found;
    try {
      for (int i = 0; i < count; i++) {
        CREDENTIAL c = At(Marshal.ReadIntPtr(list, i * IntPtr.Size));
        found[c.TargetName] = (c.Comment ?? "") + "|" + Convert.ToBase64String(BlobOf(c));
      }
    } finally { CredFree(list); }
    return found;
  }
}
"@

$results = New-Object System.Collections.Specialized.OrderedDictionary ([StringComparer]::Ordinal)
function Check([string]$name, [bool]$ok, [string]$detail) {
  $results[$name] = @{ ok = $ok; detail = $detail }
  Log ("{0} {1}: {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail))
}

Remove-Item Env:ARDIA_DATA_DIR, Env:ARDIA_REMOTE_DEBUGGING_PORT, Env:ARDIA_TEST_MIGRATION_STOP_AT_COMMIT -ErrorAction SilentlyContinue
$run = New-PilotRun
$rnw = Join-Path $run 'rnw'
$web = Join-Path $run 'webui'
$outside = Join-Path $run 'outside'
New-Item -ItemType Directory $rnw, $outside | Out-Null
$prefix = "Ardia Connected Accounts [$rnw]/"
$chunkBytes = 2560
$utf8 = New-Object System.Text.UTF8Encoding($false)
Log "$Label with migrator $Migrator, RNW app '$RnwApp', WebUI $App; run $run"

function Bytes([string]$text) { $utf8.GetBytes($text) }
function Pattern([int]$length, [int]$seed) { $b = New-Object byte[] $length; for ($i = 0; $i -lt $length; $i++) { $b[$i] = [byte](($i * 31 + $seed) % 256) }; $b }
function Seal([byte[]]$plain, [string]$purpose) { [Security.Cryptography.ProtectedData]::Protect($plain, (Bytes $purpose), 'CurrentUser') }
function Unseal([byte[]]$sealed, [string]$purpose) { try { [Security.Cryptography.ProtectedData]::Unprotect($sealed, (Bytes $purpose), 'CurrentUser') } catch { $null } }
function Same([byte[]]$a, [byte[]]$b) { ($a -ne $null) -and ($b -ne $null) -and ($a.Length -eq $b.Length) -and ([Convert]::ToBase64String($a) -eq [Convert]::ToBase64String($b)) }
function Put([string]$path, [byte[]]$bytes) { New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null; [IO.File]::WriteAllBytes($path, $bytes) }
function Hex([string]$text) { (($utf8.GetBytes($text) | ForEach-Object { '{0:x2}' -f $_ }) -join '') }

function Write-Rnw([string]$account, [byte[]]$secret, [int]$generation, [string]$namespace = $prefix) {
  $base = $namespace + $account
  $chunks = [Math]::Max(1, [Math]::Ceiling($secret.Length / $chunkBytes))
  for ($i = 1; $i -lt $chunks; $i++) {
    $start = $i * $chunkBytes
    $part = $secret[$start..([Math]::Min($secret.Length, $start + $chunkBytes) - 1)]
    $target = if ($generation -eq 0) { "$base#$i" } else { "$base#g$generation#$i" }
    if (-not [RnwVault]::Write($target, $null, $account, [byte[]]$part)) { throw "CredWrite $target failed" }
  }
  $first = if ($secret.Length -eq 0) { [byte[]]@() } else { [byte[]]$secret[0..([Math]::Min($secret.Length, $chunkBytes) - 1)] }
  $comment = if ($generation -eq 0) { "Ardia $chunks" } else { "Ardia g$generation $chunks" }
  if (-not [RnwVault]::Write($base, $comment, $account, $first)) { throw "CredWrite $base failed" }
}

function Read-Rnw([string]$account, [string]$namespace = $prefix) {
  $base = $namespace + $account
  $first = [RnwVault]::Blob($base)
  if ($first -eq $null) { return $null }
  $comment = [RnwVault]::Comment($base)
  $generation = 0; $chunks = 1
  if ($comment -match ' g([12]) ') { $generation = [int]$Matches[1] }
  if ($comment -match ' (\d+)$' -and [int]$Matches[1] -ge 1 -and [int]$Matches[1] -le 64) { $chunks = [int]$Matches[1] }
  $all = New-Object System.Collections.Generic.List[byte]
  $all.AddRange([byte[]]$first)
  for ($i = 1; $i -lt $chunks; $i++) {
    $target = if ($generation -eq 0) { "$base#$i" } else { "$base#g$generation#$i" }
    $part = [RnwVault]::Blob($target)
    if ($part -eq $null) { return $null }
    $all.AddRange([byte[]]$part)
  }
  $all.ToArray()
}

function Tree-Snapshot([string]$root) {
  $found = [ordered]@{}
  if (-not (Test-Path -LiteralPath $root)) { return $found }
  Get-ChildItem -LiteralPath $root -Recurse -Force | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($root.Length)
    if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { $found[$relative] = 'link' }
    elseif ($_.PSIsContainer) { $found[$relative] = 'folder' }
    else { $found[$relative] = "$($_.Length) $((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash) $($_.LastWriteTimeUtc.Ticks)" }
  }
  $found
}

function Same-Snapshot($a, $b) { ($a | ConvertTo-Json -Depth 3 -Compress) -eq ($b | ConvertTo-Json -Depth 3 -Compress) }

function Migrate([string[]]$extra = @(), [string]$webui = $web, [string]$source = $rnw) {
  $arguments = @('--from-rnw', '--rnw-data', $source, '--webui-data', $webui, '--test-instance') + $extra
  $output = & $Migrator @arguments 2>&1
  $code = $LASTEXITCODE
  $report = $null
  try { $report = ($output | Where-Object { $_ -is [string] -and $_.StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json } catch {}
  [pscustomobject]@{ code = $code; report = $report; text = ($output -join "`n") }
}

function Clear-WebUI([string]$folder = $web) {
  if (-not (Test-Path -LiteralPath $folder)) { return }
  Get-ChildItem -LiteralPath $folder -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue |
    ForEach-Object { if ($_.PSIsContainer) { cmd /c rmdir "$($_.FullName)" | Out-Null } else { Remove-Item -LiteralPath $_.FullName -Force } }
  Remove-Item -LiteralPath $folder -Recurse -Force
}

function All-Processes {
  try {
    @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    throw "the process list can't be read, so it can't be shown that the RNW build stopped: $($_.Exception.Message)"
  }
}

function Rnw-Running {
  $folder = (Resolve-Path -LiteralPath $RnwApp -ErrorAction Stop).Path.TrimEnd('\') + '\'
  $all = All-Processes
  $unverified = @($all | Where-Object { -not $_.ExecutablePath -and $_.Name -match '^Ardia' })
  if ($unverified.Count) {
    throw "$($unverified.Count) Ardia processes whose program can't be read (another user's, or protected): $(($unverified | ForEach-Object { "$($_.Name) $($_.ProcessId)" }) -join ', ')"
  }
  @($all | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($folder, [StringComparison]::OrdinalIgnoreCase) })
}

function Allowed-Roots {
  @($installDir, $RnwApp, $script:App) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | ForEach-Object { (Resolve-Path -LiteralPath $_).Path }
}

function Under-Folder($process, [string[]]$folders) {
  if (-not $process.ExecutablePath) { return $false }
  foreach ($folder in $folders) {
    if ($folder -and $process.ExecutablePath.StartsWith($folder.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  $false
}

function Track-Launched($process) {
  $snapshot = $null
  try { $snapshot = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$process.Id)" -ErrorAction Stop } catch {}
  $tracked = [pscustomobject]@{ Id = [int]$process.Id; Created = $(if ($snapshot) { $snapshot.CreationDate } else { $null }) }
  $script:Launched.Add($tracked)
  $tracked
}

function Tracked-For($process) {
  @($script:Launched | Where-Object { $_.Id -eq [int]$process.Id }) | Select-Object -Last 1
}

function Verified-Tree($tracked) {
  if (-not $tracked -or -not $tracked.Created) { return @() }
  $all = All-Processes
  $roots = Allowed-Roots
  $root = $all | Where-Object { [int]$_.ProcessId -eq $tracked.Id } | Select-Object -First 1
  if ($root -and $root.CreationDate -ne $tracked.Created) { return @() }
  $tree = @{ $tracked.Id = $tracked.Created }
  do {
    $grew = $false
    foreach ($process in $all) {
      $id = [int]$process.ProcessId
      $parentId = [int]$process.ParentProcessId
      if ($tree.ContainsKey($id) -or -not $tree.ContainsKey($parentId)) { continue }
      if (-not $process.CreationDate -or $process.CreationDate -lt $tree[$parentId] -or -not (Under-Folder $process $roots)) { continue }
      $tree[$id] = $process.CreationDate
      $grew = $true
    }
  } while ($grew)
  @($all | Where-Object { $tree.ContainsKey([int]$_.ProcessId) -and (Under-Folder $_ $roots) })
}

function Stop-VerifiedProcess($process) {
  $id = [int]$process.ProcessId
  $live = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
  if (-not $live -or $live.CreationDate -ne $process.CreationDate -or -not (Under-Folder $live (Allowed-Roots))) { return $false }
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  $true
}

function Stop-VerifiedTree($tracked) {
  $stopped = 0
  foreach ($process in @(Verified-Tree $tracked)) { if (Stop-VerifiedProcess $process) { $stopped++ } }
  $stopped
}

function Stop-PilotEngine {
  $roots = Allowed-Roots
  foreach ($process in @(All-Processes | Where-Object { ([Pilot]::IsTracked([int]$_.ProcessId)) -and (Under-Folder $_ $roots) })) {
    Stop-VerifiedProcess $process | Out-Null
  }
  Wait-Until { @(All-Processes | Where-Object { ([Pilot]::IsTracked([int]$_.ProcessId)) -and (Under-Folder $_ $roots) }).Count -eq 0 } 15 'the engine processes to exit' -NoThrow | Out-Null
}

function Run-Rnw([int]$Milliseconds) {
  $env:ARDIA_DATA_DIR = $rnw
  $env:ARDIA_BACKGROUND = '1'
  try {
    $started = Start-Process (Join-Path $RnwApp 'Ardia.exe') -PassThru
  } finally {
    Remove-Item Env:ARDIA_DATA_DIR, Env:ARDIA_BACKGROUND -ErrorAction SilentlyContinue
  }
  $tracked = Track-Launched $started
  Hold $Milliseconds
  $alive = -not $started.HasExited
  Stop-VerifiedTree $tracked | Out-Null
  Wait-Until { @(Verified-Tree $tracked).Count -eq 0 } 20 'the RNW processes this run started to exit' -NoThrow | Out-Null
  $alive
}

function Assert-RnwStopped([string]$when) {
  if (-not $RnwApp) { return }
  try {
    $left = Rnw-Running
  } catch {
    Check "rnw-stopped-$when" $false "$($_.Exception.Message)"
    throw
  }
  Check "rnw-stopped-$when" ($left.Count -eq 0) "processes running from $RnwApp $when`: $(($left | ForEach-Object { "$($_.Name) $($_.ProcessId)" }) -join ', ')"
  if ($left.Count) { throw "the RNW build is still running from $RnwApp; not migrating against a live profile" }
}

$installDir = Join-Path $run 'install'
$uninstallEntry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{47A92F18-32B0-4548-A1EF-72C217FE1836}_is1'
$startMenuLink = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Ardia.lnk'
$rnwInstalled = Join-Path $run 'rnw-installed'
$installedPrefix = "Ardia Connected Accounts [$rnwInstalled]/"
$installedKeyPurpose = 'ardia-sync-key/v1/acct1'
$installedSecretPurpose = 'ardia-connected-account/v1/'
$exitIncomplete = 75
$Launched = New-Object System.Collections.Generic.List[object]

function Prior-Ardia {
  $found = @()
  if (Test-Path -LiteralPath $uninstallEntry) { $found += 'its uninstall entry' }
  if (Test-Path -LiteralPath $startMenuLink) { $found += 'its Start Menu shortcut' }
  if (Test-Path -LiteralPath 'HKCU:\Software\Clients\StartMenuInternet\Ardia') { $found += 'StartMenuInternet\Ardia' }
  if (Test-Path -LiteralPath 'HKCU:\Software\Classes\ArdiaHTM') { $found += 'the ArdiaHTM ProgID' }
  $userData = Join-Path $env:LOCALAPPDATA 'Ardia\User Data'
  if (Test-Path -LiteralPath $userData) { $found += $userData }
  $webuiData = Join-Path $env:LOCALAPPDATA 'Ardia WebUI'
  if (Test-Path -LiteralPath $webuiData) { $found += $webuiData }
  ,$found
}

function Installed-Processes {
  if (-not (Test-Path -LiteralPath $installDir)) { return ,@() }
  $folder = $installDir.TrimEnd('\') + '\'
  ,@(All-Processes | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($folder, [StringComparison]::OrdinalIgnoreCase) })
}

function Stop-Launched {
  $stopped = 0
  foreach ($tracked in $script:Launched.ToArray()) {
    try { $stopped += Stop-VerifiedTree $tracked } catch { Log "the processes started from $($tracked.Id) could not be listed: $($_.Exception.Message)" }
  }
  if ($installed) {
    try {
      foreach ($process in (Installed-Processes)) { if (Stop-VerifiedProcess $process) { $stopped++ } }
    } catch { Log "the processes running from $installDir could not be listed: $($_.Exception.Message)" }
  }
  $stopped
}

function Invoke-Setup([string]$setup) {
  $started = Get-Date
  $process = Start-Process -FilePath $setup -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$installDir`"" -Wait -PassThru
  [pscustomobject]@{ code = $process.ExitCode; ms = [int]((Get-Date) - $started).TotalMilliseconds }
}

function Shortcut-Facts {
  if (-not (Test-Path -LiteralPath $startMenuLink -PathType Leaf)) { return $null }
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($startMenuLink)
  $id = (New-Object -ComObject Shell.Application).NameSpace((Split-Path -Parent $startMenuLink)).ParseName((Split-Path -Leaf $startMenuLink)).ExtendedProperty('System.AppUserModel.ID')
  [pscustomobject]@{ target = $link.TargetPath; arguments = $link.Arguments; icon = ($link.IconLocation -split ',')[0]; id = $id }
}

function Check-InstalledLayout([string]$name, [string]$shell, $setup) {
  $found = Get-ShellLayout $installDir
  $problems = if ($found -eq $shell) { Get-ShellLayoutProblems $installDir $shell } else { @("the install is the $found shell") }
  $link = Shortcut-Facts
  $want = Get-ShellLaunchSwitch $shell
  $linkOk = $link -and ((Split-Path -Leaf $link.target) -eq 'Ardia.exe') -and ($link.arguments -eq $want) -and ($link.id -eq $ShellLayout.AppUserModelId) -and (Test-Path -LiteralPath $link.icon -PathType Leaf)
  Check $name ($setup.code -eq 0 -and $problems.Count -eq 0 -and $linkOk) "setup exit $($setup.code) in $($setup.ms) ms; $shell layout problems: $($problems -join '; '); Start Menu shortcut $(if ($link) { "$($link.target) '$($link.arguments)' $($link.id)" } else { 'missing' })"
}

function Install-Rnw {
  $prior = Prior-Ardia
  Check 'no-prior-install' ($prior.Count -eq 0) "Ardia's install, registration and profiles for this user: $(if ($prior.Count) { $prior -join ', ' } else { 'none' })"
  if ($prior.Count) { throw "this user already has Ardia ($($prior -join ', ')); the installed upgrade only runs in a disposable account" }
  $setup = Invoke-Setup $RnwInstaller
  Check-InstalledLayout 'installed-rnw' 'rnw' $setup
  if ($setup.code -ne 0) { throw "the React Native installer exited with $($setup.code)" }
  $script:RnwApp = $installDir
}

function Start-Installed([string]$data, [string[]]$extra) {
  New-Item -ItemType Directory -Force $data | Out-Null
  $env:ARDIA_DATA_DIR = $data
  $env:ARDIA_BACKGROUND = '1'
  try {
    $arguments = @($ShellLayout.WebUISwitch, "--user-data-dir=$(Join-Path $data 'Chromium')") + $extra
    $process = Start-Process (Join-Path $installDir 'Ardia.exe') -ArgumentList (Join-Arguments $arguments) -PassThru
  } finally {
    Remove-Item Env:ARDIA_DATA_DIR, Env:ARDIA_BACKGROUND -ErrorAction SilentlyContinue
  }
  $null = $process.Handle
  [Pilot]::Roots.Add($process.Id) | Out-Null
  Track-Launched $process | Out-Null
  $process
}

function Exit-Code($process, [int]$seconds) {
  if ($process.WaitForExit($seconds * 1000)) { return $process.ExitCode }
  Stop-VerifiedTree (Tracked-For $process) | Out-Null
  Stop-PilotEngine
  'timeout'
}

function Close-Tree($process, [int]$seconds = 20) {
  $tracked = Tracked-For $process
  $pids = @(@(Verified-Tree $tracked) | ForEach-Object { [int]$_.ProcessId })
  $posted = if ($pids.Count) { [RnwWindows]::Close([int[]]$pids) } else { 0 }
  $gone = Wait-Until { @(Verified-Tree $tracked).Count -eq 0 } $seconds 'the app to close its windows and exit' -NoThrow
  $left = @(Verified-Tree $tracked)
  foreach ($stray in $left) { Stop-VerifiedProcess $stray | Out-Null }
  [pscustomobject]@{ posted = $posted; clean = ([bool]$gone -and $posted -gt 0); left = $left.Count }
}

function Run-InstalledRnw([string]$data, [int]$Milliseconds) {
  $env:ARDIA_DATA_DIR = $data
  $env:ARDIA_BACKGROUND = '1'
  try {
    $started = Start-Process (Join-Path $installDir 'Ardia.exe') -PassThru
  } finally {
    Remove-Item Env:ARDIA_DATA_DIR, Env:ARDIA_BACKGROUND -ErrorAction SilentlyContinue
  }
  Track-Launched $started | Out-Null
  Hold $Milliseconds
  $alive = -not $started.HasExited
  $closed = Close-Tree $started
  [pscustomobject]@{ alive = $alive; clean = $closed.clean; posted = $closed.posted; left = $closed.left }
}

function Seed-InstalledRnw {
  Put "$rnwInstalled\session.json" (Bytes '{"version":7,"tabs":[{"id":"installed-tab","page":{"url":"file:///C:/pilot/form.html"}}],"windows":[],"windowOrder":[]}')
  Put "$rnwInstalled\history-index.json" (Bytes '{"pages":5}')
  Put "$rnwInstalled\bookmarks.json" (Bytes '{"roots":[{"title":"Pilot","url":"file:///C:/pilot/form.html"}]}')
  Put "$rnwInstalled\extensions.json" (Bytes '{"installed":["pilot-extension"]}')
  Put "$rnwInstalled\window-placement.txt" (Bytes '140 90 1200 760 0')
  Put "$rnwInstalled\config\config.json" (Bytes '{"theme":"dawn"}')
  Put "$rnwInstalled\config\themes\dawn.json" (Bytes '{"name":"dawn"}')
  Put "$rnwInstalled\Chromium\Default\Cookies" (Pattern 4096 17)
  Put "$rnwInstalled\Chromium\Default\Login Data" (Pattern 2048 18)
  Put "$rnwInstalled\Sync\sync-key-acct1.dpapi" (Seal $syncKey $installedKeyPurpose)
  foreach ($account in $secrets.Keys) { Write-Rnw $account $secrets[$account].bytes $secrets[$account].generation $installedPrefix }
}

function Installed-Readable { @($secrets.Keys | Where-Object { Same (Read-Rnw $_ $installedPrefix) $secrets[$_].bytes }).Count }

function Test-ForcedFailure([string]$name, [string[]]$extra, [scriptblock]$prepare, [string]$what) {
  $data = Join-Path $run "webui-$name"
  New-Item -ItemType Directory -Force $data | Out-Null
  if ($prepare) { & $prepare $data }
  $rnwBefore = Tree-Snapshot $rnwInstalled
  $outsideBefore = Tree-Snapshot $outside
  $process = Start-Installed $data $extra
  $opened = -not (Never { (Shell-Window) -ne [IntPtr]::Zero } 8)
  $code = Exit-Code $process 90
  $stray = Wait-Until { (Installed-Processes).Count -eq 0 } 15 'every process of the failed start to exit' -NoThrow
  $left = @(Installed-Processes | ForEach-Object { "$($_.Name) $($_.ProcessId)" })
  Stop-Launched | Out-Null
  Stop-PilotEngine
  $markerLeft = Test-Path -LiteralPath (Join-Path $data 'rnw-migration.json')
  $untouched = (Same-Snapshot $rnwBefore (Tree-Snapshot $rnwInstalled)) -and (Same-Snapshot $outsideBefore (Tree-Snapshot $outside))
  Check "forced-failure-$name" (("$code" -eq "$exitIncomplete") -and -not $opened -and -not $markerLeft -and $untouched -and [bool]$stray) "$what`: exit $code of the launched process itself (want $exitIncomplete), window opened $opened, marker written $markerLeft, RNW profile and outside folder unchanged $untouched, processes left running: $(if ($left.Count) { $left -join ', ' } else { 'none' })"
}

function Test-SameShellUpdate {
  $manifest = Join-Path $installDir (Get-ShellManifestName 'webui')
  $stale = 'ardia-ui\assets\stale-from-last-build.js'
  $linked = 'ardia-ui\assets\linked-outside'
  $linkedEntry = "$linked\keep.txt"
  $userFile = Join-Path $installDir 'ardia-ui\user-notes.txt'
  $outsideKeep = Join-Path $run 'outside-installed'
  New-Item -ItemType Directory -Force $outsideKeep | Out-Null
  Put "$outsideKeep\keep.txt" (Bytes 'not the installer''s')
  Put (Join-Path $installDir $stale) (Bytes 'from the last build')
  Put $userFile (Bytes 'mine')
  cmd /c mklink /J "$(Join-Path $installDir $linked)" "$outsideKeep" | Out-Null
  Add-Content -LiteralPath $manifest -Value @($stale, $linkedEntry)
  $setup = Invoke-Setup $WebUIInstaller
  $listed = @(Get-Content -LiteralPath $manifest | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $staleGone = -not (Test-Path -LiteralPath (Join-Path $installDir $stale))
  Check 'same-shell-update-removes-stale-files' ($setup.code -eq 0 -and $staleGone -and $listed -notcontains $stale) "reinstalling the WebUI build: exit $($setup.code); a file only the last build's manifest listed is gone: $staleGone, and dropped from the manifest: $($listed -notcontains $stale)"
  Check 'same-shell-update-never-follows-links' ((Test-Path -LiteralPath "$outsideKeep\keep.txt") -and ($listed -contains $linkedEntry)) "a manifest entry behind a junction left the outside file alone and stays listed so a later install retries it"
  Check 'same-shell-update-keeps-unlisted-files' (Test-Path -LiteralPath $userFile) "a file no manifest lists stays in ardia-ui"
  cmd /c rmdir "$(Join-Path $installDir $linked)" | Out-Null
  Remove-Item -LiteralPath $userFile -Force -ErrorAction SilentlyContinue
  $kept = @(Get-Content -LiteralPath $manifest | Where-Object { $_.Trim() -and $_.Trim() -ne $linkedEntry })
  [IO.File]::WriteAllText($manifest, (($kept -join "`r`n") + "`r`n"), $utf8)
}

function Test-InstalledUpgrade {
  $pilotApp = $App
  Use-App $installDir
  New-Item -ItemType Directory -Force $rnwInstalled | Out-Null
  Seed-InstalledRnw
  Assert-RnwStopped 'before-installed-run'
  $first = Run-InstalledRnw $rnwInstalled 15000
  Check 'installed-rnw-runs' ($first.alive -and (Test-Path "$rnwInstalled\session.json")) "the installed React Native build ran on its seeded profile for 15 s (running at the end: $($first.alive))"
  Check 'installed-rnw-clean-exit' ($first.clean -and $first.left -eq 0) "WM_CLOSE to $($first.posted) windows ended every process; $($first.left) had to be stopped"
  Assert-RnwStopped 'before-installed-upgrade'
  $rnwBefore = Tree-Snapshot $rnwInstalled
  $vaultBefore = [RnwVault]::Snapshot($installedPrefix)

  $setup = Invoke-Setup $WebUIInstaller
  Check-InstalledLayout 'installed-webui-over-rnw' 'webui' $setup
  $identity = $null
  try { & (Join-Path $packaging 'launcher-identity.ps1') -Icon (Join-Path $installDir 'Ardia.ico') -To (Join-Path $installDir 'Ardia.exe') -Check | Out-Null; $identity = $LASTEXITCODE } catch { $identity = $_.Exception.Message }
  Check 'installed-webui-identity' ("$identity" -eq '0') "launcher-identity -Check on the installed Ardia.exe: $identity"
  $entry = Get-ItemProperty -LiteralPath $uninstallEntry -ErrorAction SilentlyContinue
  Check 'installed-webui-uninstall-entry' ($entry -and $entry.DisplayName -eq 'Ardia' -and (Test-Path -LiteralPath (($entry.DisplayIcon -split ',')[0].Trim('"')) -PathType Leaf)) "uninstall entry '$($entry.DisplayName)' $($entry.DisplayVersion), icon '$($entry.DisplayIcon)'"
  Test-SameShellUpdate
  $sameShell = Get-ShellLayoutProblems $installDir 'webui'
  Check 'same-shell-update-layout' ($sameShell.Count -eq 0) "the WebUI install after the update and the cleanup of its test files: $(if ($sameShell.Count) { $sameShell -join '; ' } else { 'no problems' })"

  Test-ForcedFailure 'incomplete-request' @('--ardia-migrate-from-rnw') $null '--ardia-migrate-from-rnw under ARDIA_DATA_DIR without --ardia-migrate-rnw-data'
  Test-ForcedFailure 'junction-target' @('--ardia-migrate-from-rnw', "--ardia-migrate-rnw-data=$rnwInstalled") { param($data) cmd /c mklink /J "$data\Secrets" "$outside" | Out-Null } 'a junction at Secrets in the WebUI folder'
  Check 'forced-failures-leave-rnw' ((Same-Snapshot $rnwBefore (Tree-Snapshot $rnwInstalled)) -and (([RnwVault]::Snapshot($installedPrefix) | ConvertTo-Json -Compress) -eq ($vaultBefore | ConvertTo-Json -Compress))) 'the failed starts changed no file in the RNW profile and no Credential Manager item'

  $web = Join-Path $run 'webui-installed'
  $script:Data = $web
  $process = Start-Installed $web @('--ardia-migrate-from-rnw', "--ardia-migrate-rnw-data=$rnwInstalled")
  $window = $null
  try { $window = Wait-Shell 90 } catch {}
  $opened = ($window -ne $null) -and ($window -ne [IntPtr]::Zero)
  $closed = Close-Tree $process 30
  Stop-PilotEngine
  $marker = Join-Path $web 'rnw-migration.json'
  $attemptFile = Join-Path $web 'rnw-migration-attempt.json'
  $attempt = $null
  try { $attempt = Get-Content -LiteralPath $attemptFile -Raw | ConvertFrom-Json } catch {}
  Check 'installed-webui-migrates' ($opened -and (Test-Path -LiteralPath $marker) -and $attempt -and @('migrated', 'migrated_with_skips') -contains $attempt.outcome) "Ardia.exe --ardia-shell=webui --ardia-migrate-from-rnw opened its window: $opened; marker $(Test-Path -LiteralPath $marker); attempt outcome $($attempt.outcome)"
  Check 'installed-webui-clean-exit' ($closed.clean -and $closed.left -eq 0) "WM_CLOSE to $($closed.posted) windows ended every process; $($closed.left) had to be stopped"
  $attemptText = if (Test-Path -LiteralPath $attemptFile) { Get-Content -LiteralPath $attemptFile -Raw } else { '' }
  Check 'installed-telemetry-report' ($attempt -and $attempt.attempt -ge 1 -and $null -ne $attempt.duration_ms -and $null -ne $attempt.counts -and ($attemptText -notmatch '[\\/]') -and ($attemptText -notmatch 'acct1|github|pilot')) "the attempt report shell_migration sends: $attemptText"
  $docs = @('session.json', 'history-index.json', 'bookmarks.json', 'extensions.json', 'window-placement.txt') | Where-Object { -not (Test-Path -LiteralPath "$web\$_") -or -not (Same ([IO.File]::ReadAllBytes("$rnwInstalled\$_")) ([IO.File]::ReadAllBytes("$web\$_"))) }
  Check 'installed-documents' ($docs.Count -eq 0) "tabs, history, bookmarks, extensions and window placement byte for byte; different: $($docs -join ', ')"
  $keyFile = "$web\Sync\sync-key-x$(Hex 'acct1').dpapi"
  Check 'installed-sync-key' ((Test-Path -LiteralPath $keyFile) -and (Same (Unseal ([IO.File]::ReadAllBytes($keyFile)) $installedKeyPurpose) $syncKey)) "the sealed sync key unseals for its account under the WebUI name"
  $wrong = @($secrets.Keys | Where-Object { $file = "$web\Secrets\account-x$(Hex $_).dpapi"; -not ((Test-Path -LiteralPath $file) -and (Same (Unseal ([IO.File]::ReadAllBytes($file)) "$installedSecretPurpose$_") $secrets[$_].bytes)) })
  Check 'installed-credentials' ($wrong.Count -eq 0) "every Credential Manager account is sealed for the WebUI host; wrong: $($wrong -join ', ')"
  Check 'installed-user-data-stays' (-not (Test-Path "$web\Chromium\Default\Cookies") -and -not (Test-Path "$web\Chromium\Default\Login Data")) "the React Native shell's cookies and logins stay in its own profile"
  Check 'installed-rnw-untouched' ((Same-Snapshot $rnwBefore (Tree-Snapshot $rnwInstalled)) -and (([RnwVault]::Snapshot($installedPrefix) | ConvertTo-Json -Compress) -eq ($vaultBefore | ConvertTo-Json -Compress))) 'the RNW profile and its Credential Manager items are unchanged after the WebUI shell migrated and ran'

  $back = Invoke-Setup $RnwInstaller
  Check-InstalledLayout 'rollback-reinstall-rnw' 'rnw' $back
  Use-App $pilotApp
  $again = Run-InstalledRnw $rnwInstalled 15000
  Check 'rollback-rnw-launch' ($again.alive -and $again.clean -and $again.left -eq 0) "the reinstalled React Native build opened the untouched profile (running after 15 s: $($again.alive)) and closed cleanly"
  Check 'rollback-rnw-credentials' ((Installed-Readable) -eq $secrets.Count) "the React Native reader still assembles $(Installed-Readable) of $($secrets.Count) accounts"
  Check 'rollback-rnw-sync-key' (Same (Unseal ([IO.File]::ReadAllBytes("$rnwInstalled\Sync\sync-key-acct1.dpapi")) $installedKeyPurpose) $syncKey) 'the React Native sealed sync key still unseals in place'
  Check 'rollback-rnw-session' ((Test-Path "$rnwInstalled\session.json") -and (Get-Content -LiteralPath "$rnwInstalled\session.json" -Raw) -match 'installed-tab|tabs') 'the React Native session is still there to restore'
  Assert-RnwStopped 'after-installed-rollback'

  $uninstalled = Remove-Install
  Check 'installed-uninstalled' $uninstalled "the uninstaller removed $installDir, its entry and the Start Menu shortcut"
}

function Remove-Install {
  $uninstaller = Join-Path $installDir 'unins000.exe'
  if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait | Out-Null
  }
  [bool](Wait-Until { -not (Test-Path -LiteralPath $installDir) -and -not (Test-Path -LiteralPath $uninstallEntry) -and -not (Test-Path -LiteralPath $startMenuLink) } 30 'the uninstaller to finish' -NoThrow)
}

$secrets = [ordered]@{
  'github'       = @{ bytes = (Bytes 'gho_pilot-short-token'); generation = 1 }
  'google-oauth' = @{ bytes = (Pattern ($chunkBytes * 2 + 117) 3); generation = 2 }
  'legacy'       = @{ bytes = (Pattern ($chunkBytes + 1) 9); generation = 0 }
}
$syncKey = Pattern 32 41

try {
  if ($installed) { Install-Rnw }
  Put "$rnw\session.json" (Bytes '{"version":7,"tabs":[{"id":"pilot-tab","page":{"url":"file:///C:/pilot/form.html"}}],"windows":[],"windowOrder":[]}')
  Put "$rnw\history-index.json" (Bytes '{"pages":3}')
  Put "$rnw\window-placement.txt" (Bytes '120 80 1280 800 0')
  Put "$rnw\dialog.json" (Bytes '{}')
  Put "$rnw\Logs\launch.log" (Bytes 'launch')
  Put "$rnw\config\config.json" (Bytes '{"theme":"dusk"}')
  Put "$rnw\config\hooks.json" (Bytes '{"hooks":[]}')
  Put "$rnw\config\themes\dusk.json" (Bytes '{"name":"dusk"}')
  Put "$rnw\Chromium\Local State" (Bytes '{"os_crypt":{"encrypted_key":"pilot"}}')
  Put "$rnw\Chromium\Default\Cookies" (Pattern 4096 7)
  Put "$rnw\Chromium\Default\Login Data" (Pattern 2048 8)
  Put "$rnw\Sync\sync-key-acct1.dpapi" (Seal $syncKey 'ardia-sync-key/v1/test-instance/acct1')
  Put "$rnw\Sync\sync-key-acct2.dpapi" (Seal $syncKey 'ardia-sync-key/v1/test-instance/someone-else')
  foreach ($account in $secrets.Keys) { Write-Rnw $account $secrets[$account].bytes $secrets[$account].generation }
  Write-Rnw 'torn' (Pattern ($chunkBytes * 3) 1) 1
  [RnwVault]::Delete("${prefix}torn#g1#2")
  if (-not [RnwVault]::Write("${prefix}half-written#g1#1", $null, 'half-written', (Pattern 300 2))) { throw 'CredWrite of the orphan chunk failed' }

  Assert-RnwStopped 'before-seeding'
  if ($RnwApp) {
    Run-Rnw 15000 | Out-Null
    Check 'rnw-populated' (Test-Path "$rnw\session.json") "the RNW build ran on the seeded profile for 15 s and left session.json"
  }
  Assert-RnwStopped 'before-migrating'

  $rnwBefore = Tree-Snapshot $rnw
  $vaultBefore = [RnwVault]::Snapshot($prefix)

  $marker = Join-Path (Split-Path $Migrator) 'Ardia.test-build'
  $testBuild = Test-Path -LiteralPath $marker
  Check 'migrator-test-build' $testBuild "Ardia.test-build beside the migrator lets ARDIA_TEST_MIGRATION_STOP_AT_COMMIT stop it before a rename"
  $crashes = 0; $resumedOk = 0; $commits = 0
  if ($testBuild) {
    for ($n = 1; $n -le $CrashPoints; $n++) {
      Clear-WebUI
      $env:ARDIA_TEST_MIGRATION_STOP_AT_COMMIT = "$n"
      $stopped = Migrate
      Remove-Item Env:ARDIA_TEST_MIGRATION_STOP_AT_COMMIT
      if ($stopped.code -eq 0) { $commits = $n - 1; break }
      $crashes++
      $noMarker = -not (Test-Path "$web\rnw-migration.json")
      $resumed = Migrate
      $partials = @(Get-ChildItem -LiteralPath $web -Recurse -Force -Filter '*.rnw-migration.partial' -ErrorAction SilentlyContinue).Count
      if ($stopped.code -eq 1 -and $noMarker -and $resumed.code -eq 0 -and $resumed.report.outcome -eq 'migrated_with_skips' -and $partials -eq 0) { $resumedOk++ }
      else { Log "crash point ${n}: stopped $($stopped.code), marker absent $noMarker, resumed $($resumed.code) $($resumed.report.outcome), partials $partials" }
    }
  }
  Check 'crash-then-resume' ($testBuild -and $crashes -gt 0 -and $resumedOk -eq $crashes -and $commits -gt 0) "stopped before each of $commits renames in turn; $resumedOk of $crashes resumed to a complete migration with no marker before and no staged files after"

  Clear-WebUI
  $first = Migrate
  $c = $first.report.counts
  Check 'migrated' ($first.code -eq 0 -and $first.report.outcome -eq 'migrated_with_skips') "exit $($first.code), $($first.text)"
  Check 'counts' ($c.documents -eq 2 -and $c.placement -eq 1 -and $c.config_files -eq 3 -and $c.sync_keys -eq 1 -and $c.sync_keys_unreadable -eq 1 -and $c.credentials -eq 3 -and $c.credentials_incomplete -eq 1 -and $c.credential_chunks_orphaned -eq 1) ($c | ConvertTo-Json -Compress)

  $docs = @('session.json', 'history-index.json', 'window-placement.txt') | Where-Object { -not (Same ([IO.File]::ReadAllBytes("$rnw\$_")) ([IO.File]::ReadAllBytes("$web\$_"))) }
  Check 'documents-copied' ($docs.Count -eq 0) "documents and window placement byte for byte; different: $($docs -join ', ')"
  $configs = @('config.json', 'hooks.json', 'themes\dusk.json') | Where-Object { -not (Same ([IO.File]::ReadAllBytes("$rnw\config\$_")) ([IO.File]::ReadAllBytes("$web\config\$_"))) }
  Check 'config-copied' ($configs.Count -eq 0) "config, hooks and themes; different: $($configs -join ', ')"
  $webuiKeyName = "sync-key-x$(Hex 'acct1').dpapi"
  $copiedKey = [IO.File]::ReadAllBytes("$web\Sync\$webuiKeyName")
  Check 'sync-key-copied' ((Same $copiedKey ([IO.File]::ReadAllBytes("$rnw\Sync\sync-key-acct1.dpapi"))) -and (Same (Unseal $copiedKey 'ardia-sync-key/v1/test-instance/acct1') $syncKey) -and -not (Test-Path "$web\Sync\sync-key-x$(Hex 'acct2').dpapi") -and @(Get-ChildItem -LiteralPath "$web\Sync" -Force).Count -eq 1) "the sealed key is copied as is to $webuiKeyName, the name the WebUI host's DPAPI store reads, and still unseals for its account; the key sealed for someone else stays behind"
  $wrong = @()
  foreach ($account in $secrets.Keys) {
    $file = "$web\Secrets\account-x$(Hex $account).dpapi"
    $plain = if (Test-Path -LiteralPath $file) { Unseal ([IO.File]::ReadAllBytes($file)) "ardia-connected-account/v1/test-instance/$account" } else { $null }
    if (-not (Same $plain $secrets[$account].bytes)) { $wrong += $account }
  }
  $secretFiles = @(Get-ChildItem -LiteralPath "$web\Secrets" -Force -ErrorAction SilentlyContinue).Count
  Check 'credentials-sealed' ($wrong.Count -eq 0 -and $secretFiles -eq $secrets.Count) "every Credential Manager account, single, chunked and legacy, reassembles and is DPAPI-sealed for its purpose; wrong: $($wrong -join ', '); $secretFiles files"
  Check 'user-data-not-copied' (-not (Test-Path "$web\Chromium\Default\Cookies") -and -not (Test-Path "$web\Chromium\Local State") -and -not (Test-Path "$web\Logs") -and -not (Test-Path "$web\dialog.json")) "Chromium's profile, logs and scratch files stay where they are"
  $staged = @(Get-ChildItem -LiteralPath $web -Recurse -Force -Filter '*.partial' -ErrorAction SilentlyContinue).Count
  Check 'no-staged-files' ($staged -eq 0) "$staged staged files left"
  $markerText = Get-Content -LiteralPath "$web\rnw-migration.json" -Raw
  Check 'marker-has-no-paths' (($markerText -notmatch '[\\/]') -and ($markerText -notmatch 'github|acct1|pilot')) 'the marker holds counts and enums only'

  $webBefore = Tree-Snapshot $web
  $again = Migrate
  $lock = "\rnw-migration.lock"
  $webAfter = Tree-Snapshot $web
  $webBefore.Remove($lock); $webAfter.Remove($lock)
  Check 'runs-once' ($again.code -eq 0 -and $again.report.outcome -eq 'already_migrated' -and (Same-Snapshot $webBefore $webAfter)) "second run: $($again.report.outcome); the WebUI folder unchanged"

  Check 'rnw-files-untouched' (Same-Snapshot $rnwBefore (Tree-Snapshot $rnw)) 'every file in the RNW data folder has the same size, hash and write time'
  Check 'rnw-credentials-untouched' ((($vaultBefore | ConvertTo-Json -Compress) -eq ([RnwVault]::Snapshot($prefix) | ConvertTo-Json -Compress)) -and $vaultBefore.Count -gt 0) "$($vaultBefore.Count) Credential Manager items unchanged"
  $readable = @($secrets.Keys | Where-Object { Same (Read-Rnw $_) $secrets[$_].bytes }).Count
  Check 'rollback-reads-credentials' ($readable -eq $secrets.Count) "the RNW reader still assembles $readable of $($secrets.Count) accounts"
  Check 'rollback-reads-sync-key' (Same (Unseal ([IO.File]::ReadAllBytes("$rnw\Sync\sync-key-acct1.dpapi")) 'ardia-sync-key/v1/test-instance/acct1') $syncKey) 'the RNW sealed sync key still unseals in place'

  if ($RnwApp) {
    $alive = Run-Rnw 15000
    Assert-RnwStopped 'after-rollback'
    $stillReadable = @($secrets.Keys | Where-Object { Same (Read-Rnw $_) $secrets[$_].bytes }).Count
    Check 'rollback-launch' ($alive -and (Test-Path "$rnw\session.json") -and $stillReadable -eq $secrets.Count) "the RNW build opened the original folder after the migration (running after 15 s: $alive) and its accounts still read back"
  }

  if (-not $SkipWebUILaunch) {
    $rnwBeforeWebUI = Tree-Snapshot $rnw
    $script:Data = $web
    Start-Shell | Out-Null
    $opened = $false
    try { $h = Wait-Shell 60; $opened = ($h -ne $null) -and ($h -ne [IntPtr]::Zero) } catch {}
    Stop-PilotEngine
    Remove-Item Env:ARDIA_DATA_DIR, Env:ARDIA_REMOTE_DEBUGGING_PORT -ErrorAction SilentlyContinue
    Check 'webui-opens-migrated-data' ($opened -and (Test-Path "$web\Chromium") -and (Same-Snapshot $rnwBeforeWebUI (Tree-Snapshot $rnw))) "--ardia-shell=webui opened its window on the migrated folder, its own Chromium profile inside it, and wrote nothing into the RNW profile"
  }

  $inside = Migrate @() (Join-Path $rnw 'WebUI')
  Check 'overlap-refused' ($inside.code -eq 2 -and -not (Test-Path (Join-Path $rnw 'WebUI'))) "a WebUI folder inside the RNW folder: exit $($inside.code)"
  $linked = Join-Path $run 'webui-linked'
  New-Item -ItemType Directory $linked | Out-Null
  cmd /c mklink /J "$linked\Secrets" "$outside" | Out-Null
  $outsideBefore = Tree-Snapshot $outside
  $through = Migrate @() $linked
  Check 'junction-not-written-through' ($through.code -eq 1 -and (Same-Snapshot $outsideBefore (Tree-Snapshot $outside))) "a junction at Secrets: exit $($through.code), nothing written through it"
  if ($installed) { Test-InstalledUpgrade }
} catch {
  Check 'no-terminating-error' $false "$($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)"
} finally {
  foreach ($target in ([RnwVault]::Snapshot($prefix)).Keys) { [RnwVault]::Delete($target) }
  $stoppedLate = Stop-Launched
  if ($stoppedLate) { Log "stopped $stoppedLate processes this run started that were still running" }
  Stop-PilotEngine
  if ($installed) {
    foreach ($target in ([RnwVault]::Snapshot($installedPrefix)).Keys) { [RnwVault]::Delete($target) }
    if (Test-Path -LiteralPath (Join-Path $installDir 'unins000.exe')) { Remove-Install | Out-Null }
    Check 'installed-test-credentials-removed' (([RnwVault]::Snapshot($installedPrefix)).Count -eq 0) 'the installed run removed the Credential Manager items it made'
  }
  Remove-Item Env:ARDIA_DATA_DIR, Env:ARDIA_BACKGROUND, Env:ARDIA_TEST_MIGRATION_STOP_AT_COMMIT, Env:ARDIA_REMOTE_DEBUGGING_PORT -ErrorAction SilentlyContinue
  Check 'test-credentials-removed' (([RnwVault]::Snapshot($prefix)).Count -eq 0) 'the run removed the Credential Manager items it made'
  try { Remove-PilotRun $run; Check 'scratch-removed' (-not (Test-Path -LiteralPath $run)) "the run folder $run is gone" }
  catch { Check 'scratch-removed' $false "$($_.Exception.Message)" }
  try {
    $results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath "$Proof\$Label-results.json" -ErrorAction Stop
    $proofWritten = $true
  } catch {
    Log "FAIL proof-written: $($_.Exception.Message)"
    $proofWritten = $false
  }
}

$failed = @($results.Values | Where-Object { -not $_.ok }).Count
"DONE $Label, $failed failed"
if ($failed -gt 0 -or -not $proofWritten) { exit 1 }
exit 0
