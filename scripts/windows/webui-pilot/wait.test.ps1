$ErrorActionPreference = "Stop"
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

$Proof = Join-Path ([System.IO.Path]::GetTempPath()) ("ardia-wait-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Proof | Out-Null
try {
  . (Join-Path $PSScriptRoot "wait.ps1")

  Check "Wait-Until -NoThrow is false when it times out" $false ([bool](Wait-Until { $false } 1 'never' -NoThrow))
  Check "Wait-Until -NoThrow puts nothing on the output when it times out" 0 @(Wait-Until { $null } 0.3 'never' -NoThrow).Count
  Check "Wait-Until -NoThrow is false when every check throws" $false ([bool](Wait-Until { throw 'probe down' } 0.3 'a probe' -NoThrow))
  Check "Wait-Until returns the condition's value" 7 (Wait-Until { 7 } 1)
  Check "Wait-Until returns a list the condition found" "a,b" ((Wait-Until { @('a', 'b') } 1) -join ',')
  $calls = 0
  Check "Wait-Until checks again until the condition holds" $true ([bool](Wait-Until { $script:calls++; $script:calls -ge 3 } 5 'the third check'))
  Check-Throws "Wait-Until throws on a timeout and names what it waited for" "timed out after 0.3 s waiting for the page" { Wait-Until { $false } 0.3 'the page' }
  Check-Throws "Wait-Until names the last error a check threw" "the last check threw: CDP connect timed out" { Wait-Until { throw 'CDP connect timed out' } 0.3 'the page' }
  $calls = 0
  Check-Throws "an error a check threw is still named after later checks come back false" "the last check threw: CDP connect refused" { Wait-Until { if ($script:calls++ -eq 0) { throw 'CDP connect refused' } $false } 0.5 'the page' }
  $calls = 0
  Check "Wait-Until -NoThrow keeps the thrown error after false checks" "CDP connect refused" "$(Wait-Until { if ($script:calls++ -eq 0) { throw 'CDP connect refused' } $false } 0.5 'the page' -NoThrow; $WaitFailure)"
  $calls = 0
  Check "Wait-Until forgets an error once a check passes" $true ([bool](Wait-Until { if ($script:calls++ -lt 5) { throw 'early' } $true } 5 'a late success'))
  Check "a passing check clears the last error" "" "$WaitFailure"

  Check "Log puts nothing on the output" 0 @(Log 'a line for the file').Count
  Check "Log appends to steps.log" $true ((Get-Content -LiteralPath (Join-Path $Proof 'steps.log') -Raw) -match 'a line for the file')
  Check "a function that logs and returns a flag returns only the flag" "False" "$(& { Log 'noise'; $false })"

  Check "Never is true when the condition never holds" $true (Never { $false } 0.3)
  Check "Never is false as soon as the condition holds" $false (Never { $true } 2)
  Check "Never is true when every check throws" $true (Never { throw 'down' } 0.3)

  Check "a plain argument is not quoted" "--ardia-shell=webui" (Quote-Argument "--ardia-shell=webui")
  Check "an argument with a space is quoted" '"--ardia-migrate-rnw-data=C:\a b"' (Quote-Argument "--ardia-migrate-rnw-data=C:\a b")
  Check "a trailing backslash before the closing quote is doubled" '"C:\a b\\"' (Quote-Argument "C:\a b\")
  Check "an embedded quote is escaped" '"say \"hi\""' (Quote-Argument 'say "hi"')
  Check "an empty argument is kept" '""' (Quote-Argument "")
  Check "arguments are joined with spaces" '--a "b c"' (Join-Arguments @('--a', 'b c'))

  $lib = Get-Content -LiteralPath (Join-Path $PSScriptRoot "lib.ps1") -Raw
  Check "lib.ps1 compiles its types with the default assemblies" $false ($lib -match 'ReferencedAssemblies')
  foreach ($script in "lib.ps1", "upgrade.ps1", "tour-webui.ps1") {
    $text = Get-Content -LiteralPath (Join-Path $PSScriptRoot $script) -Raw
    $blocks = [regex]::Matches($text, '(?s)Add-Type -TypeDefinition @"\r?\n(.*?)\r?\n"@')
    Check "$script has its type definitions" $true ($blocks.Count -ge 1)
    foreach ($block in $blocks) {
      $source = $block.Groups[1].Value
      $renamed = [regex]::Replace($source, 'public static class (\w+)', { param($m) "public static class $($m.Groups[1].Value)$([guid]::NewGuid().ToString('N'))" })
      try {
        Add-Type -TypeDefinition $renamed
        Write-Host "pass: $script's types compile on PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
      } catch {
        $script:failures += "$script's types do not compile on PowerShell $($PSVersionTable.PSVersion): $($_.Exception.Message)"
      }
    }
  }
} finally {
  Remove-Item -LiteralPath $Proof -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count) {
  $failures | ForEach-Object { Write-Host "::error::$_" }
  exit 1
}
Write-Host "The pilot's waits, log and argument quoting behave as the checks expect, and its types compile."
