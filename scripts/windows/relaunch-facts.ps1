function Get-BrowserProcesses([object[]]$Running) {
  return @($Running | Where-Object { $_ -and $_.CommandLine -and $_.CommandLine -notmatch '(^|\s)"?--type=' })
}

function Get-ChildProcesses([object[]]$Running, [int]$Parent) {
  return @($Running | Where-Object { $_ -and [int]$_.ParentProcessId -eq $Parent })
}

function Get-BrowserChildren([object[]]$Running, [int]$Parent) {
  return @(Get-ChildProcesses $Running $Parent | Where-Object { $_.CommandLine -notmatch '--type=crashpad-handler' })
}

function Read-LaunchGuard([string[]]$Lines) {
  $facts = [pscustomobject]@{ WaitedMs = $null; UnfinishedBefore = $null; SetAside = $false; StartFailure = $null; Fatal = @() }
  foreach ($line in $Lines) {
    if (-not $line) { continue }
    if ($line -match 'launch guard: waited (\d+) ms for a previous Ardia, (\d+) unfinished starts before this one, restore state (kept|set aside)') {
      $facts.WaitedMs = [int]$Matches[1]
      $facts.UnfinishedBefore = [int]$Matches[2]
      $facts.SetAside = $Matches[3] -eq 'set aside'
    }
    if ($line -match 'app start failed: (.+)$') { $facts.StartFailure = $Matches[1].Trim() }
    if ($line -match '^fatal \d+ ' -or $line -match ':FATAL:' -or $line -match 'Check failed:') { $facts.Fatal += $line }
  }
  return $facts
}

function Read-SyncTrace([string[]]$Lines) {
  $trace = [pscustomobject]@{ Recovered = $null; Statuses = @(); TurnedOn = $null; UnlocksOrCycles = @(); Unlocked = $null }
  foreach ($line in $Lines) {
    if (-not $line) { continue }
    if ($line -match '\[sync\] test: recoveredStart (true|false), status (\w+)') {
      $trace.Recovered = $Matches[1] -eq 'true'
      $trace.Statuses += $Matches[2]
    } elseif ($line -match '\[sync\] test: status (\w+)') {
      $trace.Statuses += $Matches[1]
    } elseif ($line -match '\[sync\] test: (turned on|couldn''t turn on.*|left as it was.*)$') {
      $trace.TurnedOn = $Matches[1]
    } elseif ($line -match '\[sync\] (?!test:).*(unlock|cycle)') {
      $trace.UnlocksOrCycles += $line
      if ($line -match '\[sync\] unlock finished: (unlocked|not unlocked)') { $trace.Unlocked = $Matches[1] -eq 'unlocked' }
    }
  }
  return $trace
}

function Get-SyncDigests([string]$Data, [string]$SyncFolder) {
  $digests = [ordered]@{}
  foreach ($file in @(Get-ChildItem -LiteralPath $Data -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'sync-state.nns' -or $_.Name -like 'sync-journal*.nns' } | Sort-Object Name)) {
    $digests["data/$($file.Name)"] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
  }
  if ($SyncFolder -and (Test-Path -LiteralPath $SyncFolder)) {
    $root = (Resolve-Path -LiteralPath $SyncFolder).Path.TrimEnd('\', '/')
    foreach ($file in @(Get-ChildItem -LiteralPath $root -File -Recurse -Force -ErrorAction SilentlyContinue | Sort-Object FullName)) {
      $digests["folder/$($file.FullName.Substring($root.Length + 1) -replace '\\', '/')"] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    }
  }
  return $digests
}

function Compare-SyncDigests($Before, $After) {
  $changes = @()
  foreach ($name in @($Before.Keys)) {
    if (-not $After.Contains($name)) { $changes += "$name was removed" }
    elseif ($After[$name] -ne $Before[$name]) { $changes += "$name changed" }
  }
  foreach ($name in @($After.Keys)) { if (-not $Before.Contains($name)) { $changes += "$name was added" } }
  return , $changes
}

function ConvertTo-SortedJson($Value) {
  if ($Value -is [System.Collections.IDictionary]) {
    $parts = @($Value.Keys | Sort-Object | ForEach-Object { "$(ConvertTo-Json -InputObject ([string]$_) -Compress):$(ConvertTo-SortedJson $Value[$_])" })
    return "{" + ($parts -join ",") + "}"
  }
  return ConvertTo-Json -InputObject $Value -Compress -Depth 20
}

function Read-SyncDoc([string]$Path) {
  $facts = [pscustomobject]@{ Found = $false; Enabled = $false; PausedByGuard = $false; UnsettledStarts = 0; Seqs = $null }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $facts }
  $doc = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
  $facts.Found = $true
  $facts.Enabled = $doc['enabled'] -eq $true
  $facts.PausedByGuard = $doc['pausedByGuard'] -eq $true
  if ($doc['unsettledStarts'] -is [ValueType] -and $doc['unsettledStarts'] -isnot [bool]) { $facts.UnsettledStarts = [int]$doc['unsettledStarts'] }
  $facts.Seqs = if ($doc.ContainsKey('seqs')) { ConvertTo-SortedJson $doc['seqs'] } else { "absent" }
  return $facts
}

function Measure-LocalCount([string[]]$Lines, [string]$Event, [string]$Field, [double]$FromMs, [double]$ToMs) {
  $total = 0
  foreach ($line in $Lines) {
    if (-not $line -or $line -notmatch [regex]::Escape("`"$Field`"")) { continue }
    try { $entry = $line | ConvertFrom-Json -AsHashtable } catch { continue }
    if ($entry['kind'] -ne 'event' -or $entry['event'] -ne $Event) { continue }
    $at = [double]$entry['at']
    if ($at -lt $FromMs -or $at -gt $ToMs) { continue }
    $properties = $entry['properties']
    if ($properties -is [System.Collections.IDictionary] -and $properties.Contains($Field)) { $total += [int]$properties[$Field] }
  }
  return $total
}

function Read-SyncDocWhileRunning([string]$Path) {
  foreach ($attempt in 1..5) {
    try { return Read-SyncDoc $Path } catch { Start-Sleep -Milliseconds 100 }
  }
  return Read-SyncDoc $Path
}

function Get-LinesHash([string[]]$Lines, [int]$Count) {
  if ($Count -le 0) { return "" }
  $text = (@($Lines) | Select-Object -First $Count) -join "`n"
  return [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($text)))
}

function Get-LogMark([string[]]$Current, [string[]]$Previous) {
  $Current = @($Current)
  return [pscustomobject]@{ From = $Current.Count; Hash = Get-LinesHash $Current $Current.Count }
}

function Get-RunLines($Mark, [string[]]$Current, [string[]]$Previous) {
  $Current = @($Current)
  $Previous = @($Previous)
  if (-not $Mark.From) { return $Current }
  if ($Current.Count -ge $Mark.From -and (Get-LinesHash $Current $Mark.From) -eq $Mark.Hash) { return @($Current | Select-Object -Skip $Mark.From) }
  $straddled = if ($Previous.Count -ge $Mark.From -and (Get-LinesHash $Previous $Mark.From) -eq $Mark.Hash) { @($Previous | Select-Object -Skip $Mark.From) } else { @() }
  return @($straddled) + $Current
}
