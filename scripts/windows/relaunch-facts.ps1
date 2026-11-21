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
