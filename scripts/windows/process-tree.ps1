function Get-StopOrder([int]$Id, [object[]]$Running) {
  $started = @{}
  foreach ($process in $Running) { $started[[int]$process.ProcessId] = $process.CreationDate }
  $tree = New-Object 'System.Collections.Generic.List[int]'
  $tree.Add($Id)
  for ($next = 0; $next -lt $tree.Count; $next++) {
    $parent = $tree[$next]
    foreach ($process in $Running) {
      $child = [int]$process.ProcessId
      if ([int]$process.ParentProcessId -ne $parent -or $tree.Contains($child)) { continue }
      if ($started[$parent] -and $process.CreationDate -and $process.CreationDate -lt $started[$parent]) { continue }
      $tree.Add($child)
    }
  }
  $order = $tree.ToArray()
  [array]::Reverse($order)
  return , $order
}
