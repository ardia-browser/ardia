$WaitFailure = $null

function Log([string]$line) {
  $text = "$((Get-Date).ToString('HH:mm:ss.fff')) $line"
  if ($script:Proof) {
    try { Add-Content -LiteralPath (Join-Path $script:Proof 'steps.log') -Value $text -ErrorAction Stop } catch { Write-Host "steps.log not written: $($_.Exception.Message)" }
  }
  Write-Host $text
}

function Test-Condition([scriptblock]$Condition) {
  try {
    $value = & $Condition
    if ($value) { $script:WaitFailure = $null }
    $value
  } catch {
    $script:WaitFailure = $_.Exception.Message
    $null
  }
}

function Wait-Until([scriptblock]$Condition, [double]$Seconds = 10, [string]$What = 'a condition', [switch]$NoThrow) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  $script:WaitFailure = $null
  do {
    $value = Test-Condition $Condition
    if ($value) { return $value }
    if ((Get-Date) -ge $deadline) { break }
    Start-Sleep -Milliseconds 100
  } while ($true)
  $failure = if ($script:WaitFailure) { "; the last check threw: $($script:WaitFailure)" } else { '' }
  if ($NoThrow) {
    Log "gave up after $Seconds s waiting for $What$failure"
    return
  }
  throw "timed out after $Seconds s waiting for $What$failure"
}

function Never([scriptblock]$Condition, [double]$Seconds = 3) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  $script:WaitFailure = $null
  while ((Get-Date) -lt $deadline) {
    if (Test-Condition $Condition) { return $false }
    Start-Sleep -Milliseconds 100
  }
  if ($script:WaitFailure) { Log "a check in $Seconds s threw: $($script:WaitFailure)" }
  $true
}

function Wait-Settled([scriptblock]$Read, [double]$Seconds = 5, [int]$StableMilliseconds = 400) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  $last = "$(& $Read)"
  $since = Get-Date
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 50
    $now = "$(& $Read)"
    if ($now -ne $last) { $last = $now; $since = Get-Date; continue }
    if (((Get-Date) - $since).TotalMilliseconds -ge $StableMilliseconds) { return $now }
  }
  $last
}

function Hold([int]$Milliseconds) {
  $deadline = (Get-Date).AddMilliseconds($Milliseconds)
  while ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 20 }
}

function Quote-Argument([string]$value) {
  if ($value -and $value -notmatch '[\s"]') { return $value }
  $out = '"'
  $slashes = 0
  foreach ($c in $value.ToCharArray()) {
    if ($c -eq '\') { $slashes++; continue }
    if ($c -eq '"') { $out += ('\' * ($slashes * 2 + 1)) + '"' } else { $out += ('\' * $slashes) + $c }
    $slashes = 0
  }
  $out + ('\' * ($slashes * 2)) + '"'
}

function Join-Arguments([string[]]$arguments) { ($arguments | ForEach-Object { Quote-Argument $_ }) -join ' ' }
