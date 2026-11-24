param(
  [string]$Label = 'upgrade',
  [Parameter(Mandatory = $true)][string]$Migrator,
  [string]$RnwApp = '',
  [int]$CrashPoints = 60,
  [switch]$SkipWebUILaunch
)
. C:\pilot\lib.ps1
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Security
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
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

Stop-Engine
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

function Write-Rnw([string]$account, [byte[]]$secret, [int]$generation) {
  $base = $prefix + $account
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

function Read-Rnw([string]$account) {
  $base = $prefix + $account
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

function Rnw-Tree([int]$root) {
  $all = All-Processes
  $tree = @{ $root = $true }
  do {
    $grew = $false
    foreach ($process in $all) {
      if ($tree.ContainsKey([int]$process.ParentProcessId) -and -not $tree.ContainsKey([int]$process.ProcessId)) { $tree[[int]$process.ProcessId] = $true; $grew = $true }
    }
  } while ($grew)
  @($all | Where-Object { $tree.ContainsKey([int]$_.ProcessId) })
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

function Run-Rnw([int]$Milliseconds) {
  $env:ARDIA_DATA_DIR = $rnw
  $env:ARDIA_BACKGROUND = '1'
  try {
    $started = Start-Process (Join-Path $RnwApp 'Ardia.exe') -PassThru
  } finally {
    Remove-Item Env:ARDIA_DATA_DIR, Env:ARDIA_BACKGROUND -ErrorAction SilentlyContinue
  }
  Hold $Milliseconds
  $alive = -not $started.HasExited
  $mine = Rnw-Tree $started.Id
  $mine | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Wait-Until { @(Rnw-Tree $started.Id | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count -eq 0 } 20 'the RNW processes this run started to exit' -NoThrow | Out-Null
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

$secrets = [ordered]@{
  'github'       = @{ bytes = (Bytes 'gho_pilot-short-token'); generation = 1 }
  'google-oauth' = @{ bytes = (Pattern ($chunkBytes * 2 + 117) 3); generation = 2 }
  'legacy'       = @{ bytes = (Pattern ($chunkBytes + 1) 9); generation = 0 }
}
$syncKey = Pattern 32 41

try {
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
    Stop-Engine
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
} catch {
  Check 'no-terminating-error' $false "$($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)"
} finally {
  foreach ($target in ([RnwVault]::Snapshot($prefix)).Keys) { [RnwVault]::Delete($target) }
  Stop-Engine
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
