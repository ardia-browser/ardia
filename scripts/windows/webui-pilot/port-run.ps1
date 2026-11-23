param([string]$Out)
. C:\pilot\lib.ps1
$ErrorActionPreference = 'Continue'
$p = Start-Shell -Fresh
$ready = $true
try { Wait-ShellReady 90 | Out-Null } catch { $ready = $false }
$port = DevTools-Port
$owner = $script:PortOwner
$identity = $null
if ($port) { $identity = Cdp-Eval '__ardiaHost.invoke("ArdiaShell.windowIdentity", {})' }
$result = [ordered]@{ run = $RunRoot; browser = $p.Id; ready = $ready; port = $port; owner = $owner; ownerIsThisRun = [bool]($owner -and [Pilot]::IsTracked([int]$owner)); identity = $identity }
Stop-Engine
Remove-PilotRun $RunRoot
$result | ConvertTo-Json | Set-Content -LiteralPath $Out
