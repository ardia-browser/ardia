param([string]$Label = 'dpi100', [switch]$Fresh, [int]$Record = 200)
. C:\pilot\lib.ps1
$ErrorActionPreference = 'Continue'
$results = New-Object System.Collections.Specialized.OrderedDictionary ([StringComparer]::Ordinal)
function Check([string]$name, [bool]$ok, [string]$detail) {
  $results[$name] = @{ ok = $ok; detail = $detail }
  Log ("{0} {1}: {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail))
}
function ShellEval([string]$js) { Cdp-Eval $js 'chrome://ardia/' }
function PageEval([string]$js) { Cdp-Eval $js 'file:///C:/pilot/form.html' }
function Scale($h) { [Pilot]::GetDpiForWindow($h) / 96.0 }
function ClientOrigin($h) { $p = New-Object Pilot+POINT; [Pilot]::ClientToScreen($h, [ref]$p) | Out-Null; $p }
function CssToScreen($h, $x, $y) {
  $o = ClientOrigin $h; $s = Scale $h
  @([int]($o.X + $x * $s), [int]($o.Y + $y * $s))
}
function ShellRect([string]$js) {
  $json = ShellEval "(() => { const e = $js; if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify([r.x, r.y, r.width, r.height]); })()"
  if ($json) { $json | ConvertFrom-Json } else { $null }
}
function Center($h, $rect) { CssToScreen $h ($rect[0] + $rect[2] / 2) ($rect[1] + $rect[3] / 2) }
function FrameText { Rect-Text ([Pilot]::Frame($h)) }
function Settle-Frame([double]$seconds = 5) { Wait-Settled { FrameText } $seconds | Out-Null }
function Shell-Focused { (ShellEval '(() => { const e = document.activeElement; return !!e && e.tagName === "INPUT"; })()') -eq $true }
function Page-Focused { (PageEval '(() => document.hasFocus() && document.activeElement && document.activeElement.id === "q")()') -eq $true }
function Shell-Foreground { [Pilot]::GetForegroundWindow() -eq $h }
$maxSelector = 'document.querySelector(''.ardia-window-controls [role="button"][aria-label="Maximize"], .ardia-window-controls [role="button"][aria-label="Restore Down"]'')'
$closeSelector = 'document.querySelector(''.ardia-window-controls [role="button"][aria-label="Close"]'')'

Remove-Item "$Proof\steps.log" -ErrorAction SilentlyContinue
Stop-Engine
$rec = Start-Recording "pilot-$Label" $Record
Wait-Until { Test-Path -LiteralPath "$Proof\pilot-$Label.mp4" } 15 'the screen recording to start' -NoThrow | Out-Null
$p = Start-Shell -Fresh:$Fresh
$h = Wait-ShellReady 60
Wait-Until { (ShellRect 'document.querySelector(''input'')') -and (ShellRect $maxSelector) } 30 'the address field and window controls' -NoThrow | Out-Null
$F = [Pilot]::Frame($h)
Check 'window' ($h -ne [IntPtr]::Zero) ("dpi {0} frame {1} outer {2}" -f [Pilot]::GetDpiForWindow($h), (Rect-Text $F), (Rect-Text ([Pilot]::Outer($h))))
Shot "$Proof\$Label-01-launch.png"
$shellText = ShellEval 'document.getElementById("root").innerText.slice(0, 120)'
Check 'shell-ui' ([bool]$shellText -and $shellText -notmatch 'could not start') "chrome://ardia/ text: $($shellText -replace '\s+', ' ')"

$midX = [int](($F.Left + $F.Right) / 2); $midY = [int](($F.Top + $F.Bottom) / 2)
$max = ShellRect $maxSelector
$probes = [ordered]@{
  'left-edge' = @(($F.Left - 3), $midY, 10); 'right-edge' = @(($F.Right + 2), $midY, 11)
  'bottom-edge' = @($midX, ($F.Bottom + 2), 15); 'top-edge' = @($midX, ($F.Top + 1), 12)
  'bottom-right' = @(($F.Right + 2), ($F.Bottom + 2), 17); 'content' = @($midX, $midY, 1)
}
if ($max) { $c = Center $h $max; $probes['maximize-button'] = @($c[0], $c[1], 9) }
foreach ($k in $probes.Keys) {
  $v = $probes[$k]; $hit = [Pilot]::Hit($v[0], $v[1]); $code = [int]($hit.Split(':')[-1])
  Check "hittest-$k" ($code -eq $v[2]) "($($v[0]),$($v[1])) -> $hit, want $($v[2])"
}

$addr = ShellRect 'document.querySelector(''input'')'
if ($addr) {
  $c = Center $h $addr
  [Pilot]::Click($c[0], $c[1])
  Wait-Until { Shell-Focused } 5 'the address field to take focus' -NoThrow | Out-Null
  [Pilot]::Type('file:///C:/pilot/form.html')
  Wait-Until { (ShellEval 'document.activeElement && document.activeElement.value') -eq 'file:///C:/pilot/form.html' } 5 'the typed address' -NoThrow | Out-Null
  [Pilot]::Chord(0x0D)
  Wait-Until { (PageEval '(() => document.readyState === "complete" && !!document.getElementById("q"))()') -eq $true } 20 'the page to load' -NoThrow | Out-Null
  Wait-Until { ShellRect 'document.querySelector(''[data-ardia-native-tab]'')' } 10 'the page viewport' -NoThrow | Out-Null
}
$targets = (Cdp-List)
$page = $targets | Where-Object { $_.url -like 'file:///C:/pilot/form.html*' }
Check 'shell-typing-navigates' ([bool]$page) ("targets: " + (($targets | ForEach-Object { $_.url }) -join ' | '))
Shot "$Proof\$Label-02-page.png"

$tab = ShellRect 'document.querySelector(''[data-ardia-native-tab]'')'
$inputJson = PageEval '(() => { const r = document.getElementById("q").getBoundingClientRect(); return JSON.stringify([r.x, r.y, r.width, r.height]); })()'
if ($tab -and $inputJson) {
  $in = $inputJson | ConvertFrom-Json
  $c = CssToScreen $h ($tab[0] + $in[0] + $in[2] / 2) ($tab[1] + $in[1] + $in[3] / 2)
  [Pilot]::Click($c[0], $c[1])
  Wait-Until { Page-Focused } 5 'the page input to take focus' -NoThrow | Out-Null
  [Pilot]::Type('hello from SendInput')
  Wait-Until { (PageEval 'document.getElementById("q").value') -eq 'hello from SendInput' } 5 'the typed page text' -NoThrow | Out-Null
  $value = PageEval 'document.getElementById("q").value'
  Check 'page-typing' ($value -eq 'hello from SendInput') "page input value '$value' (viewport $($tab -join ','))"
  Shot "$Proof\$Label-03-page-typed.png"
  [Pilot]::Chord(0x11, 0x4C)
  Wait-Until { Shell-Focused } 5 'Ctrl+L to focus the address field' -NoThrow | Out-Null
  [Pilot]::Type('shell')
  Wait-Until { (ShellEval 'document.activeElement && document.activeElement.value') -match 'shell' } 5 'the typed shell text' -NoThrow | Out-Null
  $shellValue = ShellEval '(() => { const e = document.activeElement; return e && "value" in e ? e.value : (e ? e.tagName : null); })()'
  $pageAfter = PageEval 'document.getElementById("q").value'
  Check 'ctrl-l-to-shell' (($shellValue -match 'shell') -and ($pageAfter -eq 'hello from SendInput')) "shell focus value '$shellValue', page still '$pageAfter'"
  Shot "$Proof\$Label-04-shell-typed.png"
  [Pilot]::Chord(0x1B)
  Wait-Until { -not (Shell-Focused) -or ((ShellEval 'document.activeElement && document.activeElement.value') -notmatch 'shell') } 5 'Escape to leave the address field' -NoThrow | Out-Null
  [Pilot]::Click($c[0], $c[1])
  Wait-Until { Page-Focused } 5 'the page input to take focus again' -NoThrow | Out-Null
  [Pilot]::Chord(0x23); [Pilot]::Type('!')
  Wait-Until { (PageEval 'document.getElementById("q").value') -eq 'hello from SendInput!' } 5 'the appended text' -NoThrow | Out-Null
  $value = PageEval 'document.getElementById("q").value'
  Check 'back-to-page' ($value -eq 'hello from SendInput!') "page input value '$value'"
} else {
  Check 'page-typing' $false "no viewport ($tab) or page input ($inputJson)"
}

$before = [Pilot]::Frame($h)
[Pilot]::Drag(($before.Right + 2), [int](($before.Top + $before.Bottom) / 2), ($before.Right - 160), [int](($before.Top + $before.Bottom) / 2), 20)
Settle-Frame
$after = [Pilot]::Frame($h)
Check 'resize-right-edge' ([Math]::Abs(($before.Right - $after.Right) - 162) -le 6) "$(Rect-Text $before) -> $(Rect-Text $after)"
$before = $after
[Pilot]::Drag(($before.Right + 2), ($before.Bottom + 2), ($before.Right - 100), ($before.Bottom - 80), 20)
Settle-Frame
$after = [Pilot]::Frame($h)
Check 'resize-corner' (($before.Right - $after.Right) -ge 90 -and ($before.Bottom - $after.Bottom) -ge 70) "$(Rect-Text $before) -> $(Rect-Text $after)"
$before = $after
[Pilot]::Drag([int](($before.Left + $before.Right) / 2), ($before.Top + 1), [int](($before.Left + $before.Right) / 2), ($before.Top + 80), 20)
Settle-Frame
$after = [Pilot]::Frame($h)
Check 'resize-top-edge' ((($after.Top - $before.Top) -ge 70) -and ($after.Bottom -eq $before.Bottom)) "$(Rect-Text $before) -> $(Rect-Text $after)"

$before = [Pilot]::Frame($h)
$s = Scale $h
$gp = CssToScreen $h 100 400; $gx = $gp[0]; $gy = $gp[1]
Log "drag point hit $([Pilot]::Hit($gx, $gy))"
[Pilot]::Drag($gx, $gy, ($gx + 140), ($gy + 90), 25)
Settle-Frame
$after = [Pilot]::Frame($h)
Check 'caption-drag' ((($after.Left - $before.Left) -ge 120) -and (($after.Top - $before.Top) -ge 70)) "from ($gx,$gy): $(Rect-Text $before) -> $(Rect-Text $after)"
Shot "$Proof\$Label-05-moved.png"
$gp = CssToScreen $h 100 400
[Pilot]::Glide($gp[0], $gp[1], 10, 15); Hold 120; [Pilot]::Down(); Hold 120
[Pilot]::Glide($gp[0] + 30, $gp[1] + 10, 6, 16); Hold 200
[Pilot]::Glide(1, 500, 30, 16); Hold 900
Shot "$Proof\$Label-05b-drag-snap-preview.png"
[Pilot]::Up()
Wait-Until { ([Pilot]::Frame($h)).Left -le 2 } 5 'the drag to snap the window' -NoThrow | Out-Null
Settle-Frame
$dragSnapped = [Pilot]::Frame($h)
Shot "$Proof\$Label-05c-drag-snapped.png"
[Pilot]::Chord(0x1B)
Wait-Until { Shell-Foreground } 5 'Snap Assist to close' -NoThrow | Out-Null
Check 'caption-drag-to-edge-snaps' (($dragSnapped.Left -le 2) -and ([Math]::Abs(($dragSnapped.Right - $dragSnapped.Left) - [Pilot]::GetSystemMetrics(0) / 2) -le 20)) "$(Rect-Text $dragSnapped)"
$gp = CssToScreen $h 100 400
[Pilot]::Drag($gp[0], $gp[1], 260, 640, 25)
Settle-Frame
$unsnapped = [Pilot]::Frame($h)
Check 'drag-out-unsnaps' ((($unsnapped.Right - $unsnapped.Left) -eq ($after.Right - $after.Left)) -and (($unsnapped.Bottom - $unsnapped.Top) -eq ($after.Bottom - $after.Top))) "$(Rect-Text $unsnapped), size before snapping $(Rect-Text $after)"
$restoredSize = $unsnapped
$screenW = [Pilot]::GetSystemMetrics(0)
[Pilot]::Chord(0x5B, 0x25)
Wait-Until { ([Pilot]::Frame($h)).Left -le 2 } 5 'Win+Left to snap the window' -NoThrow | Out-Null
Settle-Frame
$snapped = [Pilot]::Frame($h)
Shot "$Proof\$Label-06-snap-left.png"
[Pilot]::Chord(0x1B)
Wait-Until { Shell-Foreground } 5 'Snap Assist to close' -NoThrow | Out-Null
Check 'snap-win-left' (($snapped.Left -le 2) -and ($snapped.Top -le 2) -and ([Math]::Abs(($snapped.Right - $snapped.Left) - $screenW / 2) -le 20) -and (($snapped.Bottom - $snapped.Top) -ge 900)) "$(Rect-Text $snapped)"
[Pilot]::Chord(0x5B, 0x27)
Wait-Until { ([Pilot]::Frame($h)).Left -gt 2 } 5 'Win+Right to restore the window' -NoThrow | Out-Null
Settle-Frame
$back = [Pilot]::Frame($h)
Check 'snap-win-right-restores' ((($back.Right - $back.Left) -eq ($restoredSize.Right - $restoredSize.Left)) -and -not [Pilot]::IsZoomed($h)) "$(Rect-Text $back)"
[Pilot]::Chord(0x5B, 0x26)
Wait-Until { [Pilot]::IsZoomed($h) } 5 'Win+Up to maximize' -NoThrow | Out-Null
Settle-Frame
Check 'snap-win-up-maximizes' ([Pilot]::IsZoomed($h)) "zoomed $([Pilot]::IsZoomed($h)) frame $(Rect-Text ([Pilot]::Frame($h)))"
Shot "$Proof\$Label-07-maximized.png"
$maxHits = [Pilot]::Hit(5, 500) + ' / ' + [Pilot]::Hit(960, 1)
Log "maximized edge hits (no resize expected): $maxHits"
[Pilot]::Chord(0x5B, 0x28)
Wait-Until { -not [Pilot]::IsZoomed($h) } 5 'Win+Down to restore' -NoThrow | Out-Null
Settle-Frame
$restored = [Pilot]::Frame($h)
Check 'snap-win-down-restores' ((-not [Pilot]::IsZoomed($h)) -and ($restored.Left -gt -1000)) "zoomed $([Pilot]::IsZoomed($h)) frame $(Rect-Text $restored)"

$max = ShellRect $maxSelector
if ($max) {
  $c = Center $h $max
  [Pilot]::Glide($c[0], $c[1], 15, 15); Hold 2500
  Shot "$Proof\$Label-08-snap-flyout.png"
  Log "hover hit $([Pilot]::Hit($c[0], $c[1]))"
  [Pilot]::Glide($c[0] - 300, $c[1] + 300, 10, 10); Hold 500
  [Pilot]::Chord(0x1B)
  $z0 = [Pilot]::IsZoomed($h)
  [Pilot]::Click($c[0], $c[1])
  Wait-Until { [Pilot]::IsZoomed($h) -ne $z0 } 5 'the maximize button to change the window' -NoThrow | Out-Null
  Settle-Frame
  $z1 = [Pilot]::IsZoomed($h)
  $max2 = ShellRect $maxSelector
  if ($max2) {
    $c2 = Center $h $max2; [Pilot]::Click($c2[0], $c2[1])
    Wait-Until { [Pilot]::IsZoomed($h) -eq $z0 } 5 'the restore button to change the window back' -NoThrow | Out-Null
    Settle-Frame
  }
  $z2 = [Pilot]::IsZoomed($h)
  Check 'maximize-button-click' (($z1 -ne $z0) -and ($z2 -eq $z0)) "zoomed $z0 -> $z1 -> $z2"
} else {
  Check 'maximize-button-click' $false 'no maximize control in the shell'
}

$close = ShellRect $closeSelector
if ($close) {
  $c = Center $h $close
  [Pilot]::Click($c[0], $c[1])
} else {
  [Pilot]::Chord(0x12, 0x73)
}
$closedAt = Get-Date
$gone = $false
for ($i = 0; $i -lt 60; $i++) { if ((Engine-Processes).Count -eq 0) { $gone = $true; break }; Start-Sleep -Milliseconds 250 }
Check 'close-exits' $gone ("engine processes gone after {0:n1} s" -f ((Get-Date) - $closedAt).TotalSeconds)

$p = Start-Shell
$h = Wait-ShellReady 60
Wait-Until { @(Cdp-List | Where-Object { $_.url -like 'file:///C:/pilot/form.html*' }).Count -ge 1 } 20 'the session to restore its tab' -NoThrow | Out-Null
$targets = (Cdp-List)
$restoredPage = $targets | Where-Object { $_.url -like 'file:///C:/pilot/form.html*' }
Check 'relaunch-reopens' (($h -ne [IntPtr]::Zero) -and [bool]$restoredPage) ("window back; session tab restored: {0}; targets {1}" -f [bool]$restoredPage, (($targets | ForEach-Object { $_.url }) -join ' | '))
Shot "$Proof\$Label-09-relaunched.png"
$second = Start-Process "$App\chrome.exe" -ArgumentList '--ardia-shell=webui' -PassThru; [Pilot]::Roots.Add($second.Id) | Out-Null
$second.WaitForExit(20000) | Out-Null
Wait-Until { Shell-Foreground } 10 'the first window to come forward' -NoThrow | Out-Null
$windows = [Pilot]::CountShells('Ardia')
Check 'second-launch-reuses' ($windows -eq 1) "Ardia windows after a second launch: $windows; foreground is the shell: $([Pilot]::GetForegroundWindow() -eq $h)"
$F = [Pilot]::Frame($h)
[Pilot]::Click([int]($F.Left + ($F.Right - $F.Left) * 0.55), [int]($F.Top + 30 * (Scale $h)))
Wait-Until { Shell-Foreground } 5 'the shell to be the foreground window' -NoThrow | Out-Null
[Pilot]::Chord(0x12, 0x73)
$gone = $false
for ($i = 0; $i -lt 60; $i++) { if ((Engine-Processes).Count -eq 0) { $gone = $true; break }; Start-Sleep -Milliseconds 250 }
Check 'alt-f4-exits' $gone 'after relaunch'
Stop-Engine
$rec.WaitForExit(($Record + 10) * 1000) | Out-Null
$results | ConvertTo-Json -Depth 4 | Set-Content "$Proof\$Label-results.json"
Get-Content "$Data\Chromium\chrome_debug.log" -ErrorAction SilentlyContinue | Select-String -Pattern 'WebUI shell' | Select-Object -Last 60 | ForEach-Object { $_.Line } | Set-Content "$Proof\$Label-shell-log.txt"
Stop-Engine
Remove-PilotRun $RunRoot
"DONE $Label"
