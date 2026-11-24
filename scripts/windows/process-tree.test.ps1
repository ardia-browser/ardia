$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "process-tree.ps1")

$failures = @()
$noon = [datetime]"2026-01-01T12:00:00"

function Process([int]$Id, [int]$Parent, [int]$StartedAfterSeconds) {
  return [pscustomobject]@{ ProcessId = $Id; ParentProcessId = $Parent; CreationDate = $noon.AddSeconds($StartedAfterSeconds) }
}

function Check([string]$Name, [int[]]$Expected, [int[]]$Actual) {
  if (($Expected -join ",") -eq ($Actual -join ",")) { Write-Host "pass: $Name" } else { $script:failures += "$Name`: expected $($Expected -join ","), got $($Actual -join ",")" }
}

Check "children stop before their parents, grandchildren first" @(4, 3, 2, 1) (Get-StopOrder 1 @((Process 1 0 0), (Process 2 1 1), (Process 3 1 2), (Process 4 2 3), (Process 9 8 1)))
Check "a process outside the tree is left alone" @(1) (Get-StopOrder 1 @((Process 1 0 0), (Process 9 8 1)))
Check "a child older than its parent is a reused id, not a child" @(2, 1) (Get-StopOrder 1 @((Process 1 0 10), (Process 2 1 11), (Process 5 1 3)))
Check "two processes that name each other as parent are each stopped once" @(2, 1) (Get-StopOrder 1 @((Process 1 2 0), (Process 2 1 0)))
Check "a process that names itself as parent is stopped once" @(1) (Get-StopOrder 1 @((Process 1 1 0)))
Check "a parent that already exited still has its children stopped" @(3, 2, 1) (Get-StopOrder 1 @((Process 2 1 1), (Process 3 2 2)))
Check "a process with no start time counts as a child" @(2, 1) (Get-StopOrder 1 @((Process 1 0 0), [pscustomobject]@{ ProcessId = 2; ParentProcessId = 1; CreationDate = $null }))
Check "an empty process list stops only the process asked for" @(1) (Get-StopOrder 1 @())

if ($failures.Count) {
  $failures | ForEach-Object { Write-Host "::error::$_" }
  exit 1
}
Write-Host "The process tree is walked once, in stop order."
