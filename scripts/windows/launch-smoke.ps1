param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Seconds = 25,
  [int]$SelfCheckSeconds = 300,
  [switch]$NoInput,
  [ValidateSet("all", "launch", "gate")][string]$Part = "all"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "process-tree.ps1")
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$testBuild = Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $App).Path) "Ardia.test-build"
New-Item -ItemType File -Force -Path $testBuild | Out-Null
$log = Join-Path $Out "launch.log"
$checkLog = Join-Path $Out "self-check.log"
$shot = Join-Path $Out "window.png"
Remove-Item -Force -ErrorAction SilentlyContinue $log, $checkLog, $shot

$failures = @()

function Save-Screenshot([string]$Path) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $bitmap.Dispose()
  } catch {
    Write-Host "::warning::no screenshot: $_"
  }
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ArdiaInput {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", EntryPoint = "PostMessageW")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, System.Text.StringBuilder name, int size);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")] public static extern bool GetSystemFlag(uint action, uint unused, ref int value, uint flags);
  [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")] public static extern bool SetSystemFlag(uint action, uint value, IntPtr pointerValue, uint flags);
}
"@
[ArdiaInput]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

function Get-WindowRect([System.Diagnostics.Process]$Process) {
  $Process.Refresh()
  $rect = New-Object ArdiaInput+Rect
  if ($Process.MainWindowHandle -eq [IntPtr]::Zero) { return $null }
  if (-not [ArdiaInput]::GetWindowRect($Process.MainWindowHandle, [ref]$rect)) { return $null }
  return $rect
}

function Get-ClientArea([System.Diagnostics.Process]$Process) {
  $Process.Refresh()
  $handle = $Process.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { return $null }
  $origin = New-Object ArdiaInput+Point
  $size = New-Object ArdiaInput+Rect
  if (-not [ArdiaInput]::ClientToScreen($handle, [ref]$origin)) { return $null }
  if (-not [ArdiaInput]::GetClientRect($handle, [ref]$size)) { return $null }
  $dpi = [ArdiaInput]::GetDpiForWindow($handle)
  return [pscustomobject]@{ X = $origin.X; Y = $origin.Y; Width = $size.Right; Height = $size.Bottom; Scale = $(if ($dpi) { $dpi / 96.0 } else { 1.0 }) }
}

function Enable-WindowSnapping {
  $flags = @(@{ Name = "window arranging"; Read = 0x0082; Write = 0x0083 }, @{ Name = "docking at screen edges"; Read = 0x0090; Write = 0x0091 }, @{ Name = "dragging off a maximized window"; Read = 0x008C; Write = 0x008D })
  foreach ($flag in $flags) {
    $value = 0
    if (-not [ArdiaInput]::GetSystemFlag($flag.Read, 0, [ref]$value, 0)) { Write-Host "Input: could not read whether $($flag.Name) is on."; continue }
    if ($value) { continue }
    $set = [ArdiaInput]::SetSystemFlag($flag.Write, 1, [IntPtr]1, 3)
    Write-Host "Input: $($flag.Name) was off on this runner; turned on: $set."
  }
}

function Count-LogLines([string]$Log, [string]$Pattern) {
  if (-not (Test-Path $Log)) { return 0 }
  return @(Select-String -Path $Log -Pattern $Pattern).Count
}

function Send-Press {
  [ArdiaInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [ArdiaInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
}

function Send-Click([int]$X, [int]$Y) {
  [ArdiaInput]::SetCursorPos($X, $Y) | Out-Null
  Start-Sleep -Milliseconds 80
  [ArdiaInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [ArdiaInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 250
}

function Send-PeekClick([System.Diagnostics.Process]$Process, [int]$X, [int]$Y, [int[]]$Page) {
  $Process.Refresh()
  if ($Process.MainWindowHandle -eq [IntPtr]::Zero) { return "the app has no main window" }
  $owner = 0
  foreach ($attempt in 1..5) {
    [ArdiaInput]::SetForegroundWindow($Process.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 200
    [ArdiaInput]::GetWindowThreadProcessId([ArdiaInput]::GetForegroundWindow(), [ref]$owner) | Out-Null
    if ($owner -eq $Process.Id) { break }
  }
  if ($owner -ne $Process.Id) { return "the foreground window belongs to process $owner, not the app ($($Process.Id))" }
  $point = New-Object ArdiaInput+Point
  $point.X = $X
  $point.Y = $Y
  $hit = [ArdiaInput]::GetAncestor([ArdiaInput]::WindowFromPoint($point), 2)
  $hitOwner = 0
  [ArdiaInput]::GetWindowThreadProcessId($hit, [ref]$hitOwner) | Out-Null
  $rect = Get-HandleRect $hit
  $class = New-Object System.Text.StringBuilder 256
  [ArdiaInput]::GetClassName($hit, $class, 256) | Out-Null
  $where = if ($rect) { "$($rect.Left),$($rect.Top),$($rect.Right - $rect.Left),$($rect.Bottom - $rect.Top)" } else { "no rect" }
  $isPage = $hit -ne [IntPtr]::Zero -and $hit -ne $Process.MainWindowHandle -and $hitOwner -eq $Process.Id -and $rect -and [Math]::Abs($rect.Left - $Page[0]) -le 1 -and [Math]::Abs($rect.Top - $Page[1]) -le 1 -and [Math]::Abs(($rect.Right - $rect.Left) - $Page[2]) -le 1 -and [Math]::Abs(($rect.Bottom - $rect.Top) - $Page[3]) -le 1
  if (-not $isPage) { return "($X, $Y) hits $($class.ToString()) at $where in process $hitOwner, not the page window at $($Page -join ',')" }
  [ArdiaInput]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)
  try {
    Start-Sleep -Milliseconds 60
    Send-Click $X $Y
  } finally {
    [ArdiaInput]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
  }
  return ""
}

function Send-Drag([int]$X, [int]$Y, [int]$ByX, [int]$ByY, [int]$Hold = 150) {
  [ArdiaInput]::SetCursorPos($X, $Y) | Out-Null
  Start-Sleep -Milliseconds 250
  [ArdiaInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  $screen = [System.Windows.Forms.SystemInformation]::PrimaryMonitorSize
  foreach ($step in 1..12) {
    $toX = $X + [int]($ByX * $step / 12)
    $toY = $Y + [int]($ByY * $step / 12)
    [ArdiaInput]::mouse_event(0x8001, [uint32]($toX * 65535 / ($screen.Width - 1)), [uint32]($toY * 65535 / ($screen.Height - 1)), 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
  }
  Start-Sleep -Milliseconds $Hold
  [ArdiaInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 400
}

function Send-Chord([byte[]]$Modifiers, [byte]$Key) {
  foreach ($modifier in $Modifiers) { [ArdiaInput]::keybd_event($modifier, 0, 0, [UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 40
  [ArdiaInput]::keybd_event($Key, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [ArdiaInput]::keybd_event($Key, 0, 2, [UIntPtr]::Zero)
  foreach ($modifier in $Modifiers) { [ArdiaInput]::keybd_event($modifier, 0, 2, [UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 400
}

function Send-Text([string]$Text) {
  foreach ($character in $Text.ToUpperInvariant().ToCharArray()) {
    [ArdiaInput]::keybd_event([byte][char]$character, 0, 0, [UIntPtr]::Zero)
    [ArdiaInput]::keybd_event([byte][char]$character, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
  }
  Start-Sleep -Milliseconds 300
}

function Get-LastLogLine([string]$Log, [string]$Pattern) {
  if (-not (Test-Path $Log)) { return "" }
  $found = Select-String -Path $Log -Pattern $Pattern | Select-Object -Last 1
  if ($found) { return $found.Line } else { return "" }
}

function Get-MoveCounts([string]$Log) {
  return [pscustomobject]@{ System = Count-LogLines $Log "^window \d+ system move began on"; App = Count-LogLines $Log "^window \d+ drag began on" }
}

function Test-MovedBy([string]$Log, $Counts, [string]$What, [string]$Expected) {
  $now = Get-MoveCounts $Log
  $system = $now.System - $Counts.System
  $app = $now.App - $Counts.App
  if ($Expected -eq "system" -and $system -ge 1 -and $app -eq 0) { Write-Host "Input: $What was moved by Windows ($system system move, no app move)."; return @() }
  if ($Expected -eq "app" -and $app -ge 1 -and $system -eq 0) { Write-Host "Input: $What was moved by the app ($app app move, no system move)."; return @() }
  return @("input: $What should have been moved by $(if ($Expected -eq 'system') { 'Windows' } else { 'the app' }), but the log shows $system system moves and $app app moves")
}

function Get-GrabPoint($Client) {
  return [pscustomobject]@{ X = $Client.X + $Client.Width - [int](157 * $Client.Scale); Y = $Client.Y + [int](30 * $Client.Scale) }
}

function Get-WindowButton($Client, [int]$FromRight) {
  return [pscustomobject]@{ X = $Client.X + $Client.Width - [int]($FromRight * $Client.Scale); Y = $Client.Y + [int](30 * $Client.Scale) }
}

function Test-WindowButtons([System.Diagnostics.Process]$Process, [string]$Log) {
  $notes = @()
  $handle = $Process.MainWindowHandle
  $client = Get-ClientArea $Process
  if (-not $client) { return @("input: the window could not be measured before the window buttons") }
  $maximize = Get-WindowButton $client 60
  Send-Click $maximize.X $maximize.Y
  Start-Sleep -Milliseconds 900
  Save-Screenshot (Join-Path $Out "browser-maximize-button.png")
  if ([ArdiaInput]::IsZoomed($handle)) { Write-Host "Input: the app's maximize button maximized the window." }
  else { $notes += "input: a click on the app's maximize button, 60 points from the right edge, did not maximize the window" }

  $client = Get-ClientArea $Process
  if (-not $client) { return $notes + "input: the window was gone after the maximize button" }
  $restore = Get-WindowButton $client 60
  Send-Click $restore.X $restore.Y
  Start-Sleep -Milliseconds 900
  if (-not [ArdiaInput]::IsZoomed($handle)) { Write-Host "Input: the app's restore button put the window back." }
  else { $notes += "input: a click on the app's restore button did not restore the maximized window" }

  $client = Get-ClientArea $Process
  if (-not $client) { return $notes + "input: the window was gone after the restore button" }
  $minimize = Get-WindowButton $client 93
  Send-Click $minimize.X $minimize.Y
  Start-Sleep -Milliseconds 900
  if ([ArdiaInput]::IsIconic($handle)) { Write-Host "Input: the app's minimize button minimized the window." }
  else { $notes += "input: a click on the app's minimize button, 93 points from the right edge, did not minimize the window" }
  [ArdiaInput]::ShowWindow($handle, 9) | Out-Null
  Start-Sleep -Milliseconds 700
  [ArdiaInput]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 400
  if ([ArdiaInput]::IsIconic($handle)) { $notes += "input: the minimized window did not come back" }
  return $notes
}

function Test-Snap([System.Diagnostics.Process]$Process, [string]$Log) {
  $notes = @()
  $handle = $Process.MainWindowHandle
  $restored = Get-WindowRect $Process
  $client = Get-ClientArea $Process
  if (-not $restored -or -not $client) { return @("input: the window could not be measured before the snap") }
  $screen = [System.Windows.Forms.SystemInformation]::PrimaryMonitorSize

  $counts = Get-MoveCounts $Log
  $grab = Get-GrabPoint $client
  $fromX = $grab.X
  $fromY = $grab.Y
  Send-Drag $fromX $fromY ([int]($screen.Width * 0.15) - $fromX) (0 - $fromY) 600
  Start-Sleep -Milliseconds 700
  Save-Screenshot (Join-Path $Out "browser-maximized.png")
  if ([ArdiaInput]::IsZoomed($handle)) { Write-Host "Input: dragging the gap beside the window buttons to the top edge of the screen maximized the window." }
  else { $notes += "input: dragging the gap beside the window buttons to the top edge of the screen did not maximize the window" }
  $notes += @(Test-MovedBy $Log $counts "the drag to the top edge" "system")

  $client = Get-ClientArea $Process
  if (-not $client) { return $notes + "input: the window was gone after the snap" }
  $counts = Get-MoveCounts $Log
  $grab = Get-GrabPoint $client
  Send-Drag $grab.X $grab.Y -200 160 300
  Start-Sleep -Milliseconds 700
  $after = Get-WindowRect $Process
  if ([ArdiaInput]::IsZoomed($handle)) { $notes += "input: dragging the maximized window down by the gap beside its buttons did not restore it" }
  elseif ($after) {
    $width = $after.Right - $after.Left
    $height = $after.Bottom - $after.Top
    $wasWidth = $restored.Right - $restored.Left
    $wasHeight = $restored.Bottom - $restored.Top
    if ([Math]::Abs($width - $wasWidth) -le 24 -and [Math]::Abs($height - $wasHeight) -le 24) { Write-Host "Input: dragging the maximized window down restored it to $width by $height." }
    else { $notes += "input: dragging the maximized window down restored it to $width by $height, not $wasWidth by $wasHeight" }
  }
  $notes += @(Test-MovedBy $Log $counts "the drag off the maximized window" "system")
  return $notes
}

function Send-DoubleClick([int]$X, [int]$Y, [int]$Settle) {
  [ArdiaInput]::SetCursorPos($X, $Y) | Out-Null
  Start-Sleep -Milliseconds $Settle
  Send-Press
  Start-Sleep -Milliseconds 90
  Send-Press
  Start-Sleep -Milliseconds 900
}

function Test-DoubleClick([System.Diagnostics.Process]$Process, [string]$Log) {
  $notes = @()
  $handle = $Process.MainWindowHandle
  $client = Get-ClientArea $Process
  if (-not $client) { return @("input: the window could not be measured before the double clicks") }
  $grab = Get-GrabPoint $client
  Send-DoubleClick $grab.X $grab.Y 5
  $path = Get-LastLogLine $Log "^window \d+ double click on"
  if ([ArdiaInput]::IsZoomed($handle)) { Write-Host "Input: a double click on the gap beside the window buttons right after moving there maximized the window ($path)." }
  else { $notes += "input: a double click on the gap beside the window buttons right after moving there did not maximize the window (last double click logged: '$path')" }

  $client = Get-ClientArea $Process
  if (-not $client) { return $notes + "input: the window was gone after the first double click" }
  $grab = Get-GrabPoint $client
  Send-DoubleClick $grab.X $grab.Y 300
  $path = Get-LastLogLine $Log "^window \d+ double click on"
  if (-not [ArdiaInput]::IsZoomed($handle)) { Write-Host "Input: a second double click on the gap beside the window buttons restored the window ($path)." }
  else { $notes += "input: a second double click on the gap beside the window buttons did not restore the maximized window (last double click logged: '$path')" }
  return $notes
}

function Test-AppDrag([System.Diagnostics.Process]$Process, [string]$Log) {
  $before = Get-WindowRect $Process
  $client = Get-ClientArea $Process
  if (-not $before -or -not $client) { return @("input: the window could not be measured before the toolbar drag") }
  $counts = Get-MoveCounts $Log
  Send-Drag ($client.X + [int]($client.Width * 0.6)) ($client.Y + [int](30 * $client.Scale)) 40 30
  $after = Get-WindowRect $Process
  if (-not $after) { return @("input: the window was gone after the toolbar drag") }
  $notes = @()
  $movedX = $after.Left - $before.Left
  $movedY = $after.Top - $before.Top
  if ([Math]::Abs($movedX - 40) -le 12 -and [Math]::Abs($movedY - 30) -le 12) { Write-Host "Input: dragging the toolbar's empty middle moved the window by $movedX, $movedY." }
  else { $notes += "input: dragging the toolbar's empty middle by 40, 30 moved the window by $movedX, $movedY" }
  $notes += @(Test-MovedBy $Log $counts "the toolbar drag" "app")
  return $notes
}

function Test-SidebarButton([System.Diagnostics.Process]$Process, [string]$Log) {
  $client = Get-ClientArea $Process
  if (-not $client) { return @("input: the window was gone before the sidebar button click") }
  $watches = Count-LogLines $Log "^window \d+ sidebar edge watch on"
  Send-Click ($client.X + [int](211 * $client.Scale)) ($client.Y + [int](30 * $client.Scale))
  Start-Sleep -Milliseconds 1500
  Save-Screenshot (Join-Path $Out "browser-sidebar-hidden.png")
  if ((Count-LogLines $Log "^window \d+ sidebar edge watch on") -gt $watches) { Write-Host "Input: the sidebar button took its click and hid the sidebar." }
  else { return @("input: clicking the sidebar button did not hide the sidebar") }
  return @()
}

function Test-SidebarEdge([System.Diagnostics.Process]$Process, [string]$Log) {
  $handle = $Process.MainWindowHandle
  [ArdiaInput]::SetWindowPos($handle, [IntPtr]::Zero, 160, 60, 0, 0, 0x0015) | Out-Null
  Start-Sleep -Milliseconds 400
  $client = Get-ClientArea $Process
  if (-not $client) { return @("input: the window was gone before the sidebar edge check") }
  $y = $client.Y + [int]([Math]::Min(200 * $client.Scale, $client.Height / 2))
  $notes = @()
  $overs = Count-LogLines $Log "^window \d+ sidebar edge over "
  [ArdiaInput]::SetCursorPos($client.X - [int](6 * $client.Scale), $y) | Out-Null
  Start-Sleep -Milliseconds 700
  Save-Screenshot (Join-Path $Out "browser-sidebar-peek.png")
  if ((Count-LogLines $Log "^window \d+ sidebar edge over ") -gt $overs) { Write-Host "Input: the pointer just outside the window's left edge counted as over the hidden sidebar's edge." }
  else { $notes += "input: the pointer 6 points outside the window's left edge, with the sidebar hidden, logged no 'sidebar edge over' line" }
  $aways = Count-LogLines $Log "^window \d+ sidebar edge away "
  [ArdiaInput]::SetCursorPos($client.X + [int]($client.Width * 0.7), $y) | Out-Null
  Start-Sleep -Milliseconds 700
  if ((Count-LogLines $Log "^window \d+ sidebar edge away ") -gt $aways) { Write-Host "Input: moving the pointer into the page counted as away from the sidebar's edge." }
  else { $notes += "input: moving the pointer from the window's edge into the page logged no 'sidebar edge away' line" }
  return $notes
}

function Test-Input([System.Diagnostics.Process]$Process, [string]$Log) {
  $notes = @()
  $before = Get-WindowRect $Process
  if (-not $before) { return @("input: the app has no main window to drive") }
  [ArdiaInput]::SetForegroundWindow($Process.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 300
  $width = $before.Right - $before.Left
  $height = $before.Bottom - $before.Top

  $band = Get-LastLogLine $Log "^window \d+ title band of \S+ is (caption|content)"
  if ($band -match " is caption$") { Write-Host "Input: the default layout marked caption regions for Windows ($band)." }
  else { $notes += "input: the default layout marked no caption region for Windows (last title band line: '$band')" }

  $client = Get-ClientArea $Process
  if (-not $client) { return @("input: the window could not be measured before the first drag") }
  $grab = Get-GrabPoint $client
  $counts = Get-MoveCounts $Log
  Send-Drag $grab.X $grab.Y -70 50
  $after = Get-WindowRect $Process
  if ($after) {
    $movedX = $after.Left - $before.Left
    $movedY = $after.Top - $before.Top
    if ([Math]::Abs($movedX + 70) -le 12 -and [Math]::Abs($movedY - 50) -le 12) { Write-Host "Input: dragging the gap beside the window buttons moved the window by $movedX, $movedY." }
    else { $notes += "input: dragging the gap beside the window buttons by -70, 50 moved the window by $movedX, $movedY" }
  } else {
    $notes += "input: the window was gone after the drag"
    return $notes
  }
  $notes += @(Test-MovedBy $Log $counts "the drag by the gap beside the window buttons" "system")

  Enable-WindowSnapping
  $notes += @(Test-Snap $Process $Log)
  $notes += @(Test-DoubleClick $Process $Log)
  $notes += @(Test-WindowButtons $Process $Log)
  $notes += @(Test-AppDrag $Process $Log)
  $after = Get-WindowRect $Process
  if (-not $after) { return $notes + "input: the window was gone after the drags" }
  $width = $after.Right - $after.Left
  $height = $after.Bottom - $after.Top

  Send-Click ($after.Left + [int]($width * 0.55)) ($after.Top + [int]($height * 0.42))
  Start-Sleep -Milliseconds 900
  Send-Text "ardia"
  Save-Screenshot (Join-Path $Out "browser-typed.png")

  Send-Chord @(0x11) 0x54
  $commanded = (Test-Path $Log) -and (Select-String -Path $Log -Pattern "^command \d+ newTab" -Quiet)
  if ($commanded) { Write-Host "Input: Ctrl+T matched newTab and was sent to the UI." } else { $notes += "input: Ctrl+T matched no command" }
  Save-Screenshot (Join-Path $Out "browser-after-input.png")

  $sidebarNotes = @(Test-SidebarButton $Process $Log)
  $notes += $sidebarNotes
  if (-not $sidebarNotes.Count) { $notes += @(Test-SidebarEdge $Process $Log) }
  return $notes
}

function Test-WindowIcon([System.Diagnostics.Process]$Process, [string]$Log) {
  $notes = @()
  $Process.Refresh()
  $handle = $Process.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { return @("the browser window has no handle to ask for its icon") }
  foreach ($size in @(@{ Name = "big"; Kind = 1 }, @{ Name = "small"; Kind = 0 })) {
    $icon = [IntPtr]::Zero
    $answered = [ArdiaInput]::SendMessageTimeout($handle, 0x007F, [IntPtr]$size.Kind, [IntPtr]::Zero, 0x0002, 2000, [ref]$icon)
    if ($answered -eq [IntPtr]::Zero) { $notes += "the browser window did not answer WM_GETICON for its $($size.Name) icon" }
    elseif ($icon -eq [IntPtr]::Zero) { $notes += "the browser window has no $($size.Name) icon (WM_GETICON gave none)" }
    else { Write-Host "Icon: the browser window's $($size.Name) icon is 0x$($icon.ToString('x'))." }
  }
  if (-not (Select-String -Path $Log -Pattern "app icon: AppUserModelID is Ardia\.Browser" -Quiet)) { $notes += "the launch log does not say the process took the AppUserModelID Ardia.Browser" }
  if (-not (Select-String -Path $Log -Pattern "app icon: set on " -Quiet)) { $notes += "the launch log does not say a window got Ardia's icon" }
  return $notes
}

function New-DataDirectory([string]$Name) {
  $directory = Join-Path $Out $Name
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $directory
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  return $directory
}

if ($Part -ne "gate") {
$env:ARDIA_DATA_DIR = New-DataDirectory "launch-data"
$env:ARDIA_BACKGROUND = ""
$process = Start-Process -FilePath $App -ArgumentList "--log-file=`"$log`"" -PassThru
try {
  Start-Sleep -Seconds $Seconds
  Save-Screenshot $shot
  if ($process.HasExited) { $failures += "the app exited on its own within $Seconds s (exit code $($process.ExitCode))" }
} finally {
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
    $process.WaitForExit(10000) | Out-Null
  }
}

if (Test-Path $log) { Get-Content $log } else { Write-Host "no launch log was written" }

if (-not (Test-Path $log)) { $failures += "the app wrote no launch log" }
elseif (Select-String -Path $log -Pattern "^(js-error|fatal|error) " -Quiet) { $failures += "the launch log has errors" }
elseif (-not (Select-String -Path $log -Pattern "\[ardia windows\] first window" -Quiet)) { $failures += "the first window never rendered" }
else {
  $first = (Select-String -Path $log -Pattern "^\w+ (\d+) .*\[ardia windows\] first window" | Select-Object -First 1)
  if ($first) { Write-Host "First window rendered $($first.Matches[0].Groups[1].Value) ms after the process started." }
}

$httpPagesPort = 9353
$httpPagesFolder = New-DataDirectory "http-pages"
$httpPagesScript = Join-Path $httpPagesFolder "serve.ps1"
$httpPagesLog = Join-Path $httpPagesFolder "requests.log"
Set-Content -LiteralPath $httpPagesScript -Encoding utf8NoBOM -Value @'
param([int]$Port, [string]$Log)
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
$held = [System.Collections.Generic.List[object]]::new()
$rate = 8000
$count = $rate * 2
$wav = [byte[]]::new(44 + 2 * $count)
[System.Text.Encoding]::ASCII.GetBytes("RIFF").CopyTo($wav, 0)
[BitConverter]::GetBytes([int](36 + 2 * $count)).CopyTo($wav, 4)
[System.Text.Encoding]::ASCII.GetBytes("WAVEfmt ").CopyTo($wav, 8)
[BitConverter]::GetBytes([int]16).CopyTo($wav, 16)
[BitConverter]::GetBytes([int16]1).CopyTo($wav, 20)
[BitConverter]::GetBytes([int16]1).CopyTo($wav, 22)
[BitConverter]::GetBytes([int]$rate).CopyTo($wav, 24)
[BitConverter]::GetBytes([int](2 * $rate)).CopyTo($wav, 28)
[BitConverter]::GetBytes([int16]2).CopyTo($wav, 32)
[BitConverter]::GetBytes([int16]16).CopyTo($wav, 34)
[System.Text.Encoding]::ASCII.GetBytes("data").CopyTo($wav, 36)
[BitConverter]::GetBytes([int](2 * $count)).CopyTo($wav, 40)
for ($i = 0; $i -lt $count; $i++) { [BitConverter]::GetBytes([int16]([Math]::Sin($i * 0.345) * 3000)).CopyTo($wav, 44 + 2 * $i) }
while ($true) {
  $client = $listener.AcceptTcpClient()
  $keep = $false
  try {
    $client.ReceiveTimeout = 2000
    $stream = $client.GetStream()
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
    $request = $reader.ReadLine()
    $socketKey = $null
    while ($line = $reader.ReadLine()) { if ($line -match '^Sec-WebSocket-Key:\s*(\S+)') { $socketKey = $Matches[1] } }
    $path = if ($request) { $request.Split(" ")[1] } else { "" }
    if ($Log -and $path) { Add-Content -LiteralPath $Log -Value $path }
    if (($path -replace '\?.*$', '') -eq "/hold") {
      $held.Add($client)
      $keep = $true
      continue
    }
    if (($path -replace '\?.*$', '') -eq "/ws" -and $socketKey) {
      $accept = [Convert]::ToBase64String([System.Security.Cryptography.SHA1]::HashData([System.Text.Encoding]::ASCII.GetBytes($socketKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")))
      $upgrade = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 101 Switching Protocols`r`nUpgrade: websocket`r`nConnection: Upgrade`r`nSec-WebSocket-Accept: $accept`r`n`r`n")
      $stream.Write($upgrade, 0, $upgrade.Length)
      $stream.Flush()
      $held.Add($client)
      $keep = $true
      continue
    }
    if (($path -replace '\?.*$', '') -eq "/tone.wav") {
      $head = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: audio/wav`r`nContent-Length: $($wav.Length)`r`nConnection: close`r`n`r`n")
      $stream.Write($head, 0, $head.Length)
      $stream.Write($wav, 0, $wav.Length)
      $stream.Flush()
      continue
    }
    if (($path -replace '\?.*$', '') -eq "/clobber") {
      $first = [System.Text.Encoding]::UTF8.GetBytes("<!doctype html><meta charset=utf-8><title>clobber page</title><div id=ardiaAutoplayGuard></div>")
      $rest = [System.Text.Encoding]::UTF8.GetBytes("<video id=m src='/tone.wav' autoplay muted loop></video><script>window.tries = ['attribute'];</script>")
      $head = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: text/html; charset=utf-8`r`nContent-Length: $($first.Length + $rest.Length)`r`nConnection: close`r`n`r`n")
      $stream.Write($head, 0, $head.Length)
      $stream.Write($first, 0, $first.Length)
      $stream.Flush()
      Start-Sleep -Milliseconds 1000
      $stream.Write($rest, 0, $rest.Length)
      $stream.Flush()
      continue
    }
    if (($path -replace '\?.*$', '') -eq "/download.bin") {
      $file = [System.Text.Encoding]::ASCII.GetBytes("ardia blank check")
      $head = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: application/octet-stream`r`nContent-Disposition: attachment; filename=ardia-blank-check.bin`r`nContent-Length: $($file.Length)`r`nConnection: close`r`n`r`n")
      $stream.Write($head, 0, $head.Length)
      $stream.Write($file, 0, $file.Length)
      $stream.Flush()
      continue
    }
    $name = @{ "/a" = "a"; "/b" = "b"; "/field" = "field"; "/opener" = "opener"; "/hover" = "hover"; "/sleep" = "sleep"; "/links" = "links"; "/drag" = "drag"; "/media" = "media"; "/framed" = "framed"; "/event/hovered" = "event"; "/event/left" = "event"; "/event/pressed" = "event"; "/event/selected" = "event"; "/event/released" = "event"; "/event/dragstart" = "event"; "/event/fullscreen" = "event"; "/event/windowed" = "event"; "/event/local-state-start" = "event"; "/event/local-state-stop" = "event" }[$($path -replace '\?.*$', '')]
    $status = if ($name -eq "event") { "204 No Content" } elseif ($name) { "200 OK" } else { "404 Not Found" }
    $text = if ($name -eq "event") { "" } elseif ($name -eq "links") { "<!doctype html><meta charset=utf-8><title>links page</title><style>body{margin:0}a{position:absolute;left:10px;width:200px;height:40px;display:block;background:#ddd}</style><a id=peek style='top:10px' href='/a'>peek</a><a id=blank style='top:70px' target=_blank href='/b'>blank</a><a id=app style='top:130px' href='ardia-sleep-check-link:woke'>app</a><script>window.downs = 0; window.restored = false; window.lastClick = null; addEventListener('pointerdown', (event) => { if (event.isTrusted) downs++; }, true); addEventListener('pageshow', (event) => { restored = event.persisted; }); addEventListener('mouseup', (event) => { lastClick = { up: true, clicked: false, prevented: false, shift: event.shiftKey, alt: event.altKey }; }, true); addEventListener('click', (event) => { if (lastClick) { lastClick.clicked = true; lastClick.prevented = event.defaultPrevented; } });</script>" } elseif ($name -eq "opener") { "<!doctype html><meta charset=utf-8><title>opener page</title><style>body{margin:0}#open{position:absolute;left:0;top:0;width:100%;height:100%;font:24px sans-serif}</style><button id=open>open a pop-up</button><script>document.getElementById('open').addEventListener('click', () => window.open('/field', 'snapcheck', 'popup,width=560,height=420'));</script>" } elseif ($name -eq "field") { "<!doctype html><meta charset=utf-8><title>field page</title><style>body{margin:0}#field{position:absolute;left:0;top:0;width:100%;height:100%;border:0;font:24px sans-serif}</style><input id=field><script>const field = document.getElementById('field'); field.addEventListener('input', () => fetch('/event/typed?' + encodeURIComponent(field.value)));</script>" } elseif ($name -eq "sleep") { "<!doctype html><meta charset=utf-8><title>sleep page</title><body style='margin:0;height:6000px'><input id=field></body>" } elseif ($name -eq "drag") { "<!doctype html><meta charset=utf-8><title>drag page</title><style>body{margin:0;font:18px sans-serif}#words{position:absolute;left:40px;top:120px;width:560px;margin:0}#link{position:absolute;left:40px;top:240px}#full{position:absolute;left:40px;top:320px;width:160px;height:40px}</style><p id=words>Plain words to select by dragging across them, plain words to select by dragging across them.</p><a id=link href='/a'>a link to drag</a><button id=full>full screen</button><script>const report = (name) => fetch('/event/' + name); addEventListener('mousedown', () => report('pressed')); addEventListener('mouseup', () => report(getSelection().toString().length > 0 ? 'selected' : 'released')); addEventListener('dragstart', () => report('dragstart')); document.getElementById('full').addEventListener('click', (event) => { event.stopPropagation(); document.documentElement.requestFullscreen(); }); addEventListener('fullscreenchange', () => report(document.fullscreenElement ? 'fullscreen' : 'windowed'));</script>" } elseif ($name -eq "media") { "<!doctype html><meta charset=utf-8><title>media page</title><style>body{margin:0}#m{width:160px;height:90px}#go{position:absolute;left:0;top:100px;width:200px;height:60px}#next{position:absolute;left:0;top:170px;width:200px;height:30px;display:block;background:#ddd}</style><video id=m src='/tone.wav' loop></video><button id=go>play</button><a id=next href='/media?second'>next</a><script>const m = document.getElementById('m'); if (location.search.includes('muted')) m.muted = true; window.tries = []; const attempt = () => m.play().then(() => 'played', (error) => error.name).then((result) => tries.push(result)); if (location.search.includes('auto')) attempt(); const burst = () => { for (let i = 0; i < 25; i++) new Audio().play().catch(() => {}); }; if (location.search.includes('burst')) burst(); if (location.search.includes('again')) addEventListener('pageshow', (event) => { if (event.persisted) burst(); }); if (location.search.includes('session')) navigator.mediaSession.setActionHandler('play', () => attempt()); if (location.search.includes('touchplay')) addEventListener('pointerdown', (event) => { if (event.pointerType === 'touch') attempt(); }); document.getElementById('go').addEventListener('click', attempt); addEventListener('message', (event) => { if (event.data === 'play-muted') { m.muted = true; attempt(); } if (event.data === 'play-again') attempt(); }); if (parent !== window) setInterval(() => parent.postMessage({ paused: m.paused, time: m.currentTime, tries, active: !!(navigator.userActivation && navigator.userActivation.hasBeenActive) }, '*'), 200);</script>" } elseif ($name -eq "framed") { "<!doctype html><meta charset=utf-8><title>framed page</title><style>body{margin:0}iframe{width:280px;height:200px;border:0}</style><body><script>window.frameState = null; window.restored = false; addEventListener('message', (event) => { frameState = event.data; }); window.showPlay = null; addEventListener('pageshow', (event) => { restored = event.persisted; const shows = Number(sessionStorage.getItem('ardia-shows') || 0) + 1; sessionStorage.setItem('ardia-shows', String(shows)); if (shows > 1 && location.search.includes('showplay')) Object.assign(document.createElement('video'), { muted: true, loop: true, src: '/tone.wav' }).play().then(() => 'played', (error) => error.name).then((result) => { showPlay = result; }); }); if (location.search.includes('burst')) for (let i = 0; i < 25; i++) new Audio().play().catch(() => {}); const frame = document.createElement('iframe'); frame.allow = 'autoplay'; frame.src = (location.search.includes('same') ? location.origin : 'http://localhost:$Port') + '/media' + (location.search.includes('burst') ? '?again' : location.search.includes('quiet') ? '' : '?auto-muted'); document.body.append(frame);</script>" } elseif ($name -eq "hover") { "<!doctype html><meta charset=utf-8><title>ready</title><style>body{margin:0}#strip{height:160px;background:#ddd}</style><div id=strip>hover strip</div><script>const strip = document.getElementById('strip'); strip.addEventListener('mouseenter', () => { document.title = 'hovered'; fetch('/event/hovered'); }); strip.addEventListener('mouseleave', () => { document.title = 'left'; fetch('/event/left'); });</script>" } elseif ($name) { "<!doctype html><meta charset=utf-8><p>cached page $name</p><script>addEventListener('pageshow', (event) => { document.title = (event.persisted ? 'restored ' : 'loaded ') + '$name'; });</script>" } else { "" }
    $body = [System.Text.Encoding]::UTF8.GetBytes($text)
    $policy = if ($name -eq "links" -and $path -match '\?sandboxed') { "Content-Security-Policy: sandbox allow-scripts allow-popups`r`n" } else { "" }
    $head = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $status`r`nContent-Type: text/html; charset=utf-8`r`n$($policy)Content-Length: $($body.Length)`r`nConnection: close`r`n`r`n")
    $stream.Write($head, 0, $head.Length)
    $stream.Write($body, 0, $body.Length)
    $stream.Flush()
  } catch { } finally { if (-not $keep) { $client.Close() } }
}
'@
$httpPages = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList "-NoProfile", "-NonInteractive", "-File", "`"$httpPagesScript`"", "-Port", $httpPagesPort, "-Log", "`"$httpPagesLog`"" -WindowStyle Hidden -PassThru
$httpPagesBy = (Get-Date).AddSeconds(15)
$httpPagesUp = $false
while (-not $httpPagesUp -and (Get-Date) -lt $httpPagesBy -and -not $httpPages.HasExited) {
  $probe = New-Object System.Net.Sockets.TcpClient
  try { $httpPagesUp = $probe.ConnectAsync("127.0.0.1", $httpPagesPort).Wait(1000) -and $probe.Connected } catch { } finally { $probe.Dispose() }
  if (-not $httpPagesUp) { Start-Sleep -Milliseconds 300 }
}
if (-not $httpPagesUp) { $failures += "the loopback page server never listened on port $httpPagesPort" }
$withEngineForEdge = Test-Path -LiteralPath (Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $App).Path) "chrome.dll")

$browserLog = Join-Path $Out "browser.log"
Remove-Item -Force -ErrorAction SilentlyContinue $browserLog
$env:ARDIA_DATA_DIR = New-DataDirectory "browser-data"
Set-Content -Path (Join-Path $env:ARDIA_DATA_DIR "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM
$browser = Start-Process -FilePath $App -ArgumentList "--log-file=`"$browserLog`"" -PassThru
try {
  Start-Sleep -Seconds 12
  Save-Screenshot (Join-Path $Out "browser.png")
  if ($browser.HasExited) { $failures += "the app exited on its own with onboarding done (exit code $($browser.ExitCode))" }
  else {
    $working = [Math]::Round((Get-Process -Id $browser.Id).WorkingSet64 / 1MB)
    $private = [Math]::Round((Get-Process -Id $browser.Id).PrivateMemorySize64 / 1MB)
    Write-Host "Memory with the browser window open: $working MB working set, $private MB private."
    Test-WindowIcon $browser $browserLog | ForEach-Object { $failures += $_ }
    if (-not $NoInput) {
      $inputNotes = Test-Input $browser $browserLog
      $inputNotes | ForEach-Object { $failures += $_ }
    }
    if ($browser.HasExited) { $failures += "the app exited while being driven (exit code $($browser.ExitCode))" }
  }
} finally {
  if (-not $browser.HasExited) {
    Stop-Process -Id $browser.Id -Force
    $browser.WaitForExit(10000) | Out-Null
  }
}
if (-not (Test-Path $browserLog)) { $failures += "the launch with onboarding done wrote no log" }
elseif (Select-String -Path $browserLog -Pattern "^(js-error|fatal|error) " -Quiet) {
  Select-String -Path $browserLog -Pattern "^(js-error|fatal|error) " | ForEach-Object { Write-Host $_.Line }
  $failures += "the launch with onboarding done has errors"
}
elseif (-not (Select-String -Path $browserLog -Pattern "\[ardia windows\] first window" -Quiet)) { $failures += "the browser window never rendered with onboarding done" }

function Start-PlacementRun([string]$Name) {
  $runLog = Join-Path $Out "placement-$Name.log"
  Remove-Item -Force -ErrorAction SilentlyContinue $runLog
  $run = Start-Process -FilePath $App -ArgumentList "--log-file=`"$runLog`"" -PassThru
  $by = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $by -and -not $run.HasExited) {
    $run.Refresh()
    if ($run.MainWindowHandle -ne [IntPtr]::Zero -and (Test-Path $runLog) -and (Select-String -Path $runLog -Pattern "\[ardia windows\] first window" -Quiet)) { break }
    Start-Sleep -Milliseconds 300
  }
  Start-Sleep -Seconds 3
  $run.Refresh()
  return [pscustomobject]@{ Process = $run; Log = $runLog; Handle = $run.MainWindowHandle }
}

function Stop-PlacementRun($Run, [string]$What) {
  if ($Run.Process.HasExited) { return @("placement: the app had exited before $What") }
  [ArdiaInput]::PostMessage($Run.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  if ($Run.Process.WaitForExit(20000)) { return @() }
  Stop-Process -Id $Run.Process.Id -Force -ErrorAction SilentlyContinue
  $Run.Process.WaitForExit(10000) | Out-Null
  return @("placement: closing the last window did not quit the app within 20 s ($What)")
}

function Test-RectNear($Rect, $Expected, [string]$What) {
  if (-not $Rect) { return @("placement: no window to measure $What") }
  $got = "$($Rect.Left),$($Rect.Top) $($Rect.Right - $Rect.Left)x$($Rect.Bottom - $Rect.Top)"
  $want = "$($Expected.Left),$($Expected.Top) $($Expected.Right - $Expected.Left)x$($Expected.Bottom - $Expected.Top)"
  $near = [Math]::Abs($Rect.Left - $Expected.Left) -le 4 -and [Math]::Abs($Rect.Top - $Expected.Top) -le 4 -and [Math]::Abs($Rect.Right - $Expected.Right) -le 4 -and [Math]::Abs($Rect.Bottom - $Expected.Bottom) -le 4
  if ($near) { Write-Host "Placement: $What came back at $got."; return @() }
  return @("placement: $What came back at $got, not $want")
}

function Test-WindowPlacementKept {
  $env:ARDIA_DATA_DIR = New-DataDirectory "placement-data"
  Set-Content -Path (Join-Path $env:ARDIA_DATA_DIR "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM
  $notes = @()
  $first = Start-PlacementRun "first"
  if ($first.Handle -eq [IntPtr]::Zero) { Stop-Process -Id $first.Process.Id -Force -ErrorAction SilentlyContinue; return @("placement: the first run showed no window") }
  $work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $placeWidth = [int]($work.Width * 0.7)
  $placeHeight = [int]($work.Height * 0.7)
  $placeX = $work.X + [int](($work.Width - $placeWidth) / 3)
  $placeY = $work.Y + [int](($work.Height - $placeHeight) / 3)
  Write-Host "Placement: the work area is $($work.Width)x$($work.Height); the window goes to $placeX,$placeY ${placeWidth}x$placeHeight."
  [ArdiaInput]::SetWindowPos($first.Handle, [IntPtr]::Zero, $placeX, $placeY, $placeWidth, $placeHeight, 0x0014) | Out-Null
  Start-Sleep -Milliseconds 800
  $placed = Get-WindowRect $first.Process
  [ArdiaInput]::ShowWindow($first.Handle, 3) | Out-Null
  Start-Sleep -Milliseconds 1200
  if (-not [ArdiaInput]::IsZoomed($first.Handle)) { $notes += "placement: the window did not maximize before the app quit" }
  Save-Screenshot (Join-Path $Out "placement-before-quit.png")
  $notes += @(Stop-PlacementRun $first "the maximized run")
  $saved = Join-Path $env:ARDIA_DATA_DIR "window-placement.txt"
  if (Test-Path $saved) { Write-Host "Placement: the app saved '$((Get-Content -Raw $saved).Trim())' as the last window placement." }
  else { $notes += "placement: the app saved no window-placement.txt when it quit" }

  $second = Start-PlacementRun "maximized"
  Save-Screenshot (Join-Path $Out "placement-relaunched-maximized.png")
  $how = Get-LastLogLine $second.Log "^window \d+ (placed |opened \S+ maximized)"
  Write-Host "Placement: the relaunch logged '$how'."
  if ($second.Handle -eq [IntPtr]::Zero) { $notes += "placement: the relaunch showed no window" }
  elseif (-not [ArdiaInput]::IsZoomed($second.Handle)) { $notes += "placement: a window maximized when the app quit came back not maximized ($(Get-WindowRect $second.Process | ForEach-Object { "$($_.Left),$($_.Top) $($_.Right - $_.Left)x$($_.Bottom - $_.Top)" }))" }
  else {
    Write-Host "Placement: a window maximized when the app quit came back maximized."
    [ArdiaInput]::ShowWindow($second.Handle, 9) | Out-Null
    Start-Sleep -Milliseconds 1200
    $notes += @(Test-RectNear (Get-WindowRect $second.Process) $placed "the maximized window, restored,")
  }
  $notes += @(Stop-PlacementRun $second "the restored run")

  $third = Start-PlacementRun "restored"
  Save-Screenshot (Join-Path $Out "placement-relaunched-restored.png")
  if ($third.Handle -eq [IntPtr]::Zero) { $notes += "placement: the third run showed no window" }
  elseif ([ArdiaInput]::IsZoomed($third.Handle)) { $notes += "placement: a window restored before the app quit came back maximized" }
  else { $notes += @(Test-RectNear (Get-WindowRect $third.Process) $placed "a window left restored") }
  $notes += @(Stop-PlacementRun $third "the last run")
  foreach ($name in "first", "maximized", "restored") {
    $runLog = Join-Path $Out "placement-$name.log"
    if ((Test-Path $runLog) -and (Select-String -Path $runLog -Pattern "^(js-error|fatal|error) " -Quiet)) {
      Select-String -Path $runLog -Pattern "^(js-error|fatal|error) " | ForEach-Object { Write-Host $_.Line }
      $notes += "placement: the $name run logged errors"
    }
  }
  return $notes
}

if (-not $NoInput) { Test-WindowPlacementKept | ForEach-Object { $failures += $_ } }

function Get-PageEvents {
  if (-not (Test-Path -LiteralPath $httpPagesLog)) { return @() }
  return @(Get-Content -LiteralPath $httpPagesLog | Where-Object { $_ -like "/event/*" })
}

function Send-Move([int]$FromX, [int]$FromY, [int]$ToX, [int]$ToY) {
  $screen = [System.Windows.Forms.SystemInformation]::PrimaryMonitorSize
  foreach ($step in 1..12) {
    $x = $FromX + [int](($ToX - $FromX) * $step / 12)
    $y = $FromY + [int](($ToY - $FromY) * $step / 12)
    [ArdiaInput]::mouse_event(0x8001, [uint32]($x * 65535 / ($screen.Width - 1)), [uint32]($y * 65535 / ($screen.Height - 1)), 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
  }
}

function Wait-PageEvent([string]$Name, [int]$After, [int]$Milliseconds) {
  $deadline = (Get-Date).AddMilliseconds($Milliseconds)
  do {
    $events = Get-PageEvents
    if (@($events | Select-Object -Skip $After) -contains "/event/$Name") { return $true }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Test-PageHoverEnds([System.Diagnostics.Process]$Process) {
  $handle = $Process.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { return @("hover: the window never showed") }
  [ArdiaInput]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 400
  $window = Get-WindowRect $Process
  $client = Get-ClientArea $Process
  if (-not $window -or -not $client) { return @("hover: the window could not be measured") }
  $x = $client.X + [int]($client.Width * 0.3)
  $inside = $client.Y + [int](60 * $client.Scale)
  $band = $client.Y + 2
  $before = @(Get-PageEvents).Count
  [ArdiaInput]::SetCursorPos($x, $inside + 20) | Out-Null
  Start-Sleep -Milliseconds 300
  Send-Move $x ($inside + 20) $x $inside
  if (-not (Wait-PageEvent "hovered" $before 3000)) { return @("hover: the page never reported the pointer over its strip (events: $((Get-PageEvents) -join ', '))") }
  Write-Host "Hover: the page reports the pointer over its strip."
  $entered = @(Get-PageEvents).Count
  Send-Move $x $inside $x $band
  Start-Sleep -Milliseconds 200
  if ($window.Top -ge 40) { $outX = $x; $outY = $window.Top - 30 } else { $outX = $window.Right + 30; $outY = $band }
  Send-Move $x $band $outX $outY
  if (Wait-PageEvent "left" $entered 3000) { Write-Host "Hover: leaving the window through the top band ended the page's hover."; return @() }
  return @("hover: after the pointer left the window through the top band over the page, the page never reported the hover ended (events: $((Get-PageEvents) -join ', '))")
}

function Get-HandleRect([IntPtr]$Handle) {
  $rect = New-Object ArdiaInput+Rect
  if (-not [ArdiaInput]::GetWindowRect($Handle, [ref]$rect)) { return $null }
  return $rect
}

function Test-PageDragStays([System.Diagnostics.Process]$Process, [string]$Layout) {
  $handle = $Process.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { return @("page drag ($Layout): the window never showed") }
  [ArdiaInput]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 400
  $client = Get-ClientArea $Process
  if (-not $client) { return @("page drag ($Layout): the window could not be measured") }
  $probe = New-Object ArdiaInput+Point
  $probe.X = $client.X + [int]($client.Width * 0.75)
  $probe.Y = $client.Y + [int]($client.Height * 0.6)
  $page = [ArdiaInput]::GetAncestor([ArdiaInput]::WindowFromPoint($probe), 2)
  if ($page -eq $handle -or $page -eq [IntPtr]::Zero) { return @("page drag ($Layout): no page window under ($($probe.X), $($probe.Y))") }
  $failures = @()
  $pageRect = Get-HandleRect $page
  $scale = $client.Scale
  $targets = @(
    @{ Name = "text"; X = $pageRect.Left + [int](60 * $scale); Y = $pageRect.Top + [int](132 * $scale); ByX = [int](240 * $scale); ByY = [int](20 * $scale); Event = "selected" },
    @{ Name = "empty area"; X = $pageRect.Left + [int](300 * $scale); Y = $pageRect.Top + [int](380 * $scale); ByX = [int](220 * $scale); ByY = [int](90 * $scale); Event = "released" },
    @{ Name = "text after a long press"; X = $pageRect.Left + [int](60 * $scale); Y = $pageRect.Top + [int](132 * $scale); ByX = [int](240 * $scale); ByY = [int](20 * $scale); Event = "selected"; Hold = 1200 },
    @{ Name = "link"; X = $pageRect.Left + [int](70 * $scale); Y = $pageRect.Top + [int](250 * $scale); ByX = [int](200 * $scale); ByY = [int](80 * $scale); Event = "dragstart" }
  )
  foreach ($target in $targets) {
    Send-Click ($pageRect.Left + [int](300 * $scale)) ($pageRect.Top + [int](380 * $scale))
    Start-Sleep -Milliseconds 300
    $appBefore = Get-WindowRect $Process
    $pageBefore = Get-HandleRect $page
    $events = @(Get-PageEvents).Count
    Send-Drag $target.X $target.Y $target.ByX $target.ByY $(if ($target.Hold) { $target.Hold } else { 200 })
    Start-Sleep -Milliseconds 700
    [ArdiaInput]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
    [ArdiaInput]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 300
    Save-Screenshot (Join-Path $Out "page-drag-$Layout-$($target.Name -replace ' ', '-').png")
    $appAfter = Get-WindowRect $Process
    $pageAfter = Get-HandleRect $page
    if (-not $appAfter -or -not $pageAfter) { $failures += "page drag ($Layout, $($target.Name)): a window was gone after the drag"; continue }
    $appMoved = "$($appAfter.Left - $appBefore.Left),$($appAfter.Top - $appBefore.Top)"
    $pageMoved = "$(($pageAfter.Left - $appAfter.Left) - ($pageBefore.Left - $appBefore.Left)),$(($pageAfter.Top - $appAfter.Top) - ($pageBefore.Top - $appBefore.Top))"
    $got = @(Get-PageEvents | Select-Object -Skip $events)
    Write-Host "Page drag ($Layout, $($target.Name)): the app window moved by $appMoved, the page window moved by $pageMoved against it, the page reported $($got -join ', ')."
    if ($appMoved -ne "0,0") { $failures += "page drag ($Layout, $($target.Name)): a drag inside the page moved the app window by $appMoved" }
    if ($pageMoved -ne "0,0") { $failures += "page drag ($Layout, $($target.Name)): a drag inside the page moved the page's own window by $pageMoved against the app window (#2051)" }
    if (-not (@($got) -contains "/event/$($target.Event)")) { $failures += "page drag ($Layout, $($target.Name)): the page never reported $($target.Event) for the drag (got: $($got -join ', '))" }
  }
  return $failures
}

function Get-PageInsets([System.Diagnostics.Process]$Process, [IntPtr]$Page) {
  $appRect = Get-WindowRect $Process
  $pageRect = Get-HandleRect $Page
  if (-not $appRect -or -not $pageRect) { return $null }
  return [pscustomobject]@{ App = $appRect; Text = "$($pageRect.Left - $appRect.Left),$($pageRect.Top - $appRect.Top),$($appRect.Right - $pageRect.Right),$($appRect.Bottom - $pageRect.Bottom)" }
}

function Test-PageHoldsPlace([System.Diagnostics.Process]$Process, [string]$Layout) {
  $handle = $Process.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { return @("page place ($Layout): the window never showed") }
  [ArdiaInput]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 400
  $client = Get-ClientArea $Process
  if (-not $client) { return @("page place ($Layout): the window could not be measured") }
  $probe = New-Object ArdiaInput+Point
  $probe.X = $client.X + [int]($client.Width * 0.75)
  $probe.Y = $client.Y + [int]($client.Height * 0.6)
  $page = [ArdiaInput]::GetAncestor([ArdiaInput]::WindowFromPoint($probe), 2)
  if ($page -eq $handle -or $page -eq [IntPtr]::Zero) { return @("page place ($Layout): no page window under ($($probe.X), $($probe.Y))") }
  $maximized = [ArdiaInput]::IsZoomed($handle)
  $scale = $client.Scale
  $byX = [int](180 * $scale)
  $byY = [int](90 * $scale)
  $failures = @()
  $appHome = Get-WindowRect $Process
  $steps = @("move", "async move", "move without notice", "resize")
  if (-not $maximized) { $steps += "move command" }
  foreach ($step in $steps) {
    $before = Get-PageInsets $Process $page
    $pageRect = Get-HandleRect $page
    if (-not $before -or -not $pageRect) { $failures += "page place ($Layout, $step): a window was gone before the step"; break }
    $called = $true
    switch ($step) {
      "move" { $called = [ArdiaInput]::SetWindowPos($page, [IntPtr]::Zero, $pageRect.Left + $byX, $pageRect.Top + $byY, 0, 0, 0x0215) }
      "async move" { $called = [ArdiaInput]::SetWindowPos($page, [IntPtr]::Zero, $pageRect.Left + $byX, $pageRect.Top + $byY, 0, 0, 0x4215) }
      "move without notice" { $called = [ArdiaInput]::SetWindowPos($page, [IntPtr]::Zero, $pageRect.Left + $byX, $pageRect.Top + $byY, 0, 0, 0x0615) }
      "resize" { $called = [ArdiaInput]::SetWindowPos($page, [IntPtr]::Zero, 0, 0, ($pageRect.Right - $pageRect.Left) - $byX, ($pageRect.Bottom - $pageRect.Top) - $byY, 0x0216) }
      "move command" {
        $pressX = $pageRect.Left + [int](300 * $scale)
        $pressY = $pageRect.Top + [int](380 * $scale)
        [ArdiaInput]::SetCursorPos($pressX, $pressY) | Out-Null
        Start-Sleep -Milliseconds 250
        [ArdiaInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 150
        $called = [ArdiaInput]::PostMessage($page, 0x0112, [IntPtr]0xF012, [IntPtr](($pressY -shl 16) -bor ($pressX -band 0xFFFF)))
        Start-Sleep -Milliseconds 300
        $screen = [System.Windows.Forms.SystemInformation]::PrimaryMonitorSize
        foreach ($i in 1..12) {
          $toX = $pressX + [int]($byX * $i / 12)
          $toY = $pressY + [int]($byY * $i / 12)
          [ArdiaInput]::mouse_event(0x8001, [uint32]($toX * 65535 / ($screen.Width - 1)), [uint32]($toY * 65535 / ($screen.Height - 1)), 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 40
        }
        Start-Sleep -Milliseconds 200
        [ArdiaInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 200
        [ArdiaInput]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
        [ArdiaInput]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
      }
    }
    if (-not $called) { $failures += "page place ($Layout, $step): the call to the page window failed, so the step proves nothing"; continue }
    if ($step -in @("move", "resize")) {
      $atReturn = Get-PageInsets $Process $page
      if ($atReturn -and $atReturn.Text -ne $before.Text) { $failures += "page place ($Layout, $step): when the call returned the page window had already left its place, insets $($atReturn.Text) instead of $($before.Text), so the change was let through instead of refused (#2051)" }
    }
    $samples = @()
    foreach ($i in 1..30) {
      Start-Sleep -Milliseconds 100
      $sample = Get-PageInsets $Process $page
      if ($sample) { $samples += $sample.Text }
    }
    $after = Get-PageInsets $Process $page
    if (-not $after) { $failures += "page place ($Layout, $step): a window was gone after the step"; break }
    Save-Screenshot (Join-Path $Out "page-place-$Layout-$($step -replace ' ', '-').png")
    $away = @($samples | Where-Object { $_ -ne $before.Text } | Select-Object -Unique)
    $appMoved = "$($after.App.Left - $before.App.Left),$($after.App.Top - $before.App.Top),$($after.App.Right - $before.App.Right),$($after.App.Bottom - $before.App.Bottom)"
    Write-Host "Page place ($Layout, $step): the page's insets in the app window were $($before.Text), then $($after.Text) after 3 s, away from their place in $($away.Count) distinct samples ($($away -join ' ')); the app window's edges moved by $appMoved."
    if ($after.Text -ne $before.Text) { $failures += "page place ($Layout, $step): the page window left its place in the app window, insets $($before.Text) became $($after.Text) (#2051)" }
    if ($step -in @("move", "async move", "resize") -and $away.Count -gt 0) { $failures += "page place ($Layout, $step): the page window left its place for a while, insets $($away -join ' ') instead of $($before.Text) (#2051)" }
    $wanted = if ($step -eq "move command") { "$byX,$byY,$byX,$byY" } else { "0,0,0,0" }
    $parts = $appMoved -split ","
    $wantedParts = $wanted -split ","
    $close = $true
    foreach ($i in 0..3) { if ([Math]::Abs([int]$parts[$i] - [int]$wantedParts[$i]) -gt 3) { $close = $false } }
    if (-not $close) { $failures += "page place ($Layout, $step): the app window's edges moved by $appMoved, not $wanted" }
    if (-not $maximized -and $appMoved -ne "0,0,0,0") {
      [ArdiaInput]::SetWindowPos($handle, [IntPtr]::Zero, $appHome.Left, $appHome.Top, $appHome.Right - $appHome.Left, $appHome.Bottom - $appHome.Top, 0x0214) | Out-Null
      Start-Sleep -Milliseconds 1200
    }
  }
  if ($maximized) { return $failures }
  $before = Get-PageInsets $Process $page
  $pageRect = Get-HandleRect $page
  $events = @(Get-PageEvents).Count
  Send-Click ($pageRect.Left + [int](120 * $scale)) ($pageRect.Top + [int](340 * $scale))
  if (-not (Wait-PageEvent "fullscreen" $events 5000)) { return $failures + "page place ($Layout, full screen): the page never went full screen from its button (events: $(@(Get-PageEvents | Select-Object -Skip $events) -join ', '))" }
  Start-Sleep -Milliseconds 1500
  $whileFull = Get-HandleRect $page
  Save-Screenshot (Join-Path $Out "page-place-$Layout-full-screen.png")
  [ArdiaInput]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
  [ArdiaInput]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
  if (-not (Wait-PageEvent "windowed" $events 5000)) { return $failures + "page place ($Layout, full screen): Escape never took the page out of full screen" }
  Start-Sleep -Milliseconds 2500
  $after = Get-PageInsets $Process $page
  Save-Screenshot (Join-Path $Out "page-place-$Layout-after-full-screen.png")
  $fullText = if ($whileFull) { "$($whileFull.Left),$($whileFull.Top),$($whileFull.Right),$($whileFull.Bottom)" } else { "unknown" }
  Write-Host "Page place ($Layout, full screen): the page window was at $fullText while full screen; its insets in the app window were $($before.Text) before and $($after.Text) after leaving it; the app window's edges moved by $($after.App.Left - $before.App.Left),$($after.App.Top - $before.App.Top),$($after.App.Right - $before.App.Right),$($after.App.Bottom - $before.App.Bottom)."
  if (-not $after -or $after.Text -ne $before.Text) { $failures += "page place ($Layout, full screen): after leaving full screen the page's insets were $($after.Text), not $($before.Text)" }
  if ($after -and ($after.App.Left -ne $before.App.Left -or $after.App.Top -ne $before.App.Top -or $after.App.Right -ne $before.App.Right -or $after.App.Bottom -ne $before.App.Bottom)) { $failures += "page place ($Layout, full screen): the app window did not come back to its place after full screen" }
  return $failures
}

function Test-TopEdgeResize([System.Diagnostics.Process]$Process) {
  $handle = $Process.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { return @("top edge: the window never showed") }
  [ArdiaInput]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 400
  $before = Get-WindowRect $Process
  $client = Get-ClientArea $Process
  if (-not $before -or -not $client) { return @("top edge: the window could not be measured") }
  $press = New-Object ArdiaInput+Point
  $press.X = $client.X + [int]($client.Width * 0.3)
  $press.Y = $client.Y + 2
  $class = New-Object System.Text.StringBuilder 256
  [ArdiaInput]::GetClassName([ArdiaInput]::WindowFromPoint($press), $class, 256) | Out-Null
  $under = $class.ToString()
  Write-Host "Top edge: the window under ($($press.X), $($press.Y)) is $under."
  Save-Screenshot (Join-Path $Out "top-edge-before.png")
  if (-not $under.StartsWith("Chrome_")) { return @("top edge: the press point is over $under, not a page window, so the drag would prove nothing") }
  Send-Drag $press.X $press.Y 0 40 300
  Start-Sleep -Milliseconds 700
  Save-Screenshot (Join-Path $Out "top-edge-after.png")
  $after = Get-WindowRect $Process
  if (-not $after) { return @("top edge: the window was gone after the drag") }
  $topMoved = $after.Top - $before.Top
  $bottomMoved = $after.Bottom - $before.Bottom
  if ([Math]::Abs($topMoved - 40) -le 8 -and [Math]::Abs($bottomMoved) -le 2) { Write-Host "Top edge: dragging the top band over the page down by 40 px resized the window from the top (top moved $topMoved px, bottom stayed)."; return @() }
  return @("top edge: dragging the top band over the page down by 40 px moved the window's top by $topMoved px and its bottom by $bottomMoved px; it should resize from the top")
}

$edgeLog = Join-Path $Out "top-edge.log"
$env:ARDIA_DATA_DIR = New-DataDirectory "top-edge-data"
$env:ARDIA_CONFIG_DIR = $env:ARDIA_DATA_DIR
Set-Content -Path (Join-Path $env:ARDIA_DATA_DIR "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM
Set-Content -Path (Join-Path $env:ARDIA_DATA_DIR "config.json") -Value '{"settings":{"minimalismMode":true,"sidebarSide":"right","openLinksInLittleArdia":false,"developerModeSites":{"127.0.0.1":false}}}' -Encoding utf8NoBOM
if ($withEngineForEdge -and -not $NoInput -and $httpPagesUp) {
  $edge = Start-Process -FilePath $App -ArgumentList "--log-file=`"$edgeLog`"", "http://127.0.0.1:$httpPagesPort/hover" -PassThru
  $env:ARDIA_CONFIG_DIR = ""
  try {
    Start-Sleep -Seconds 12
    if ($edge.HasExited) { $failures += "top edge: the app exited on its own (exit code $($edge.ExitCode))" }
    else {
      Test-PageHoverEnds $edge | ForEach-Object { $failures += $_ }
      Test-TopEdgeResize $edge | ForEach-Object { $failures += $_ }
    }
  } finally {
    if (-not $edge.HasExited) {
      Stop-Process -Id $edge.Id -Force
      $edge.WaitForExit(10000) | Out-Null
    }
  }
}
$env:ARDIA_CONFIG_DIR = ""

if ($Part -ne "gate" -and $withEngineForEdge -and -not $NoInput -and $httpPagesUp) {
  foreach ($layout in @(@{ Name = "sidebar-left"; Settings = '{"settings":{"openLinksInLittleArdia":false}}' }, @{ Name = "minimal-right"; Settings = '{"settings":{"minimalismMode":true,"sidebarSide":"right","openLinksInLittleArdia":false,"developerModeSites":{"127.0.0.1":false}}}' })) {
    $dragLog = Join-Path $Out "page-drag-$($layout.Name).log"
    $env:ARDIA_DATA_DIR = New-DataDirectory "page-drag-$($layout.Name)-data"
    $env:ARDIA_CONFIG_DIR = $env:ARDIA_DATA_DIR
    Set-Content -Path (Join-Path $env:ARDIA_DATA_DIR "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM
    Set-Content -Path (Join-Path $env:ARDIA_DATA_DIR "config.json") -Value $layout.Settings -Encoding utf8NoBOM
    $dragApp = Start-Process -FilePath $App -ArgumentList "--log-file=`"$dragLog`"", "http://127.0.0.1:$httpPagesPort/drag" -PassThru
    $env:ARDIA_CONFIG_DIR = ""
    try {
      Start-Sleep -Seconds 12
      if ($dragApp.HasExited) { $failures += "page drag ($($layout.Name)): the app exited on its own (exit code $($dragApp.ExitCode))" }
      else {
        Test-PageDragStays $dragApp $layout.Name | ForEach-Object { $failures += $_ }
        Test-PageHoldsPlace $dragApp $layout.Name | ForEach-Object { $failures += $_ }
        $dragApp.Refresh()
        [ArdiaInput]::ShowWindow($dragApp.MainWindowHandle, 3) | Out-Null
        Start-Sleep -Seconds 2
        Test-PageDragStays $dragApp "$($layout.Name)-maximized" | ForEach-Object { $failures += $_ }
        Test-PageHoldsPlace $dragApp "$($layout.Name)-maximized" | ForEach-Object { $failures += $_ }
      }
    } finally {
      if (-not $dragApp.HasExited) {
        Stop-Process -Id $dragApp.Id -Force
        $dragApp.WaitForExit(10000) | Out-Null
      }
    }
  }
}
$env:ARDIA_CONFIG_DIR = ""

if ($Part -ne "gate" -and $withEngineForEdge -and -not $NoInput -and $httpPagesUp) {
  if (-not ([System.Management.Automation.PSTypeName]"ArdiaSnapKeys").Type) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class ArdiaSnapKeys {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect rect, int size);
}
"@
  }

  function Get-SnapDescription([IntPtr]$Window) {
    if ($Window -eq [IntPtr]::Zero) { return "none" }
    $class = New-Object System.Text.StringBuilder 256
    [ArdiaInput]::GetClassName($Window, $class, 256) | Out-Null
    $style = [ArdiaSnapKeys]::GetWindowLongPtr($Window, -16).ToInt64()
    $extended = [ArdiaSnapKeys]::GetWindowLongPtr($Window, -20).ToInt64()
    return "$($class.ToString()) (style 0x$($style.ToString('X8')), extended 0x$($extended.ToString('X8')))"
  }

  function Get-SnapBounds([IntPtr]$Window) {
    $rect = New-Object ArdiaSnapKeys+Rect
    if ([ArdiaSnapKeys]::DwmGetWindowAttribute($Window, 9, [ref]$rect, 16) -ne 0) { return $null }
    return $rect
  }

  function Send-WindowsArrow([byte]$Arrow) {
    [ArdiaInput]::keybd_event(0x5B, 0, 1, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [ArdiaInput]::keybd_event($Arrow, 0, 1, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [ArdiaInput]::keybd_event($Arrow, 0, 3, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [ArdiaInput]::keybd_event(0x5B, 0, 3, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 1500
  }

  function Set-SnapHome([IntPtr]$Handle, $Work) {
    [ArdiaInput]::ShowWindow($Handle, 9) | Out-Null
    Start-Sleep -Milliseconds 600
    [ArdiaInput]::SetWindowPos($Handle, [IntPtr]::Zero, $Work.X + 60, $Work.Y + 40, [Math]::Min(960, $Work.Width - 120), [Math]::Min(620, $Work.Height - 80), 0x0014) | Out-Null
    Start-Sleep -Milliseconds 900
  }

  function Set-SnapFocus([System.Diagnostics.Process]$Process, [string]$Where) {
    $handle = $Process.MainWindowHandle
    [ArdiaInput]::SetForegroundWindow($handle) | Out-Null
    Start-Sleep -Milliseconds 300
    $client = Get-ClientArea $Process
    if (-not $client) { return }
    if ($Where -eq "page") { Send-Click ($client.X + [int]($client.Width * 0.7)) ($client.Y + [int]($client.Height * 0.65)) }
    else { Send-Click ($client.X + [int](24 * $client.Scale)) ($client.Y + [int]($client.Height * 0.62)) }
    Start-Sleep -Milliseconds 500
  }

  function Test-SnapFocusHeld([IntPtr]$Handle, [string]$Where) {
    $foreground = [ArdiaSnapKeys]::GetForegroundWindow()
    $class = New-Object System.Text.StringBuilder 256
    [ArdiaInput]::GetClassName($foreground, $class, 256) | Out-Null
    if ($Where -eq "page") { return $class.ToString().StartsWith("Chrome_") -and [ArdiaSnapKeys]::GetWindow($foreground, 4) -eq $Handle }
    return $foreground -eq $Handle
  }

  function Get-KeyboardPlace([IntPtr]$Handle) {
    $foreground = [ArdiaSnapKeys]::GetForegroundWindow()
    if (Test-SnapFocusHeld $Handle "page") { return "the page" }
    if ($foreground -eq $Handle) { return "the app window" }
    return "another window, $(Get-SnapDescription $foreground)"
  }

  function Send-HeldWindowsKeys([byte[]]$Keys) {
    [ArdiaInput]::keybd_event(0x5B, 0, 1, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 300
    foreach ($key in $Keys) {
      $extended = if ($key -ge 0x25 -and $key -le 0x28) { 1 } else { 0 }
      [ArdiaInput]::keybd_event($key, 0, $extended, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 60
      [ArdiaInput]::keybd_event($key, 0, $extended + 2, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 300
    }
    [ArdiaInput]::keybd_event(0x5B, 0, 3, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 1500
  }

  function Test-SnapKeys([System.Diagnostics.Process]$Process, [string]$Where, [string]$Label = $Where, [switch]$Held) {
    $handle = $Process.MainWindowHandle
    if ($handle -eq [IntPtr]::Zero) { return @("snap keys ($Label): the window never showed") }
    $work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $failures = @()
    $steps = @(
      @{ Name = "Win+Up"; Arrow = 0x26; Home = $true; Want = "maximized" },
      @{ Name = "Win+Down"; Arrow = 0x28; Home = $false; Want = "restored" },
      @{ Name = "Win+Down again"; Arrow = 0x28; Home = $false; Want = "minimized" },
      @{ Name = "Win+Left"; Arrow = 0x25; Home = $true; Want = "left half" },
      @{ Name = "Win+Right"; Arrow = 0x27; Home = $true; Want = "right half" }
    )
    $start = $null
    foreach ($step in $steps) {
      if ($step.Home) {
        Set-SnapHome $handle $work
        Set-SnapFocus $Process $Where
      }
      if (-not $start) { $start = Get-SnapBounds $handle }
      $foreground = Get-SnapDescription ([ArdiaSnapKeys]::GetForegroundWindow())
      if (-not (Test-SnapFocusHeld $handle $Where)) {
        $how = if ($step.Home) { "after a click there" } else { "kept from the step before, without a new click" }
        $failures += "snap keys ($Label): before $($step.Name) the keyboard was not in the $Where ($how); the foreground window was $foreground"
        Write-Host "Snap keys ($Label): before $($step.Name) the foreground window was $foreground, not the $Where; the step is skipped."
        continue
      }
      $before = Get-SnapBounds $handle
      if ($Held) { Send-HeldWindowsKeys @([byte]$step.Arrow) } else { Send-WindowsArrow ([byte]$step.Arrow) }
      $zoomed = [ArdiaInput]::IsZoomed($handle)
      $iconic = [ArdiaInput]::IsIconic($handle)
      $after = Get-SnapBounds $handle
      Save-Screenshot (Join-Path $Out "snap-keys-$Where-$($step.Name -replace '[ +]', '-').png")
      $place = if ($after) { "$($after.Left),$($after.Top),$($after.Right),$($after.Bottom)" } else { "unknown" }
      $was = if ($before) { "$($before.Left),$($before.Top),$($before.Right),$($before.Bottom)" } else { "unknown" }
      $half = [int]($work.Width / 2)
      $near = { param($a, $b) [Math]::Abs($a - $b) -le 16 }
      $got = switch ($step.Want) {
        "maximized" { $zoomed }
        "restored" { -not $zoomed -and -not $iconic -and $after -and $start -and (& $near $after.Left $start.Left) -and (& $near $after.Top $start.Top) -and (& $near $after.Right $start.Right) -and (& $near $after.Bottom $start.Bottom) }
        "minimized" { $iconic }
        "left half" { $after -and -not $iconic -and (& $near $after.Left $work.Left) -and (& $near $after.Right ($work.Left + $half)) -and (& $near $after.Top $work.Top) -and (& $near $after.Bottom $work.Bottom) }
        "right half" { $after -and -not $iconic -and (& $near $after.Left ($work.Left + $half)) -and (& $near $after.Right $work.Right) -and (& $near $after.Top $work.Top) -and (& $near $after.Bottom $work.Bottom) }
      }
      Write-Host "Snap keys ($Label): $($step.Name) with the foreground window $foreground; the window was at $was and is at $place (maximized $zoomed, minimized $iconic; the work area is $($work.Left),$($work.Top),$($work.Right),$($work.Bottom)); wanted $($step.Want): $got."
      if (-not $got) { $failures += "snap keys ($Label): $($step.Name) did not leave the window $($step.Want) (maximized $zoomed, minimized $iconic, at $place; the foreground window was $foreground)" }
      if ($step.Arrow -eq 0x25 -or $step.Arrow -eq 0x27) {
        [ArdiaInput]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
        [ArdiaInput]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 400
      }
      $place = Get-KeyboardPlace $handle
      Write-Host "Snap keys ($Label): after $($step.Name) the keyboard is in $place."
      if ($Held -and $Where -eq "page" -and $step.Want -ne "minimized" -and $place -ne "the page") { $failures += "snap keys ($Label): after $($step.Name) the keyboard was not back in the page (it is in $place)" }
    }
    Set-SnapHome $handle $work
    return $failures
  }

  function Get-SnapChain([System.Diagnostics.Process]$Process, [string]$Where, [string]$Label) {
    $handle = $Process.MainWindowHandle
    $work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    Set-SnapHome $handle $work
    Set-SnapFocus $Process $Where
    $ready = Test-SnapFocusHeld $handle $Where
    Send-HeldWindowsKeys @([byte]0x25, [byte]0x26)
    $bounds = Get-SnapBounds $handle
    $zoomed = [ArdiaInput]::IsZoomed($handle)
    $iconic = [ArdiaInput]::IsIconic($handle)
    Save-Screenshot (Join-Path $Out "snap-keys-$($Label -replace '[ ,+]', '-')-chain.png")
    [ArdiaInput]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
    [ArdiaInput]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 600
    $place = Get-KeyboardPlace $handle
    $at = if ($bounds) { "$($bounds.Left),$($bounds.Top),$($bounds.Right),$($bounds.Bottom)" } else { "unknown" }
    Write-Host "Snap keys ($Label): Win+Left then Up in one Windows key press, the keyboard in the $Where first ($ready): the window is at $at (maximized $zoomed, minimized $iconic); after Escape the keyboard is in $place."
    Set-SnapHome $handle $work
    return @{ Ready = $ready; Bounds = $bounds; Zoomed = $zoomed; Iconic = $iconic; Place = $place }
  }

  function Test-SnapChainLike($Chain, $Control, [string]$Label) {
    if (-not $Control -or -not $Control.Bounds) { return @("snap keys ($Label): the sidebar's Win+Left then Up gave nothing to compare with") }
    if (-not $Chain.Ready) { return @("snap keys ($Label): the keyboard was not in the page before Win+Left then Up") }
    $near = { param($a, $b) [Math]::Abs($a - $b) -le 16 }
    $same = $Chain.Bounds -and $Chain.Zoomed -eq $Control.Zoomed -and $Chain.Iconic -eq $Control.Iconic -and (& $near $Chain.Bounds.Left $Control.Bounds.Left) -and (& $near $Chain.Bounds.Top $Control.Bounds.Top) -and (& $near $Chain.Bounds.Right $Control.Bounds.Right) -and (& $near $Chain.Bounds.Bottom $Control.Bounds.Bottom)
    if ($same) { return @() }
    $got = if ($Chain.Bounds) { "$($Chain.Bounds.Left),$($Chain.Bounds.Top),$($Chain.Bounds.Right),$($Chain.Bounds.Bottom)" } else { "unknown" }
    $want = "$($Control.Bounds.Left),$($Control.Bounds.Top),$($Control.Bounds.Right),$($Control.Bounds.Bottom)"
    return @("snap keys ($Label): Win+Left then Up in one Windows key press left the window at $got, not where the sidebar's left it ($want)")
  }

  function Test-HeldFieldKeys([System.Diagnostics.Process]$Process, [string]$Label, [string[]]$Letters) {
    $handle = $Process.MainWindowHandle
    $work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    Set-SnapHome $handle $work
    Set-SnapFocus $Process "page"
    $failures = @()
    $typed = ""
    $presses = @(@{ Name = "Win+V"; Key = 0x56 }, @{ Name = "Win+."; Key = 0xBE }, @{ Name = "a Windows key tap"; Key = 0 })
    for ($index = 0; $index -lt $presses.Count; $index++) {
      $press = $presses[$index]
      $before = Get-KeyboardPlace $handle
      if ($press.Key) { Send-HeldWindowsKeys @([byte]$press.Key) }
      else {
        [ArdiaInput]::keybd_event(0x5B, 0, 1, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 100
        [ArdiaInput]::keybd_event(0x5B, 0, 3, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 1500
      }
      $shown = Get-SnapDescription ([ArdiaSnapKeys]::GetForegroundWindow())
      [ArdiaInput]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
      [ArdiaInput]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 1000
      $place = Get-KeyboardPlace $handle
      $typed += $Letters[$index]
      Send-Text $Letters[$index]
      Start-Sleep -Milliseconds 800
      $reached = (Test-Path $httpPagesLog) -and @(Select-String -Path $httpPagesLog -SimpleMatch "/event/typed?$typed").Count -gt 0
      Write-Host "Snap keys ($Label): $($press.Name) from the page's text box: before it the keyboard was in $before; with it pressed the foreground window was $shown; after Escape the keyboard is in $place; typing reached the text box: $reached."
      if (-not $reached) { $failures += "snap keys ($Label): after $($press.Name) and Escape typing did not reach the page's text box (the keyboard is in $place)" }
    }
    Set-SnapHome $handle $work
    return $failures
  }

  function Test-PopupSnapKeys([System.Diagnostics.Process]$Process) {
    $handle = $Process.MainWindowHandle
    Set-SnapHome $handle ([System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea)
    Set-SnapFocus $Process "page"
    Start-Sleep -Seconds 3
    $popupPage = [ArdiaSnapKeys]::GetForegroundWindow()
    $popup = [ArdiaSnapKeys]::GetWindow($popupPage, 4)
    $class = New-Object System.Text.StringBuilder 256
    [ArdiaInput]::GetClassName($popupPage, $class, 256) | Out-Null
    if (-not $class.ToString().StartsWith("Chrome_") -or $popup -eq [IntPtr]::Zero -or $popup -eq $handle) {
      Write-Host "Snap keys (pop-up page): no pop-up window's page came to the front (the foreground window is $(Get-SnapDescription $popupPage)), so the pop-up step is not checked."
      return @()
    }
    $box = Get-SnapBounds $popupPage
    if ($box) { Send-Click ([int](($box.Left + $box.Right) / 2)) ([int](($box.Top + $box.Bottom) / 2)) }
    Start-Sleep -Milliseconds 500
    $ready = [ArdiaSnapKeys]::GetForegroundWindow() -eq $popupPage
    $before = Get-SnapBounds $popup
    Send-HeldWindowsKeys @([byte]0x26)
    $after = Get-SnapBounds $popup
    $front = [ArdiaSnapKeys]::GetForegroundWindow()
    Send-Text "w"
    Start-Sleep -Milliseconds 800
    $reached = (Test-Path $httpPagesLog) -and @(Select-String -Path $httpPagesLog -SimpleMatch "/event/typed?w").Count -gt 0
    $was = if ($before) { "$($before.Left),$($before.Top),$($before.Right),$($before.Bottom)" } else { "unknown" }
    $now = if ($after) { "$($after.Left),$($after.Top),$($after.Right),$($after.Bottom)" } else { "unknown" }
    $kept = $front -eq $popupPage
    Write-Host "Snap keys (pop-up page): the keyboard in the pop-up's page first ($ready); after Win+Up with the Windows key held the pop-up was at $was and is at $now, the foreground window is $(Get-SnapDescription $front) (the pop-up's page: $kept), typing reached its text box: $reached."
    Send-Chord @([byte]0x11) ([byte]0x57)
    if (-not $ready) { return @("snap keys (pop-up page): the keyboard was not in the pop-up's page after a click there") }
    $failures = @()
    if (-not $before -or -not $after) { $failures += "snap keys (pop-up page): the pop-up window's position could not be read before and after Win+Up (before $was, after $now)" }
    elseif ($was -ne $now) { $failures += "snap keys (pop-up page): Win+Up moved the pop-up window from $was to $now" }
    if (-not ($kept -and $reached)) { $failures += "snap keys (pop-up page): after Win+Up the pop-up's page lost the keyboard (the foreground window is $(Get-SnapDescription $front); typing reached it: $reached)" }
    return $failures
  }

  Enable-WindowSnapping
  $snapLog = Join-Path $Out "snap-keys.log"
  $env:ARDIA_DATA_DIR = New-DataDirectory "snap-keys-data"
  $env:ARDIA_CONFIG_DIR = $env:ARDIA_DATA_DIR
  Set-Content -Path (Join-Path $env:ARDIA_DATA_DIR "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM
  Set-Content -Path (Join-Path $env:ARDIA_DATA_DIR "config.json") -Value '{"settings":{"openLinksInLittleArdia":false}}' -Encoding utf8NoBOM
  $snapApp = Start-Process -FilePath $App -ArgumentList "--log-file=`"$snapLog`"", "http://127.0.0.1:$httpPagesPort/a" -PassThru
  $env:ARDIA_CONFIG_DIR = ""
  try {
    Start-Sleep -Seconds 12
    if ($snapApp.HasExited) { $failures += "snap keys: the app exited on its own (exit code $($snapApp.ExitCode))" }
    else {
      $snapApp.Refresh()
      Test-SnapKeys $snapApp "sidebar" | ForEach-Object { $failures += $_ }
      Test-SnapKeys $snapApp "page" | ForEach-Object { $failures += $_ }
      if (Test-Path $snapLog) { Select-String -Path $snapLog -Pattern "snap keys" | ForEach-Object { Write-Host "Snap keys log: $($_.Line)" } }
    }
  } finally {
    if (-not $snapApp.HasExited) {
      Stop-Process -Id $snapApp.Id -Force
      $snapApp.WaitForExit(10000) | Out-Null
    }
  }
  $heldLog = Join-Path $Out "snap-keys-held.log"
  $env:ARDIA_DATA_DIR = New-DataDirectory "snap-keys-held-data"
  $env:ARDIA_CONFIG_DIR = $env:ARDIA_DATA_DIR
  Set-Content -Path (Join-Path $env:ARDIA_DATA_DIR "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM
  Set-Content -Path (Join-Path $env:ARDIA_DATA_DIR "config.json") -Value '{"settings":{"openLinksInLittleArdia":false}}' -Encoding utf8NoBOM
  $heldApp = Start-Process -FilePath $App -ArgumentList "--log-file=`"$heldLog`"", "http://127.0.0.1:$httpPagesPort/field" -PassThru
  $env:ARDIA_CONFIG_DIR = ""
  try {
    Start-Sleep -Seconds 12
    if ($heldApp.HasExited) { $failures += "snap keys (Windows key held): the app exited on its own (exit code $($heldApp.ExitCode))" }
    else {
      $heldApp.Refresh()
      Test-SnapKeys $heldApp "sidebar" "sidebar, Windows key held" -Held | ForEach-Object { $failures += $_ }
      $chainControl = Get-SnapChain $heldApp "sidebar" "sidebar, Windows key held"
      Test-SnapKeys $heldApp "page" "page, Windows key held" -Held | ForEach-Object { $failures += $_ }
      $chain = Get-SnapChain $heldApp "page" "page, Windows key held"
      Test-SnapChainLike $chain $chainControl "page, Windows key held" | ForEach-Object { $failures += $_ }
      if ($chain.Place -ne "the page") { $failures += "snap keys (page, Windows key held): after Win+Left then Up and Escape the keyboard was not back in the page (it is in $($chain.Place))" }
      Test-HeldFieldKeys $heldApp "page, Windows key held" @("k", "j", "q") | ForEach-Object { $failures += $_ }
      if (Test-Path $heldLog) { Select-String -Path $heldLog -Pattern "snap keys" | ForEach-Object { Write-Host "Snap keys log (Windows key held): $($_.Line)" } }
    }
  } finally {
    if (-not $heldApp.HasExited) {
      Stop-Process -Id $heldApp.Id -Force
      $heldApp.WaitForExit(10000) | Out-Null
    }
  }
  $popupLog = Join-Path $Out "snap-keys-popup.log"
  $env:ARDIA_DATA_DIR = New-DataDirectory "snap-keys-popup-data"
  $env:ARDIA_CONFIG_DIR = $env:ARDIA_DATA_DIR
  Set-Content -Path (Join-Path $env:ARDIA_DATA_DIR "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM
  Set-Content -Path (Join-Path $env:ARDIA_DATA_DIR "config.json") -Value '{"settings":{"openLinksInLittleArdia":false}}' -Encoding utf8NoBOM
  $popupApp = Start-Process -FilePath $App -ArgumentList "--log-file=`"$popupLog`"", "http://127.0.0.1:$httpPagesPort/opener" -PassThru
  $env:ARDIA_CONFIG_DIR = ""
  try {
    Start-Sleep -Seconds 12
    if ($popupApp.HasExited) { $failures += "snap keys (pop-up page): the app exited on its own (exit code $($popupApp.ExitCode))" }
    else {
      $popupApp.Refresh()
      Test-PopupSnapKeys $popupApp | ForEach-Object { $failures += $_ }
      if (Test-Path $popupLog) { Select-String -Path $popupLog -Pattern "snap keys" | ForEach-Object { Write-Host "Snap keys log (pop-up page): $($_.Line)" } }
    }
  } finally {
    if (-not $popupApp.HasExited) {
      Stop-Process -Id $popupApp.Id -Force
      $popupApp.WaitForExit(10000) | Out-Null
    }
  }
  $env:ARDIA_CONFIG_DIR = ""
}

if ($Part -ne "gate" -and $withEngineForEdge -and -not $NoInput -and $httpPagesUp) {
  $peekLog = Join-Path $Out "self-check-linkPeeks.log"
  $env:ARDIA_DATA_DIR = New-DataDirectory "link-peeks-data"
  $env:ARDIA_TEST = "selfCheckStage=linkPeeks,httpPages=$httpPagesPort"
  $peekRun = Start-Process -FilePath $App -ArgumentList "--self-check", "--log-file=`"$peekLog`"" -PassThru
  $env:ARDIA_TEST = ""
  $clicked = @{}
  $peekBy = (Get-Date).AddSeconds(240)
  try {
    while (-not $peekRun.HasExited -and (Get-Date) -lt $peekBy) {
      if (Test-Path $peekLog) {
        foreach ($ready in @(Select-String -Path $peekLog -Pattern "peek stage ready (\w+) try (\d+) at (-?\d+),(-?\d+) page window (-?\d+),(-?\d+),(\d+),(\d+)")) {
          $groups = $ready.Matches[0].Groups
          $try = "$($groups[1].Value) try $($groups[2].Value)"
          if ($clicked.ContainsKey($try)) { continue }
          $clicked[$try] = $true
          $miss = Send-PeekClick $peekRun ([int]$groups[3].Value) ([int]$groups[4].Value) @([int]$groups[5].Value, [int]$groups[6].Value, [int]$groups[7].Value, [int]$groups[8].Value)
          if ($miss) { Write-Host "Link peeks: $($try): not clicked, $miss." }
          else { Write-Host "Link peeks: $($try): a real Shift+click on the page window." }
        }
      }
      Start-Sleep -Milliseconds 200
    }
    if (-not $peekRun.HasExited) { $failures += "link peeks (real input): the stage did not finish within 240 s" }
    elseif (-not (Test-Path $peekLog)) { $failures += "link peeks (real input): the stage wrote no log" }
    else {
      Select-String -Path $peekLog -Pattern "self-check" | ForEach-Object { Write-Host $_.Line }
      $peekDone = Select-String -Path $peekLog -Pattern "self-check done: (\d+) passed, (\d+) failed" | Select-Object -First 1
      if (-not $peekDone) { $failures += "link peeks (real input): the stage never reported its result" }
      elseif ([int]$peekDone.Matches[0].Groups[2].Value -gt 0 -or [int]$peekDone.Matches[0].Groups[1].Value -ne 3) { $failures += "link peeks (real input): $($peekDone.Line)" }
    }
  } finally {
    [ArdiaInput]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
    if (-not $peekRun.HasExited) {
      Stop-Process -Id $peekRun.Id -Force
      $peekRun.WaitForExit(10000) | Out-Null
    }
  }
}

$env:ARDIA_DATA_DIR = New-DataDirectory "self-check-data"
$importFixtures = Join-Path $env:ARDIA_DATA_DIR "import-fixtures"
$fixtureProfiles = Join-Path $PSScriptRoot "..\..\packages\import\fixtures\home\Library\Application Support"
foreach ($fixture in @(@("firefox", "Firefox\Profiles\abcd1234.default-release"), @("work", "Firefox\Profiles\zzzz9999.work"), @("zen", "zen\Profiles\zen12345.Default (release)"), @("chrome", "Google\Chrome\Default"))) {
  $to = Join-Path $importFixtures $fixture[0]
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  foreach ($name in @("key4.db", "logins.json", "logins.db", "cookies.sqlite", "Web Data")) {
    $from = Join-Path (Join-Path $fixtureProfiles $fixture[1]) $name
    if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $to }
  }
}
$env:ARDIA_CONFIG_DIR = $env:ARDIA_DATA_DIR
$env:ARDIA_BACKGROUND = "1"
$env:ARDIA_TEST = "pipHover=first,pipHover=last,httpPages=$httpPagesPort"
$leftover = Join-Path $env:ARDIA_DATA_DIR "Chromium\Ardia self-check-stuck (removing)"
$held = $null
$check = $null
Add-Type @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class LocalStateRace {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ReplaceFileW(string replaced, string replacement, string backup, uint flags, IntPtr exclude, IntPtr reserved);
  static Thread runner;
  static volatile bool done;
  public static int Replaces;
  static bool Logged(string path, string text) {
    try {
      using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
      using (var reader = new StreamReader(stream)) return reader.ReadToEnd().Contains(text);
    } catch { return false; }
  }
  static byte[] ReadShared(string path) {
    try {
      using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
        var bytes = new byte[stream.Length];
        int read = 0;
        while (read < bytes.Length) { int got = stream.Read(bytes, read, bytes.Length - read); if (got <= 0) break; read += got; }
        return read == bytes.Length ? bytes : null;
      }
    } catch { return null; }
  }
  public static void Start(string localState, string requests) {
    done = false;
    Replaces = 0;
    runner = new Thread(() => {
      DateTime giveUp = DateTime.UtcNow.AddMinutes(10);
      while (!done && DateTime.UtcNow < giveUp && !Logged(requests, "/event/local-state-start")) Thread.Sleep(25);
      DateTime stopAt = DateTime.UtcNow.AddSeconds(60);
      DateTime nextLook = DateTime.UtcNow;
      string temp = localState + "~race.TMP";
      while (!done && DateTime.UtcNow < stopAt) {
        if (DateTime.UtcNow >= nextLook) {
          if (Logged(requests, "/event/local-state-stop")) break;
          nextLook = DateTime.UtcNow.AddMilliseconds(100);
        }
        byte[] bytes = ReadShared(localState);
        if (bytes == null) continue;
        try {
          File.WriteAllBytes(temp, bytes);
          if (ReplaceFileW(localState, temp, null, 2, IntPtr.Zero, IntPtr.Zero)) Replaces++;
        } catch { }
      }
    });
    runner.IsBackground = true;
    runner.Start();
  }
  public static int Stop() {
    done = true;
    if (runner != null) runner.Join(5000);
    return Replaces;
  }
}
"@
try {
  New-Item -ItemType Directory -Force -Path $leftover | Out-Null
  $held = [System.IO.File]::Open((Join-Path $leftover "held.txt"), [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  [LocalStateRace]::Start((Join-Path $env:ARDIA_DATA_DIR "Chromium\Local State"), $httpPagesLog)
  $check = Start-Process -FilePath $App -ArgumentList "--self-check", "--log-file=`"$checkLog`"" -PassThru
  $env:ARDIA_TEST = ""
  if (-not $check.WaitForExit($SelfCheckSeconds * 1000)) { $failures += "the self-check did not finish within $SelfCheckSeconds s" }
  elseif ($check.ExitCode -ne 0) { $failures += "the self-check launch exited with code $($check.ExitCode)" }
  else {
    $ending = Select-String -LiteralPath $checkLog -Pattern "^launch (\d+) process ending" | Select-Object -Last 1
    if ($ending) {
      $lived = [int](($check.ExitTime - $check.StartTime).TotalMilliseconds)
      $after = $lived - [int]$ending.Matches[0].Groups[1].Value
      Write-Host "the self-check process exited $after ms after the app ended"
      if ($after -gt 10000) { $failures += "the self-check process took $after ms to exit after the app ended (#1706)" }
    }
  }
} finally {
  Write-Host "Local State was saved $([LocalStateRace]::Stop()) times the way Chromium saves it while the self-check removed a profile whose earlier removal is held"
  try {
    if ($check -and -not $check.HasExited) {
      Save-Screenshot (Join-Path $Out "self-check-stuck.png")
      Stop-Process -Id $check.Id -Force
      $check.WaitForExit(10000) | Out-Null
    }
  } finally {
    if ($held) { $held.Dispose() }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $leftover
    if (-not $httpPages.HasExited) { Stop-Process -Id $httpPages.Id -Force -ErrorAction SilentlyContinue }
  }
}

if (Test-Path $checkLog) {
  Select-String -Path $checkLog -Pattern "self-check|webgl2 probe|^dialog |^(js-error|fatal|error) " | ForEach-Object { Write-Host $_.Line }
  $done = Select-String -Path $checkLog -Pattern "self-check done: (\d+) passed, (\d+) failed" | Select-Object -First 1
  if (-not $done) { $failures += "the self-check never reported its result" }
  elseif ([int]$done.Matches[0].Groups[2].Value -gt 0) { $failures += "$($done.Matches[0].Groups[2].Value) self-checks failed" }
  elseif ([int]$done.Matches[0].Groups[1].Value -eq 0) { $failures += "the self-check ran no checks" }
  if (Select-String -Path $checkLog -Pattern "^(js-error|fatal|error) " -Quiet) { $failures += "the self-check log has errors" }
} else {
  $failures += "the self-check wrote no log"
}
}

function Invoke-LoginData([string]$Sql) {
  $database = Join-Path $env:ARDIA_DATA_DIR "Chromium\Default\Login Data"
  if (-not (Test-Path -LiteralPath $database)) { return "no Login Data at $database" }
  if (-not ("Ardia.Sqlite" -as [type])) {
    Add-Type -Namespace Ardia -Name Sqlite -MemberDefinition @'
[DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int sqlite3_open(string filename, out IntPtr db);
[DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int sqlite3_exec(IntPtr db, string sql, IntPtr callback, IntPtr argument, IntPtr error);
[DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] public static extern int sqlite3_changes(IntPtr db);
[DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] public static extern int sqlite3_close(IntPtr db);
'@
  }
  $handle = [IntPtr]::Zero
  if ([Ardia.Sqlite]::sqlite3_open($database, [ref]$handle) -ne 0) { return "Login Data did not open" }
  try {
    if ([Ardia.Sqlite]::sqlite3_exec($handle, $Sql, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero) -ne 0) { return "the statement failed: $Sql" }
    $changed = [Ardia.Sqlite]::sqlite3_changes($handle)
    if ($changed -ne 1) { return "the statement changed $changed rows, not 1: $Sql" }
    return ""
  } finally { [Ardia.Sqlite]::sqlite3_close($handle) | Out-Null }
}

function Invoke-SelfCheckStage([string]$Stage) {
  $stageLog = Join-Path $Out "self-check-$Stage.log"
  $env:ARDIA_TEST = "selfCheckStage=$Stage"
  $stageRun = Start-Process -FilePath $App -ArgumentList "--self-check", "--log-file=`"$stageLog`"" -PassThru
  $env:ARDIA_TEST = ""
  if (-not $stageRun.WaitForExit(120000)) {
    Stop-Process -Id $stageRun.Id -Force -ErrorAction SilentlyContinue
    return "the $Stage self-check did not finish within 120 s"
  }
  if (-not (Test-Path $stageLog)) { return "the $Stage self-check wrote no log" }
  Select-String -Path $stageLog -Pattern "self-check" | ForEach-Object { Write-Host $_.Line }
  $stageDone = Select-String -Path $stageLog -Pattern "self-check done: (\d+) passed, (\d+) failed" | Select-Object -First 1
  if (-not $stageDone) { return "the $Stage self-check never reported its result" }
  if ([int]$stageDone.Matches[0].Groups[2].Value -gt 0 -or [int]$stageDone.Matches[0].Groups[1].Value -eq 0) { return "the $Stage self-check: $($stageDone.Line)" }
  return ""
}

if ($Part -ne "gate" -and (Test-Path -LiteralPath (Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $App).Path) "chrome.dll"))) {
  $secondLogin = "https://ardia-self-check-two.example%"
  $otherKinds = "CREATE TEMP TABLE ardia_kinds AS SELECT * FROM logins WHERE signon_realm LIKE 'https://ardia-self-check-one.example%';" +
    " UPDATE ardia_kinds SET id = NULL, signon_realm = 'https://ardia-self-check-never.example/', origin_url = 'https://ardia-self-check-never.example/', username_value = '', password_value = X'', blacklisted_by_user = 1;" +
    " INSERT INTO logins SELECT * FROM ardia_kinds;" +
    " UPDATE ardia_kinds SET signon_realm = 'https://ardia-self-check-federated.example/', origin_url = 'https://ardia-self-check-federated.example/', username_value = 'federated', blacklisted_by_user = 0, federation_url = 'https://ardia-self-check-idp.example';" +
    " INSERT INTO logins SELECT * FROM ardia_kinds;" +
    " DROP TABLE ardia_kinds;"
  foreach ($step in @(
      @{ Sql = $otherKinds; Stage = "blocklistedAndFederated" },
      @{ Sql = "UPDATE logins SET password_value = X'763130' || randomblob(40) WHERE signon_realm LIKE '$secondLogin'"; Stage = "undecryptableLogin" },
      @{ Sql = "UPDATE logins SET password_value = X'' WHERE signon_realm LIKE '$secondLogin'"; Stage = "emptyPasswordLogin" },
      @{ Sql = "DELETE FROM logins WHERE signon_realm LIKE '$secondLogin'"; Stage = "undecryptableRemoved" })) {
    $problem = Invoke-LoginData $step.Sql
    if (-not $problem) { $problem = Invoke-SelfCheckStage $step.Stage }
    if ($problem) {
      $failures += "passwords, $($step.Stage): $problem"
      break
    }
  }
}

if ($Part -ne "gate" -and (Test-Path -LiteralPath (Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $App).Path) "chrome.dll"))) {
  $warpLog = Join-Path $Out "self-check-warp.log"
  $env:ARDIA_TEST = "selfCheckOnly=meadow:,meadowWebGL=required"
  $warp = Start-Process -FilePath $App -ArgumentList "--self-check", "--ignore-gpu-blocklist", "--use-angle=d3d11-warp", "--log-file=`"$warpLog`"" -PassThru
  $env:ARDIA_TEST = ""
  if (-not $warp.WaitForExit(120000)) { $failures += "the meadow self-check on WARP did not finish within 120 s"; Stop-Process -Id $warp.Id -Force -ErrorAction SilentlyContinue }
  if (Test-Path $warpLog) {
    Select-String -Path $warpLog -Pattern "webgl2 probe|meadow|self-check (pass|FAIL|done)" | ForEach-Object { Write-Host "warp: $($_.Line)" }
    $warpDone = Select-String -Path $warpLog -Pattern "self-check done: (\d+) passed, (\d+) failed" | Select-Object -First 1
    if (-not $warpDone) { $failures += "the meadow self-check on WARP never reported its result" }
    elseif ([int]$warpDone.Matches[0].Groups[2].Value -gt 0) { $failures += "$($warpDone.Matches[0].Groups[2].Value) meadow self-checks on WARP failed" }
    elseif ([int]$warpDone.Matches[0].Groups[1].Value -lt 2) { $failures += "the meadow self-check on WARP ran $($warpDone.Matches[0].Groups[1].Value) checks, not 2" }
  } else { $failures += "the meadow self-check on WARP wrote no log" }
}

if ($Part -ne "gate" -and (Test-Path -LiteralPath (Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $App).Path) "chrome.dll"))) {
  if ($NoInput) { Write-Host "backed check: not run on this runner, whose desktop Windows' first-run screen covers (#2280)" }
  else { $failures += @(& (Join-Path $PSScriptRoot "backed-check.ps1") -App $App -Out $Out) }
}

$gateApp = (Resolve-Path -LiteralPath $App).Path
$withEngine = Test-Path -LiteralPath (Join-Path (Split-Path -Parent $gateApp) "chrome.dll")
$gatePort = 9338

function Test-PortOpen([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { return $client.ConnectAsync("127.0.0.1", $Port).Wait(1500) -and $client.Connected } catch { return $false } finally { $client.Dispose() }
}

function Start-GateLaunch([string]$DataDirectory, [string]$Case, [string]$Test, [string[]]$Extra = @()) {
  $caseLog = Join-Path $Out "gate-$Case.log"
  Remove-Item -Force -ErrorAction SilentlyContinue $caseLog
  $env:ARDIA_DATA_DIR = $DataDirectory
  $env:ARDIA_TEST = $Test
  $env:ARDIA_BACKGROUND = "1"
  $env:ARDIA_REMOTE_DEBUGGING_PORT = if ($withEngine) { "$gatePort" } else { "" }
  $run = Start-Process -FilePath $gateApp -ArgumentList (@("--log-file=`"$caseLog`"") + $Extra) -PassThru
  $env:ARDIA_TEST = ""
  $env:ARDIA_REMOTE_DEBUGGING_PORT = ""
  return @($run, $caseLog)
}

function Wait-GateLine([object]$Run, [string]$CaseLog, [string]$Pattern) {
  $deadline = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $deadline -and -not $Run.HasExited) {
    if (Test-Path -LiteralPath $CaseLog) {
      $line = Select-String -LiteralPath $CaseLog -Pattern $Pattern | Select-Object -First 1
      if ($line) { return $line }
    }
    Start-Sleep -Milliseconds 500
  }
  return $null
}

function Stop-Tree([int]$Id) {
  $running = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate -OperationTimeoutSec 15 -ErrorAction SilentlyContinue)
  $order = Get-StopOrder $Id $running
  Write-Host "stopping $($order.Count) process(es) under $Id"
  foreach ($process in $order) { Stop-Process -Id $process -Force -ErrorAction SilentlyContinue }
}

function Stop-GateLaunch([object]$Run) {
  Stop-Tree $Run.Id
  $Run.WaitForExit(10000) | Out-Null
}

function Wait-PortOpen([int]$Port, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortOpen $Port) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function New-CallingExtension([int]$Port) {
  $folder = New-DataDirectory "gate-extension"
  Set-Content -LiteralPath (Join-Path $folder "manifest.json") -Encoding ascii -Value ('{"name":"gate","version":"1","manifest_version":3,"permissions":["cookies"],"host_permissions":["<all_urls>"],"background":{"service_worker":"worker.js"}}')
  Set-Content -LiteralPath (Join-Path $folder "worker.js") -Encoding ascii -Value ('fetch("http://127.0.0.1:' + $Port + '/loaded").catch(() => {});')
  return $folder
}

function Start-ExtensionListener([int]$Port) {
  $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), $Port
  $listener.Start()
  return @($listener, $listener.AcceptTcpClientAsync())
}

function Test-WalkAround([string]$DataDirectory, [string]$Case, [string]$Test, [string[]]$Extra, [int]$ExtensionPort = 0) {
  if (-not $withEngine) { return }
  $listener = $null
  if ($ExtensionPort) { $listener, $accept = Start-ExtensionListener $ExtensionPort }
  $run, $caseLog = Start-GateLaunch $DataDirectory $Case $Test $Extra
  try {
    $engine = Wait-GateLine $run $caseLog "^engine 0 test gate: "
    if (-not $engine) { $script:failures += "the engine never started, or said nothing about the test gate, with $Case"; return }
    Write-Host "engine test gate, $Case`: $($engine.Line)"
    if ($engine.Line -notmatch "not a test instance \(.*ardiacore test instance: no; reauth=granted honoured: no$") { $script:failures += "the engine counted the test instance or reauth=granted with $Case" }
    if (Wait-PortOpen $gatePort 15) { $script:failures += "remote debugging listened on port $gatePort with $Case" } else { Write-Host "walk-around, $Case`: port $gatePort stayed closed" }
    if ($listener) {
      if ($accept.Wait(10000)) { $accept.Result.Dispose(); $script:failures += "an extension from --load-extension ran with $Case" } else { Write-Host "walk-around, $Case`: the extension never ran" }
    }
  } finally {
    Stop-GateLaunch $run
    if ($listener) { $listener.Stop() }
  }
}

function Test-ExtensionRunsInATestInstance([string]$Extension, [int]$Port) {
  $listener, $accept = Start-ExtensionListener $Port
  $run, $caseLog = Start-GateLaunch (New-DataDirectory "gate-extension-control") "--load-extension in a test instance" "" @("--load-extension=`"$Extension`"")
  try {
    if ($accept.Wait(30000)) { $accept.Result.Dispose(); Write-Host "control, --load-extension in a test instance: the extension ran" } else { $script:failures += "the same extension never ran in a test instance, so the refused case proves nothing" }
  } finally {
    Stop-GateLaunch $run
    $listener.Stop()
  }
}

function Test-NotATestInstance([string]$DataDirectory, [string]$Case) {
  $run, $caseLog = Start-GateLaunch $DataDirectory $Case "appDialog,reauth=granted"
  try {
    $refused = Wait-GateLine $run $caseLog "not a test instance \("
    if ($refused) { Write-Host "test gate, $Case`: $($refused.Line)" } else { $script:failures += "ARDIA_TEST counted, or the launch said nothing, with $Case"; return }
    if (-not $withEngine) { return }
    if (Test-PortOpen $gatePort) { $script:failures += "remote debugging listened on port $gatePort with $Case" }
    $engine = Wait-GateLine $run $caseLog "^engine 0 test gate: "
    if (-not $engine) { $script:failures += "the engine said nothing about the test gate with $Case"; return }
    Write-Host "engine test gate, $Case`: $($engine.Line)"
    if ($engine.Line -notmatch "not a test instance \(.*ardiacore test instance: no; reauth=granted honoured: no$") { $script:failures += "the engine counted the test instance or reauth=granted with $Case" }
  } finally { Stop-GateLaunch $run }
}

function Test-ATestInstance([string]$DataDirectory, [string]$Case) {
  $run, $caseLog = Start-GateLaunch $DataDirectory $Case "reauth=granted"
  try {
    $engine = Wait-GateLine $run $caseLog "^engine 0 test gate: "
    if (-not $engine) { $script:failures += "the engine said nothing about the test gate with $Case"; return }
    Write-Host "engine test gate, $Case`: $($engine.Line)"
    if ($engine.Line -notmatch "a test instance; remote debugging port: $gatePort; ardiacore test instance: yes; reauth=granted honoured: yes$") { $script:failures += "the engine refused the test instance or reauth=granted with $Case" }
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline -and -not (Test-PortOpen $gatePort)) { Start-Sleep -Milliseconds 500 }
    try {
      $version = Invoke-RestMethod -Uri "http://127.0.0.1:$gatePort/json/version" -TimeoutSec 10
      Write-Host "remote debugging, $Case`: $($version.Browser)"
    } catch { $script:failures += "remote debugging didn't answer on port $gatePort with $Case" }
  } finally { Stop-GateLaunch $run }
}

if ($Part -ne "launch") {
$gateData = New-DataDirectory "gate-scratch"
$marker = Join-Path (Split-Path -Parent $gateApp) "Ardia.test-build"
Remove-Item -Force -LiteralPath $marker
try { Test-NotATestInstance $gateData "no test-build marker" } finally { New-Item -ItemType File -Force -Path $marker | Out-Null }
Test-NotATestInstance "gate-relative" "a relative ARDIA_DATA_DIR"
if ($env:GITHUB_ACTIONS -eq "true") {
  $realProfile = Join-Path $env:LOCALAPPDATA "Ardia"
  New-Item -ItemType Directory -Force -Path $realProfile | Out-Null
  Test-NotATestInstance $realProfile "the real profile folder"
  $junction = Join-Path (New-DataDirectory "gate-junction") "profile"
  New-Item -ItemType Junction -Path $junction -Target $realProfile | Out-Null
  try { Test-NotATestInstance $junction "a junction to the real profile folder" } finally { (Get-Item -LiteralPath $junction).Delete() }
}
if ($withEngine -and $env:GITHUB_ACTIONS -eq "true") {
  $realUserData = Join-Path $env:LOCALAPPDATA "Ardia\User Data"
  Test-WalkAround "" "an empty --type on the real profile" "" @("--type=", "--user-data-dir=`"$realUserData`"", "--remote-debugging-port=$gatePort", "--remote-allow-origins=*")
  Test-WalkAround (New-DataDirectory "gate-other-user-data") "a --user-data-dir other than the approved folder" "reauth=granted" @("--user-data-dir=`"$realUserData`"")
  $aliased = New-DataDirectory "gate-alias"
  New-Item -ItemType Directory -Force -Path (Join-Path $aliased "Chromium") | Out-Null
  $alias = Join-Path (New-DataDirectory "gate-alias-link") "chromium"
  New-Item -ItemType Junction -Path $alias -Target (Join-Path $aliased "Chromium") | Out-Null
  try { Test-WalkAround $aliased "a --user-data-dir junction to the approved folder" "reauth=granted" @("--user-data-dir=`"$alias`"") } finally { (Get-Item -LiteralPath $alias).Delete() }
  $extension = New-CallingExtension 9341
  Test-WalkAround "" "--load-extension and debugging switches without a test instance" "" @("--load-extension=`"$extension`"", "--remote-debugging-port=$gatePort", "--remote-allow-origins=*", "--disable-web-security", "--enable-automation", "--no-sandbox", "--renderer-cmd-prefix=cmd.exe") -ExtensionPort 9341
  Test-ExtensionRunsInATestInstance $extension 9341
}
if ($withEngine) { Test-ATestInstance (New-DataDirectory "gate-test-instance") "a scratch folder with the marker" }
}
$env:ARDIA_DATA_DIR = ""
$env:ARDIA_BACKGROUND = ""

if ($failures.Count) {
  $failures | ForEach-Object { Write-Host "::error::$_" }
  exit 1
}
if ($Part -ne "gate") { Write-Host "The app launched, rendered its first window, stayed up for $Seconds s, and passed its self-check." }
if ($Part -ne "launch") { Write-Host "The test gate refused what it must and let a test instance through." }
