param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$LaunchSeconds = 60,
  [string[]]$Only = @(),
  [string[]]$Required = @()
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path -LiteralPath $Out).Path
$tourFile = Join-Path $Out "tour.md"

$script:Lines = [System.Collections.Generic.List[string]]::new()
$script:Sessions = [System.Collections.Generic.List[object]]::new()
$script:StopNumber = 0
$script:FailedStops = [System.Collections.Generic.List[string]]::new()
$script:PreviousSignature = $null
$script:UiaReady = $null
$script:LightBrightness = $null
$script:Started = Get-Date

if (-not ([System.Management.Automation.PSTypeName]"ArdiaTour").Type) {
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class ArdiaTour {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }

  public class TopWindow {
    public IntPtr Handle;
    public string Title;
    public string ClassName;
    public int Left, Top, Width, Height;
  }

  private delegate bool EnumWindowsCallback(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr window, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr window, StringBuilder text, int max);
  [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsCallback callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, IntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint code, uint mapType);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] private static extern bool SystemParametersInfoW(uint action, uint parameter, out int value, uint change);

  public static bool AnimationsOn() {
    int on;
    return !SystemParametersInfoW(0x1042, 0, out on, 0) || on != 0;
  }

  public static string TitleOf(IntPtr window) {
    StringBuilder text = new StringBuilder(512);
    GetWindowTextW(window, text, text.Capacity);
    return text.ToString();
  }

  public static string ClassOf(IntPtr window) {
    StringBuilder text = new StringBuilder(256);
    GetClassNameW(window, text, text.Capacity);
    return text.ToString();
  }

  public static bool IsCloaked(IntPtr window) {
    int value;
    return DwmGetWindowAttribute(window, 14, out value, 4) == 0 && value != 0;
  }

  public static int DarkModeOf(IntPtr window) {
    int value;
    return DwmGetWindowAttribute(window, 20, out value, 4) == 0 ? value : -1;
  }

  public static uint ProcessOf(IntPtr window) {
    uint processId;
    GetWindowThreadProcessId(window, out processId);
    return processId;
  }

  public static string[] EditTextsOf(IntPtr parent) {
    List<string> found = new List<string>();
    EnumWindowsCallback callback = delegate (IntPtr window, IntPtr data) {
      if (ClassOf(window).IndexOf("Edit", StringComparison.OrdinalIgnoreCase) < 0) return true;
      IntPtr length;
      if (SendMessageTimeoutW(window, 0x000E, IntPtr.Zero, IntPtr.Zero, 0x0002, 1000, out length) == IntPtr.Zero) return true;
      StringBuilder text = new StringBuilder(length.ToInt32() + 1);
      IntPtr copied;
      if (SendMessageTimeoutW(window, 0x000D, (IntPtr)text.Capacity, text, 0x0002, 1000, out copied) == IntPtr.Zero) return true;
      found.Add(text.ToString());
      return true;
    };
    EnumChildWindows(parent, callback, IntPtr.Zero);
    GC.KeepAlive(callback);
    return found.ToArray();
  }

  public static TopWindow[] VisibleWindowsOf(uint processId) {
    List<TopWindow> found = new List<TopWindow>();
    EnumWindowsCallback callback = delegate (IntPtr window, IntPtr data) {
      if (ProcessOf(window) != processId) return true;
      if (!IsWindowVisible(window) || IsCloaked(window)) return true;
      Rect rect;
      if (!GetWindowRect(window, out rect)) return true;
      if (rect.Right - rect.Left <= 0 || rect.Bottom - rect.Top <= 0) return true;
      TopWindow entry = new TopWindow();
      entry.Handle = window;
      entry.Title = TitleOf(window);
      entry.ClassName = ClassOf(window);
      entry.Left = rect.Left;
      entry.Top = rect.Top;
      entry.Width = rect.Right - rect.Left;
      entry.Height = rect.Bottom - rect.Top;
      found.Add(entry);
      return true;
    };
    EnumWindows(callback, IntPtr.Zero);
    GC.KeepAlive(callback);
    return found.ToArray();
  }
}
"@
}

[ArdiaTour]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

function Write-Tour {
  $header = @(
    "# Ardia on Windows: screenshot tour",
    "",
    "Every line is one stop: what the tour did, what it expected, and whether a fact the script can check says it happened (yes, no, or unverified when there is nothing to check). A screen that looks wrong is reported here and never fails the job; only a crash or an exit does.",
    "",
    "Screen: $([System.Windows.Forms.SystemInformation]::PrimaryMonitorSize.Width) by $([System.Windows.Forms.SystemInformation]::PrimaryMonitorSize.Height), work area $([System.Windows.Forms.SystemInformation]::WorkingArea.Width) by $([System.Windows.Forms.SystemInformation]::WorkingArea.Height). Started $($script:Started.ToString('u')).",
    ""
  )
  $footer = [System.Collections.Generic.List[string]]::new()
  foreach ($session in $script:Sessions) {
    $footer.Add("")
    $footer.Add("## Launch: $($session.Name)")
    $footer.Add("")
    $footer.Add("Log: [$($session.Name).log]($($session.Name).log). $($session.Summary)")
    if ($session.Fatal.Count) {
      $footer.Add("")
      $footer.Add("Crash lines from the launch log:")
      $footer.Add("")
      $footer.Add('```')
      foreach ($line in $session.Fatal) { $footer.Add($line) }
      $footer.Add('```')
    }
    if ($session.Errors.Count) {
      $footer.Add("")
      $footer.Add("Error lines from the launch log:")
      $footer.Add("")
      $footer.Add('```')
      foreach ($line in ($session.Errors | Select-Object -First 40)) { $footer.Add($line) }
      $footer.Add('```')
    }
  }
  $missing = @($script:Sessions | ForEach-Object { $_.Missing } | Sort-Object -Unique)
  if ($missing.Count) {
    $footer.Add("")
    $footer.Add("## Reached with no Windows version yet")
    $footer.Add("")
    foreach ($name in $missing) { $footer.Add("- $name") }
  }
  try {
    Set-Content -LiteralPath $tourFile -Value (@($header) + @($script:Lines) + @($footer)) -Encoding utf8NoBOM
  } catch {
    Write-Host "[tour] could not write tour.md: $($_.Exception.Message)"
  }
}

function Read-LogLines([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    try {
      $reader = [System.IO.StreamReader]::new($stream)
      $text = $reader.ReadToEnd()
    } finally {
      $stream.Dispose()
    }
    return @($text -split "`r?`n" | Where-Object { $_ -ne "" })
  } catch {
    return @()
  }
}

function Get-LinesSince($Session, [int]$Mark, [string]$Pattern) {
  return @(Read-LogLines $Session.Log | Select-Object -Skip $Mark | Where-Object { $_ -match $Pattern })
}

function Get-LogCount($Session) {
  return @(Read-LogLines $Session.Log).Count
}

function Test-Running($Session) {
  if ($Session.Process.HasExited) { throw "the app is no longer running (exit code $($Session.Process.ExitCode))" }
}

function Wait-Until($Session, [scriptblock]$Test, [int]$Milliseconds) {
  $deadline = (Get-Date).AddMilliseconds($Milliseconds)
  while ($true) {
    if (& $Test) { return $true }
    Test-Running $Session
    if ((Get-Date) -ge $deadline) { return $false }
    Start-Sleep -Milliseconds 150
  }
}

function Get-TopWindows($Session) {
  try { return @([ArdiaTour]::VisibleWindowsOf([uint32]$Session.Process.Id)) } catch { return @() }
}

function Get-BigWindows($Session) {
  return @(Get-TopWindows $Session | Where-Object { $_.ClassName -ne "#32768" -and $_.Width -ge 300 -and $_.Height -ge 200 })
}

function Get-MenuWindows($Session) {
  return @(Get-TopWindows $Session | Where-Object { $_.ClassName -eq "#32768" })
}

function Get-NewWindows($Session, $Before) {
  $known = @($Before | ForEach-Object { $_.Handle.ToInt64() })
  return @(Get-TopWindows $Session | Where-Object { $known -notcontains $_.Handle.ToInt64() })
}

function Format-Windows($Windows) {
  $list = @($Windows)
  if (-not $list.Count) { return "none" }
  return ($list | ForEach-Object { "'$($_.Title)' ($($_.ClassName), $($_.Width) by $($_.Height) at $($_.Left), $($_.Top))" }) -join "; "
}

function Get-Client([IntPtr]$Window) {
  if ($Window -eq [IntPtr]::Zero -or -not [ArdiaTour]::IsWindow($Window)) { return $null }
  $origin = New-Object ArdiaTour+Point
  $size = New-Object ArdiaTour+Rect
  if (-not [ArdiaTour]::ClientToScreen($Window, [ref]$origin)) { return $null }
  if (-not [ArdiaTour]::GetClientRect($Window, [ref]$size)) { return $null }
  $dpi = [ArdiaTour]::GetDpiForWindow($Window)
  $scale = 1.0
  if ($dpi) { $scale = $dpi / 96.0 }
  return [pscustomobject]@{ X = $origin.X; Y = $origin.Y; Width = $size.Right; Height = $size.Bottom; Scale = $scale }
}

function Get-Frame([IntPtr]$Window) {
  $rect = New-Object ArdiaTour+Rect
  if (-not [ArdiaTour]::GetWindowRect($Window, [ref]$rect)) { return $null }
  return [pscustomobject]@{ Left = $rect.Left; Top = $rect.Top; Width = $rect.Right - $rect.Left; Height = $rect.Bottom - $rect.Top }
}

function Test-ForegroundIsOurs($Session) {
  $foreground = [ArdiaTour]::GetForegroundWindow()
  if ($foreground -eq [IntPtr]::Zero) { return $false }
  return [ArdiaTour]::ProcessOf($foreground) -eq [uint32]$Session.Process.Id
}

function Describe-Foreground {
  $foreground = [ArdiaTour]::GetForegroundWindow()
  if ($foreground -eq [IntPtr]::Zero) { return "no window" }
  $owner = [ArdiaTour]::ProcessOf($foreground)
  $name = "process $owner"
  try { $name = (Get-Process -Id $owner -ErrorAction Stop).ProcessName } catch { }
  return "'$([ArdiaTour]::TitleOf($foreground))' ($([ArdiaTour]::ClassOf($foreground)), $name)"
}

function Send-Click([int]$X, [int]$Y, [switch]$Right) {
  $down = 2
  $up = 4
  if ($Right) {
    $down = 8
    $up = 16
  }
  [ArdiaTour]::SetCursorPos($X, $Y) | Out-Null
  Start-Sleep -Milliseconds 120
  [ArdiaTour]::mouse_event([uint32]$down, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [ArdiaTour]::mouse_event([uint32]$up, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 300
}

function Send-MouseMove([int]$X, [int]$Y, [int]$Steps = 8) {
  $desk = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $from = [System.Windows.Forms.Cursor]::Position
  for ($step = 1; $step -le $Steps; $step++) {
    $atX = $from.X + ($X - $from.X) * $step / $Steps
    $atY = $from.Y + ($Y - $from.Y) * $step / $Steps
    $normalX = [Math]::Max(0, [Math]::Min(65535, [Math]::Round(($atX - $desk.Left) * 65535 / ($desk.Width - 1))))
    $normalY = [Math]::Max(0, [Math]::Min(65535, [Math]::Round(($atY - $desk.Top) * 65535 / ($desk.Height - 1))))
    [ArdiaTour]::mouse_event([uint32]0xC001, [uint32]$normalX, [uint32]$normalY, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 15
  }
}

function Send-Key([byte]$Key, [uint32]$Flags) {
  $scan = [byte]([ArdiaTour]::MapVirtualKeyW([uint32]$Key, 0) -band 0xFF)
  [ArdiaTour]::keybd_event($Key, $scan, $Flags, [UIntPtr]::Zero)
}

function Send-Chord([byte[]]$Modifiers, [byte]$Key) {
  foreach ($modifier in $Modifiers) { Send-Key $modifier 0 }
  Start-Sleep -Milliseconds 50
  Send-Key $Key 0
  Start-Sleep -Milliseconds 50
  Send-Key $Key 2
  foreach ($modifier in $Modifiers) { Send-Key $modifier 2 }
  Start-Sleep -Milliseconds 450
}

function Send-Escape {
  Send-Chord @() 0x1B
}

function Send-Text([string]$Text) {
  foreach ($character in $Text.ToUpperInvariant().ToCharArray()) {
    $key = [byte][char]$character
    if ($character -eq '.') { $key = 0xBE }
    Send-Key $key 0
    Send-Key $key 2
    Start-Sleep -Milliseconds 60
  }
  Start-Sleep -Milliseconds 300
}

function Focus-Window($Session, [IntPtr]$Window, $Stop, [switch]$ClickBand) {
  if (-not [ArdiaTour]::IsWindow($Window)) { throw "the window to focus is gone" }
  if ([ArdiaTour]::IsIconic($Window)) { [ArdiaTour]::ShowWindow($Window, 9) | Out-Null }
  if ([ArdiaTour]::GetForegroundWindow() -eq $Window) { return $true }
  if (-not (Test-ForegroundIsOurs $Session)) {
    Send-Key 0x12 0
    Send-Key 0x12 2
  }
  [ArdiaTour]::SetForegroundWindow($Window) | Out-Null
  [ArdiaTour]::BringWindowToTop($Window) | Out-Null
  Start-Sleep -Milliseconds 300
  if ([ArdiaTour]::GetForegroundWindow() -eq $Window) { return $true }
  if ($ClickBand) {
    $client = Get-Client $Window
    if ($client) {
      Send-Click ($client.X + [int]($client.Width * 0.6)) ($client.Y + [int](16 * $client.Scale))
      Start-Sleep -Milliseconds 300
      if ([ArdiaTour]::GetForegroundWindow() -eq $Window) { return $true }
    }
  }
  if ($Stop) { $Stop.Facts.Add("could not bring the window forward; the foreground is $(Describe-Foreground)") }
  return $false
}

function Close-Dialogs($Session, $Stop) {
  foreach ($dialog in @(Get-TopWindows $Session | Where-Object { $_.ClassName -eq "#32770" })) {
    $Stop.Facts.Add("closed a dialog left open from before: '$($dialog.Title)'")
    [ArdiaTour]::PostMessageW($dialog.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 400
  }
}

function Close-Menus($Session) {
  for ($i = 0; $i -lt 3; $i++) {
    if (-not @(Get-MenuWindows $Session).Count) { return }
    Send-Escape
    Start-Sleep -Milliseconds 200
  }
}

function Get-Signature([System.Drawing.Bitmap]$Bitmap, [System.Drawing.Rectangle]$Screen, $Frame) {
  $columns = 48
  $rows = 32
  $left = [Math]::Max(0, $Frame.Left - $Screen.X)
  $top = [Math]::Max(0, $Frame.Top - $Screen.Y)
  $right = [Math]::Min($Bitmap.Width, $Frame.Left - $Screen.X + $Frame.Width)
  $bottom = [Math]::Min($Bitmap.Height, $Frame.Top - $Screen.Y + $Frame.Height)
  if ($right - $left -lt $columns -or $bottom - $top -lt $rows) { return $null }
  $values = [int[]]::new($columns * $rows)
  $brightness = 0.0
  for ($row = 0; $row -lt $rows; $row++) {
    $y = [int]($top + ($row + 0.5) * ($bottom - $top) / $rows)
    for ($column = 0; $column -lt $columns; $column++) {
      $x = [int]($left + ($column + 0.5) * ($right - $left) / $columns)
      $pixel = $Bitmap.GetPixel($x, $y)
      $values[$row * $columns + $column] = ([int]$pixel.R -shl 16) -bor ([int]$pixel.G -shl 8) -bor [int]$pixel.B
      $brightness += 0.299 * $pixel.R + 0.587 * $pixel.G + 0.114 * $pixel.B
    }
  }
  return [pscustomobject]@{ Values = $values; Brightness = [Math]::Round($brightness / ($columns * $rows)); Key = "$($Frame.Left),$($Frame.Top),$($Frame.Width),$($Frame.Height)" }
}

function Compare-Signatures($Before, $After) {
  if (-not $Before -or -not $After -or $Before.Key -ne $After.Key) { return $null }
  $changed = 0
  for ($i = 0; $i -lt $After.Values.Length; $i++) {
    $a = $Before.Values[$i]
    $b = $After.Values[$i]
    if ($a -eq $b) { continue }
    $red = [Math]::Abs((($a -shr 16) -band 0xFF) - (($b -shr 16) -band 0xFF))
    $green = [Math]::Abs((($a -shr 8) -band 0xFF) - (($b -shr 8) -band 0xFF))
    $blue = [Math]::Abs(($a -band 0xFF) - ($b -band 0xFF))
    if ([Math]::Max($red, [Math]::Max($green, $blue)) -gt 24) { $changed++ }
  }
  return [Math]::Round(100.0 * $changed / $After.Values.Length, 1)
}

function Measure-Screen([string]$Path, [IntPtr]$Window) {
  $result = [pscustomobject]@{ Saved = $false; Brightness = $null; Changed = $null; Problem = $null }
  try {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
      if ($Path) {
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        $result.Saved = $true
      }
      if ($Window -ne [IntPtr]::Zero -and [ArdiaTour]::IsWindow($Window)) {
        $frame = Get-Frame $Window
        if ($frame) {
          $signature = Get-Signature $bitmap $bounds $frame
          if ($signature) {
            $result.Brightness = $signature.Brightness
            $result.Changed = Compare-Signatures $script:PreviousSignature $signature
            $script:PreviousSignature = $signature
          }
        }
      }
    } finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  } catch {
    $result.Problem = $_.Exception.Message
  }
  return $result
}

function Save-Shot($Stop, [IntPtr]$Window) {
  $result = Measure-Screen $Stop.Shot $Window
  if ($result.Saved) { $Stop.ShotSaved = $true }
  if ($result.Problem) { $Stop.Facts.Add("no screenshot: $($result.Problem)") }
  if ($null -ne $result.Brightness) {
    $note = "window brightness $($result.Brightness) of 255"
    if ($null -ne $result.Changed) { $note += ", $($result.Changed)% of the window changed since the previous shot" }
    $Stop.Facts.Add($note)
  }
  return $result
}

function Initialize-Uia {
  if ($null -ne $script:UiaReady) { return $script:UiaReady }
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $script:UiaReady = $true
  } catch {
    $script:UiaReady = $false
    Write-Host "[tour] UI Automation is not available: $($_.Exception.Message)"
  }
  return $script:UiaReady
}

function Find-Named([IntPtr]$Window, [string]$Name) {
  if (-not (Initialize-Uia)) { return @() }
  $found = @()
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Window)
    $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $Name)
    $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    foreach ($element in $elements) {
      try {
        $box = $element.Current.BoundingRectangle
        if ($box.IsEmpty -or $box.Width -le 0 -or $box.Height -le 0 -or $element.Current.IsOffscreen) { continue }
        $found += [pscustomobject]@{ X = [int]($box.X + $box.Width / 2); Y = [int]($box.Y + $box.Height / 2); Left = [int]$box.X; Top = [int]$box.Y; Width = [int]$box.Width; Height = [int]$box.Height }
      } catch { }
    }
  } catch {
    Write-Host "[tour] UI Automation search for '$Name' failed: $($_.Exception.Message)"
  }
  return @($found)
}

function New-Stop([string]$Slug) {
  $script:StopNumber++
  $number = "{0:D2}" -f $script:StopNumber
  return [pscustomobject]@{
    Number = $number
    Slug = $Slug
    Shot = Join-Path $Out "$number-$Slug.png"
    ShotSaved = $false
    Did = ""
    Expected = ""
    Seen = "unverified"
    Facts = [System.Collections.Generic.List[string]]::new()
  }
}

function Invoke-Stop($Session, [string]$Slug, [string]$Title, [scriptblock]$Body) {
  $stop = New-Stop $Slug
  Write-Host "[tour] $($stop.Number) $Title"
  $mark = 0
  if ($Session) { $mark = Get-LogCount $Session }
  try {
    if ($Session) { Test-Running $Session }
    if ($Session) { Close-Dialogs $Session $stop }
    & $Body $stop | Out-Null
  } catch {
    $stop.Seen = "error"
    $stop.Facts.Add("error: $($_.Exception.Message)")
  }
  if (-not $stop.ShotSaved) {
    $window = [IntPtr]::Zero
    if ($Session) { $window = $Session.Main }
    Save-Shot $stop $window | Out-Null
  }
  if ($Session) {
    $new = @(Read-LogLines $Session.Log | Select-Object -Skip $mark)
    $missing = @($new | Where-Object { $_ -match "no Windows version yet: (.+)$" } | ForEach-Object { $Matches[1].Trim() })
    if ($missing.Count) { $stop.Facts.Add("first reached with no Windows version: $($missing -join ', ')") }
    $errors = @($new | Where-Object { $_ -match "^(js-error|error|fatal) " })
    if ($errors.Count) { $stop.Facts.Add("log errors during this stop: $(($errors | Select-Object -First 3) -join ' | ')") }
    if ($Session.Process.HasExited -and -not $Session.Stopping) {
      $stop.Seen = "crashed"
      $stop.Facts.Add("the app exited during this stop (exit code $($Session.Process.ExitCode))")
    }
  }
  $facts = ""
  if ($stop.Facts.Count) { $facts = " Facts: " + ($stop.Facts -join "; ") + "." }
  $shotName = Split-Path -Leaf $stop.Shot
  $shotLink = "no screenshot"
  if (Test-Path -LiteralPath $stop.Shot) { $shotLink = "[$shotName]($shotName)" }
  $script:Lines.Add("- **$($stop.Number) $Title** ($shotLink). Did: $($stop.Did) Expected: $($stop.Expected) Seen: **$($stop.Seen)**.$facts")
  Write-Host "[tour] $($stop.Number) -> $($stop.Seen)"
  Write-Tour
  return $stop
}

function Set-Seen($Stop, [bool]$Seen) {
  if ($Seen) { $Stop.Seen = "yes" } else { $Stop.Seen = "no" }
}

function Start-Ardia([string]$Name, [switch]$Onboarded, [hashtable]$Settings, [switch]$KeepData) {
  $data = Join-Path (Join-Path $Out "data") $Name
  if (-not $KeepData) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $data }
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  if ($Onboarded) {
    Set-Content -LiteralPath (Join-Path $data "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM
  }
  if ($Settings) {
    $config = Join-Path $data "config"
    New-Item -ItemType Directory -Force -Path $config | Out-Null
    Set-Content -LiteralPath (Join-Path $config "config.json") -Value (@{ settings = $Settings } | ConvertTo-Json -Depth 5) -Encoding utf8NoBOM
  }
  $log = Join-Path $Out "$Name.log"
  Remove-Item -Force -ErrorAction SilentlyContinue $log
  $env:ARDIA_DATA_DIR = $data
  $env:ARDIA_BACKGROUND = ""
  Write-Host "[tour] launching '$Name' with data in $data"
  $process = Start-Process -FilePath $App -ArgumentList "--log-file=`"$log`"" -PassThru
  $null = $process.Handle
  $session = [pscustomobject]@{
    Name = $Name
    Process = $process
    Log = $log
    Data = $data
    Main = [IntPtr]::Zero
    Stopping = $false
    Started = Get-Date
    FirstWindowMs = $null
    Fatal = @()
    Errors = @()
    Missing = @()
    Summary = ""
    Crashed = $false
  }
  $script:Sessions.Add($session)
  $deadline = (Get-Date).AddSeconds($LaunchSeconds)
  while ((Get-Date) -lt $deadline -and -not $process.HasExited) {
    $first = @(Read-LogLines $log | Where-Object { $_ -match "^\w+ (\d+) .*\[ardia windows\] first window" } | Select-Object -First 1)
    $windows = @(Get-BigWindows $session)
    if ($first.Count -and $windows.Count) {
      if ($first[0] -match "^\w+ (\d+) ") { $session.FirstWindowMs = [int64]$Matches[1] }
      $session.Main = $windows[0].Handle
      break
    }
    Start-Sleep -Milliseconds 250
  }
  Start-Sleep -Milliseconds 1500
  return $session
}

function Stop-Ardia($Session) {
  if (-not $Session) { return }
  $exitedOnItsOwn = $Session.Process.HasExited
  $Session.Stopping = $true
  if (-not $exitedOnItsOwn) {
    try {
      Stop-Process -Id $Session.Process.Id -Force -ErrorAction Stop
      $Session.Process.WaitForExit(10000) | Out-Null
    } catch {
      Write-Host "[tour] could not stop '$($Session.Name)': $($_.Exception.Message)"
    }
  }
  Start-Sleep -Milliseconds 300
  $lines = @(Read-LogLines $Session.Log)
  $Session.Fatal = @($lines | Where-Object { $_ -match "^fatal " })
  $Session.Errors = @($lines | Where-Object { $_ -match "^(js-error|error) " })
  $Session.Missing = @($lines | Where-Object { $_ -match "no Windows version yet: (.+)$" } | ForEach-Object { $Matches[1].Trim() })
  $first = "never logged its first window"
  if ($null -ne $Session.FirstWindowMs) { $first = "first window $($Session.FirstWindowMs) ms after the process started" }
  if ($exitedOnItsOwn) {
    $Session.Summary = "The app exited on its own (exit code $($Session.Process.ExitCode)); $first."
    $Session.Crashed = $true
  } else {
    $Session.Summary = "Stopped by the tour; $first."
  }
  if ($Session.Fatal.Count -and -not $exitedOnItsOwn) { $Session.Summary += " The log has fatal lines although the app kept running (a fault it survived)." }
  Write-Host "[tour] '$($Session.Name)': $($Session.Summary)"
  foreach ($line in $Session.Fatal) { Write-Host $line }
  Write-Tour
}

function Test-Usable($Session) {
  return $Session -and -not $Session.Process.HasExited -and $Session.Main -ne [IntPtr]::Zero
}

function Get-TitleBand($Session) {
  $last = @(Read-LogLines $Session.Log | Where-Object { $_ -match "^window \d+ title band of \S+ is (caption|content)" } | Select-Object -Last 1)
  if (-not $last.Count) { return "content (never switched)" }
  if ($last[0] -match " is (caption|content)") { return $Matches[1] }
  return "unknown"
}

function Wait-Command($Session, [int]$Mark, [string]$Command, [int]$Milliseconds = 2500) {
  return Wait-Until $Session { (Get-LinesSince $Session $Mark "^command \d+ $([regex]::Escape($Command))$").Count -gt 0 } $Milliseconds
}

function Read-Onboarding($Session) {
  $path = Join-Path $Session.Data "onboarding.json"
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    try {
      if (-not (Test-Path -LiteralPath $path)) { return $null }
      $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
      try {
        $text = [System.IO.StreamReader]::new($stream).ReadToEnd()
      } finally {
        $stream.Dispose()
      }
      $document = $text | ConvertFrom-Json
      $step = "none"
      $sub = 0
      $completed = $null
      if ($document.PSObject.Properties.Name -contains "step" -and $document.step) { $step = [string]$document.step }
      if ($document.PSObject.Properties.Name -contains "sub" -and $null -ne $document.sub) { $sub = [int]$document.sub }
      if ($document.PSObject.Properties.Name -contains "completedAt" -and $document.completedAt) { $completed = $document.completedAt }
      return [pscustomobject]@{ Step = $step; Sub = $sub; Completed = $completed; Key = "$step/$sub/$completed" }
    } catch {
      Start-Sleep -Milliseconds 150
    }
  }
  return $null
}

function Get-OnboardingCard($Client) {
  $scale = $Client.Scale
  $width = [Math]::Min(880 * $scale, $Client.Width - 80 * $scale)
  $height = [Math]::Min(560 * $scale, $Client.Height - 80 * $scale)
  $left = $Client.X + ($Client.Width - $width) / 2
  $top = $Client.Y + ($Client.Height - $height) / 2
  return [pscustomobject]@{ Left = $left; Top = $top; Width = $width; Height = $height; Bottom = $top + $height; Scale = $scale }
}

function Invoke-OnboardingAdvance($Session, $State, $Stop) {
  $client = Get-Client $Session.Main
  if (-not $client) { throw "the onboarding window could not be measured" }
  $card = Get-OnboardingCard $client
  $scale = $card.Scale
  $hasBack = $State.Step -ne "source"
  $primaryLeft = $card.Left + 24 * $scale
  if ($hasBack) { $primaryLeft += (36 + 10) * $scale }
  $rowY = [int]($card.Bottom - 42 * $scale)
  $primaryNames = @("Continue")
  if ($State.Step -eq "outro") { $primaryNames = @("Get Started") }
  $attempts = [System.Collections.Generic.List[object]]::new()
  if ($State.Step -ne "source") {
    foreach ($name in $primaryNames) { $attempts.Add([pscustomobject]@{ Label = "'$name' found by UI Automation"; Name = $name; X = 0; Y = 0; Keys = $false }) }
    $attempts.Add([pscustomobject]@{ Label = "the primary button by position"; Name = ""; X = [int]($primaryLeft + 28 * $scale); Y = $rowY; Keys = $false })
  }
  if ($State.Step -ne "outro") {
    $attempts.Add([pscustomobject]@{ Label = "'Skip' found by UI Automation"; Name = "Skip"; X = 0; Y = 0; Keys = $false })
    $attempts.Add([pscustomobject]@{ Label = "Skip by position"; Name = ""; X = [int]($primaryLeft + (96 + 10 + 29) * $scale); Y = $rowY; Keys = $false })
  }
  $attempts.Add([pscustomobject]@{ Label = "Tab then Enter"; Name = ""; X = 0; Y = 0; Keys = $true })
  foreach ($attempt in $attempts) {
    Focus-Window $Session $Session.Main $null | Out-Null
    if ($attempt.Keys) {
      Send-Chord @() 0x09
      Send-Chord @() 0x0D
    } elseif ($attempt.Name) {
      $hits = @(Find-Named $Session.Main $attempt.Name)
      if (-not $hits.Count) { continue }
      Send-Click $hits[0].X $hits[0].Y
    } else {
      Send-Click $attempt.X $attempt.Y
    }
    $moved = Wait-Until $Session { $now = Read-Onboarding $Session; $now -and $now.Key -ne $State.Key } 2500
    if ($moved) {
      $now = Read-Onboarding $Session
      $Stop.Facts.Add("advanced with $($attempt.Label) to $($now.Step) $($now.Sub)")
      return $true
    }
    $Stop.Facts.Add("$($attempt.Label) did not advance")
  }
  return $false
}

function Invoke-OnboardingTour {
  $session = Start-Ardia "onboarding"
  if (-not (Test-Usable $session)) {
    Invoke-Stop $session "onboarding-launch" "Onboarding: first launch" {
      param($stop)
      $stop.Did = "Launched with a fresh data folder."
      $stop.Expected = "a window and the '[ardia windows] first window' log line within $LaunchSeconds s."
      $stop.Seen = "no"
      $stop.Facts.Add("windows: $(Format-Windows (Get-TopWindows $session))")
    } | Out-Null
    Stop-Ardia $session
    return
  }
  Invoke-Stop $session "onboarding-intro" "Onboarding: intro animation" {
    param($stop)
    $stop.Did = "Launched with a fresh data folder and shot the intro while it plays."
    $stop.Expected = "onboarding.json at the intro step."
    Focus-Window $session $session.Main $stop | Out-Null
    $state = Read-Onboarding $session
    Save-Shot $stop $session.Main | Out-Null
    if ($state) {
      Set-Seen $stop ($state.Step -eq "intro" -or $state.Step -eq "source")
      $stop.Facts.Add("onboarding.json step is $($state.Step)")
    } else {
      $stop.Seen = "no"
      $stop.Facts.Add("onboarding.json was not written")
    }
    $stop.Facts.Add("foreground is ours: $(Test-ForegroundIsOurs $session)")
  } | Out-Null

  Invoke-Stop $session "onboarding-intro-ends" "Onboarding: intro hands over to the first question" {
    param($stop)
    $stop.Did = "Waited up to 8 s for the intro to finish on its own, then clicked its Skip button."
    $stop.Expected = "onboarding.json moves to the source step."
    $ended = Wait-Until $session { $now = Read-Onboarding $session; $now -and $now.Step -ne "intro" } 8000
    if (-not $ended) {
      $client = Get-Client $session.Main
      $hits = @(Find-Named $session.Main "Skip")
      if ($hits.Count) { Send-Click $hits[0].X $hits[0].Y; $stop.Facts.Add("clicked Skip found by UI Automation") }
      elseif ($client) { Send-Click ($client.X + $client.Width - [int](57 * $client.Scale)) ($client.Y + $client.Height - [int](46 * $client.Scale)); $stop.Facts.Add("clicked Skip by position") }
      $ended = Wait-Until $session { $now = Read-Onboarding $session; $now -and $now.Step -ne "intro" } 3000
    } else {
      $stop.Facts.Add("the intro ended on its own")
    }
    Start-Sleep -Milliseconds 1200
    Set-Seen $stop $ended
  } | Out-Null

  $seenKeys = @{}
  for ($screen = 0; $screen -lt 32; $screen++) {
    if (-not (Test-Usable $session)) { break }
    $state = Read-Onboarding $session
    if (-not $state -or $state.Completed) { break }
    if ($seenKeys.ContainsKey($state.Key) -and $seenKeys[$state.Key] -ge 2) { break }
    $seenKeys[$state.Key] = 1 + [int]$seenKeys[$state.Key]
    $slug = "onboarding-$($state.Step)-$($state.Sub + 1)"
    $result = Invoke-Stop $session $slug "Onboarding: $($state.Step), question $($state.Sub + 1)" {
      param($stop)
      $stop.Did = "Shot the screen, then pressed its primary button (Skip on the source step, whose Continue waits for a choice)."
      $stop.Expected = "onboarding.json moves to the next question."
      Start-Sleep -Milliseconds 900
      Focus-Window $session $session.Main $stop | Out-Null
      Save-Shot $stop $session.Main | Out-Null
      Set-Seen $stop (Invoke-OnboardingAdvance $session $state $stop)
      Start-Sleep -Milliseconds 500
    }
    if ($result.Seen -ne "yes") { break }
  }

  Invoke-Stop $session "onboarding-done" "Onboarding: finished, the browser behind it" {
    param($stop)
    $stop.Did = "Waited for the onboarding to close after its last screen."
    $stop.Expected = "onboarding.json has completedAt."
    $done = Wait-Until $session { $now = Read-Onboarding $session; $now -and $now.Completed } 3000
    Start-Sleep -Milliseconds 1500
    Save-Shot $stop $session.Main | Out-Null
    Set-Seen $stop $done
    $now = Read-Onboarding $session
    if ($now) { $stop.Facts.Add("onboarding.json is at $($now.Step) $($now.Sub), completedAt $($now.Completed)") }
  } | Out-Null
  Stop-Ardia $session
}

function Read-FocusedText {
  if (-not (Initialize-Uia)) { return "(no UI Automation)" }
  try {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if (-not $focused) { return "(nothing focused)" }
    $pattern = $null
    if ($focused.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { return [string]$pattern.Current.Value }
    return "(focused $($focused.Current.ControlType.ProgrammaticName) '$($focused.Current.Name)' has no value)"
  } catch {
    return "(focus unreadable: $($_.Exception.Message))"
  }
}

function Read-FocusedId {
  if (-not (Initialize-Uia)) { return "?" }
  try {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if (-not $focused) { return "none" }
    return ($focused.GetRuntimeId() -join ".")
  } catch {
    return "?"
  }
}

function Format-OnboardingNow($Session) {
  $now = Read-Onboarding $Session
  if (-not $now) { return "no onboarding.json" }
  if ($now.Completed) { return "completed at $($now.Completed) (step $($now.Step) $($now.Sub))" }
  return "step $($now.Step) $($now.Sub), not completed"
}

function Send-QuickChord([byte[]]$Modifiers, [byte]$Key) {
  foreach ($modifier in $Modifiers) { Send-Key $modifier 0 }
  Start-Sleep -Milliseconds 15
  Send-Key $Key 0
  $sinceKeyDown = [System.Diagnostics.Stopwatch]::StartNew()
  Start-Sleep -Milliseconds 15
  Send-Key $Key 2
  foreach ($modifier in $Modifiers) { Send-Key $modifier 2 }
  return $sinceKeyDown
}

function Test-FirstKeyKept([string]$Field, [string]$Typed) {
  if (-not $Field -or $Field[0] -ne $Typed[0]) { return $false }
  $rest = $Typed.Substring(1)
  $at = 0
  foreach ($character in $Field.ToCharArray()) {
    $at = $rest.IndexOf($character, $at)
    if ($at -lt 0) { return $true }
    $at++
  }
  return $false
}

function Send-HumanText([string]$Text, $Reads, [int]$KeyMs = 30) {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  foreach ($character in $Text.ToUpperInvariant().ToCharArray()) {
    $began = $clock.ElapsedMilliseconds
    $key = [byte][char]$character
    if ($character -eq '.') { $key = 0xBE }
    Send-Key $key 0
    Send-Key $key 2
    if ($null -ne $Reads) { $Reads.Add("$($character.ToString().ToLowerInvariant()) +$began '$(Read-FocusedText)' in $(Read-FocusedId) at +$($clock.ElapsedMilliseconds)") }
    $left = $KeyMs - ($clock.ElapsedMilliseconds - $began)
    if ($left -gt 0) { Start-Sleep -Milliseconds $left }
  }
}

function Find-Edits([IntPtr]$Window) {
  if (-not (Initialize-Uia)) { return @() }
  $found = @()
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Window)
    $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
    foreach ($element in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)) {
      try {
        $box = $element.Current.BoundingRectangle
        if ($box.IsEmpty -or $box.Width -le 0 -or $element.Current.IsOffscreen) { continue }
        $found += [pscustomobject]@{ X = [int]($box.X + 24); Y = [int]($box.Y + $box.Height / 2); Width = [int]$box.Width; Name = $element.Current.Name }
      } catch { }
    }
  } catch { }
  return @($found | Sort-Object -Property Width -Descending)
}

function Walk-OnboardingToOutro($Session, [switch]$SkipEach) {
  $ended = Wait-Until $Session { $now = Read-Onboarding $Session; $now -and $now.Step -ne "intro" } 12000
  if (-not $ended) {
    $hits = @(Find-Named $Session.Main "Skip")
    if ($hits.Count) { Send-Click $hits[0].X $hits[0].Y }
    Wait-Until $Session { $now = Read-Onboarding $Session; $now -and $now.Step -ne "intro" } 4000 | Out-Null
  }
  Start-Sleep -Milliseconds 1200
  $log = [System.Collections.Generic.List[string]]::new()
  for ($screen = 0; $screen -lt 32; $screen++) {
    if (-not (Test-Usable $Session)) { break }
    $state = Read-Onboarding $Session
    if (-not $state -or $state.Completed -or $state.Step -eq "outro") { break }
    Focus-Window $Session $Session.Main $null | Out-Null
    $moved = $false
    if ($SkipEach) {
      $hits = @(Find-Named $Session.Main "Skip")
      if ($hits.Count) {
        Send-Click $hits[0].X $hits[0].Y
        $moved = Wait-Until $Session { $now = Read-Onboarding $Session; $now -and $now.Key -ne $state.Key } 2500
      }
    }
    if (-not $moved) {
      $scratch = [pscustomobject]@{ Facts = [System.Collections.Generic.List[string]]::new() }
      $moved = Invoke-OnboardingAdvance $Session $state $scratch
    }
    $log.Add("$($state.Step) $($state.Sub): $moved")
    if (-not $moved) { break }
    Start-Sleep -Milliseconds 700
  }
  Start-Sleep -Milliseconds 900
  $now = Read-Onboarding $Session
  return [pscustomobject]@{ AtOutro = [bool]($now -and $now.Step -eq "outro" -and -not $now.Completed); Screens = ($log -join ", ") }
}

function Click-Named($Session, [string]$Name) {
  $hits = @(Find-Named $Session.Main $Name)
  if (-not $hits.Count) { return $false }
  Send-Click $hits[0].X $hits[0].Y
  return $true
}

function Get-BarGaps($Session, [int]$Mark) {
  $lines = @(Get-LinesSince $Session $Mark "^(command \d+ newTab|\w+ \d+ \[ardia windows\] new tab bar )")
  $command = $null
  $tab = $null
  $firstTyped = $null
  $mounts = 0
  $found = [ordered]@{}
  foreach ($line in $lines) {
    if ($line -match "^command (\d+) newTab") { if ($null -eq $command) { $command = [int64]$Matches[1] }; continue }
    if ($null -eq $command -or $line -notmatch "^\w+ (\d+) \[ardia windows\] new tab bar (\w+) (\S+)") { continue }
    $at = [int64]$Matches[1]
    $stage = $Matches[2]
    $id = $Matches[3]
    if ($null -eq $firstTyped -and $stage -eq "typed") { $firstTyped = [pscustomobject]@{ Tab = $id; Ms = $at - $command } }
    if ($null -eq $tab -and $stage -eq "page") { $tab = $id }
    if ($stage -eq "page" -and $id -eq $tab) { $mounts++ }
    if ($id -ne $tab -and $null -ne $tab) { continue }
    if (-not $found.Contains("$id $stage")) { $found["$id $stage"] = $at }
  }
  $gaps = [pscustomobject]@{ Text = ""; Tab = $tab; FocusedMs = $null; FirstTyped = $firstTyped; Mounts = 0 }
  if ($null -eq $command) { $gaps.Text = "no newTab command in the log"; return $gaps }
  if ($null -eq $tab) { $gaps.Text = "no new tab page after the command"; return $gaps }
  if ($found.Contains("$tab focused")) { $gaps.FocusedMs = $found["$tab focused"] - $command }
  $parts = @(foreach ($stage in "page", "committed", "focused", "rest", "typed") { if ($found.Contains("$tab $stage")) { "$stage +$($found["$tab $stage"] - $command) ms" } else { "$stage not logged" } })
  $typedBy = if ($firstTyped) { "the first typed mark after the command: $($firstTyped.Tab) +$($firstTyped.Ms) ms" } else { "no typed mark after the command" }
  $gaps.Mounts = $mounts
  $gaps.Text = "$tab " + ($parts -join ", ") + "; the page mounted $mounts time(s); $typedBy"
  return $gaps
}

$script:FocusBoundMs = 90
$script:FirstLetters = [System.Collections.Generic.List[object]]::new()

function Format-BarMarks($Session, [int]$Mark) {
  $lines = @(Get-LinesSince $Session $Mark "\[ardia windows\] (bar |js stall|new tab bar |new tab pane )" | ForEach-Object { $_ -replace '\[ardia windows\] ', '' } | Select-Object -First 60)
  if ($lines.Count) { return $lines -join ' / ' }
  return "none"
}

function Invoke-BarTypingStop($Session, [string]$Slug, [string]$Title, [string]$Did, [scriptblock]$Open, [scriptblock]$Close, [int]$FirstKeyMs, [int]$KeyMs, [int]$Tries) {
  $stop = Invoke-Stop $Session $Slug $Title {
    param($stop)
    $stop.Did = $Did
    $stop.Expected = "every key lands in every try, so the field reads 'example.com' after the last key (#2101)."
    if (-not (Test-Usable $Session)) { $stop.Seen = "no"; $stop.Facts.Add("no usable window"); return }
    Focus-Window $Session $Session.Main $stop | Out-Null
    $lost = 0
    for ($try = 1; $try -le $Tries; $try++) {
      $mark = Get-LogCount $Session
      $sinceOpen = & $Open
      $left = $FirstKeyMs - $sinceOpen.ElapsedMilliseconds
      if ($left -gt 0) { Start-Sleep -Milliseconds $left }
      $keyReads = [System.Collections.Generic.List[string]]::new()
      Send-HumanText "example.com" $keyReads $KeyMs
      $typed = Read-FocusedText
      $settle = [System.Diagnostics.Stopwatch]::StartNew()
      while ($typed -ne "example.com" -and $settle.ElapsedMilliseconds -lt 1500) {
        Start-Sleep -Milliseconds 100
        $typed = Read-FocusedText
      }
      if ($typed -ne "example.com") { $lost++ }
      if ($try -eq 1) { Save-Shot $stop $Session.Main | Out-Null }
      $stop.Facts.Add("try $($try): '$typed' in $(Read-FocusedId); after every key: $($keyReads -join ', '); marks: $(Format-BarMarks $Session $mark)")
      & $Close
      Start-Sleep -Milliseconds 700
    }
    $stop.Facts.Add("lost a letter in $lost of $Tries tries")
    Set-Seen $stop ($lost -eq 0)
  }
  if ($stop.Seen -ne "yes") { $script:FailedStops.Add("$($stop.Number) $Title") }
}

function Close-Bar {
  Send-Escape
  Start-Sleep -Milliseconds 150
  Send-Escape
}

function Invoke-TypingTour {
  $session = Start-Ardia "typing-sidebar" -Onboarded
  if (-not (Test-Usable $session)) { $script:FailedStops.Add("Typing (typing-sidebar): no usable window") }
  if (Test-Usable $session) {
    $opened = Invoke-Stop $session "typing-page" "Not a first run: open Example Domain to type over" {
      param($stop)
      $stop.Did = "Launched onboarded, opened example.com in a tab."
      $stop.Expected = "the window's title names example.com, the host Ardia shows for the open page."
      Set-Seen $stop (Open-Page $session $stop "example.com" "example\.com")
    }
    if ($opened.Seen -ne "yes") { $script:FailedStops.Add("$($opened.Number) Not a first run: open Example Domain to type over") }
    Invoke-BarTypingStop $session "typing-ctrl-l" "Not a first run: Ctrl+L on a page, typing at 80 ms a key, ten tries" "On Example Domain, pressed Ctrl+L, typed example.com from 300 ms after it at 80 ms a key, reading the field after every key, then closed the bar with Escape; ten times." { Send-QuickChord @(0x11) 0x4C } { Close-Bar } 300 80 10
    Invoke-BarTypingStop $session "typing-ctrl-t" "Not a first run: Ctrl+T, typing at 80 ms a key from 100 ms after it, ten tries" "Pressed Ctrl+T, typed example.com from 100 ms after it at 80 ms a key, reading the field after every key, then closed the tab with Ctrl+W; ten times." { Send-QuickChord @(0x11) 0x54 } { Send-Chord @(0x11) 0x57 } 100 80 10
  }
  Stop-Ardia $session

  $session = Start-Ardia "typing-top" -Onboarded -Settings @{ tabLayout = "top" }
  if (-not (Test-Usable $session)) { $script:FailedStops.Add("Typing (typing-top): no usable window") }
  if (Test-Usable $session) {
    $opened = Invoke-Stop $session "typing-top-page" "Not a first run, tabs on top: open Example Domain to type over" {
      param($stop)
      $stop.Did = "Launched onboarded with tabLayout = top, opened example.com in a tab."
      $stop.Expected = "the window's title names example.com, the host Ardia shows for the open page."
      Set-Seen $stop (Open-Page $session $stop "example.com" "example\.com")
    }
    if ($opened.Seen -ne "yes") { $script:FailedStops.Add("$($opened.Number) Not a first run, tabs on top: open Example Domain to type over") }
    Invoke-BarTypingStop $session "typing-toolbar" "Not a first run, tabs on top: Ctrl+L into the toolbar's address field, typing at 80 ms a key, ten tries" "With tabs on top, on Example Domain, pressed Ctrl+L, typed example.com from 300 ms after it at 80 ms a key, reading the field after every key, then closed the bar with Escape; ten times." { Send-QuickChord @(0x11) 0x4C } { Close-Bar } 300 80 10
  }
  Stop-Ardia $session

  $session = Start-Ardia "typing-floating" -Onboarded -Settings @{ newTabOpens = "commandBar" }
  if (-not (Test-Usable $session)) { $script:FailedStops.Add("Typing (typing-floating): no usable window") }
  if (Test-Usable $session) {
    Invoke-BarTypingStop $session "typing-floating" "Not a first run, new tabs open the command bar: Ctrl+T into the floating bar, typing at 80 ms a key, ten tries" "With newTabOpens = commandBar, pressed Ctrl+T, typed example.com from 100 ms after it at 80 ms a key, reading the field after every key, then closed the floating bar with Escape; ten times." { Send-QuickChord @(0x11) 0x54 } { Close-Bar } 100 80 10
  }
  Stop-Ardia $session

  Invoke-HoldTour
}

function Read-EditTexts([IntPtr]$Window) {
  if (-not (Initialize-Uia)) { return @() }
  $texts = @()
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Window)
    $edit = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
    $document = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
    $either = [System.Windows.Automation.OrCondition]::new($edit, $document)
    foreach ($element in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $either)) {
      try {
        $pattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $texts += [string]$pattern.Current.Value; continue }
        if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { $texts += [string]$pattern.DocumentRange.GetText(-1) }
      } catch { }
    }
  } catch { }
  return @($texts)
}

function Send-Char([char]$Character) {
  $key = [byte][char]([string]$Character).ToUpperInvariant()
  if ($Character -eq '.') { $key = 0xBE }
  Send-Key $key 0
  Send-Key $key 2
}

function Send-Typed([string]$Text, [int]$KeyMs = 30) {
  foreach ($character in $Text.ToCharArray()) {
    Send-Char $character
    Start-Sleep -Milliseconds $KeyMs
  }
}

function Get-HoldLines($Session, [int]$Mark) {
  return @(Get-LinesSince $Session $Mark "^keys \d+ hold ")
}

function Get-HoldEnd($Session, [int]$Mark, [string]$Reason) {
  $lines = @(Get-HoldLines $Session $Mark)
  if (@($lines | Where-Object { $_ -match "dropped: $Reason with [1-9]\d* held" }).Count -ge 1) { return "dropped" }
  if (@($lines | Where-Object { $_ -match " dropped: " }).Count -ge 1) { return "dropped otherwise" }
  if (@($lines | Where-Object { $_ -match " ready after \d+ ms, replayed " }).Count -ge 1) { return "ready" }
  return "none"
}

$script:HoldReadyMs = 400

function Invoke-HoldStop($Session, [string]$Slug, [string]$Title, [string]$Did, [string]$Expected, [scriptblock]$Act, [scriptblock]$Judge) {
  $stop = Invoke-Stop $Session $Slug $Title {
    param($stop)
    $stop.Did = "$Did The bar's readiness is held to $($script:HoldReadyMs) ms after the command (ARDIA_TEST keyHoldReadyMs), as on a slow launch, so the keys arrive while the hold runs."
    $stop.Expected = $Expected
    if (-not (Test-Usable $Session)) { $stop.Seen = "no"; $stop.Facts.Add("no usable window"); return }
    Focus-Window $Session $Session.Main $stop | Out-Null
    $mark = Get-LogCount $Session
    $chord = Send-QuickChord @(0x11) 0x54
    $left = 15 - $chord.ElapsedMilliseconds
    if ($left -gt 0) { Start-Sleep -Milliseconds $left }
    $acted = & $Act $stop
    Start-Sleep -Milliseconds 1500
    $field = Read-FocusedText
    $stop.Facts.Add("the focused field: '$field'")
    $stop.Facts.Add("key hold lines: $((Get-HoldLines $Session $mark) -join ' / ')")
    $stop.Facts.Add("bar marks: $(Format-BarMarks $Session $mark)")
    Set-Seen $stop ([bool](& $Judge $stop $field $mark $acted))
    Save-Shot $stop $Session.Main | Out-Null
    Send-Escape
    Start-Sleep -Milliseconds 150
    Send-Chord @(0x11) 0x57
    Start-Sleep -Milliseconds 500
  }
  if ($stop.Seen -ne "yes") { $script:FailedStops.Add("$($stop.Number) $Title") }
}

function Invoke-WholeTextTries($Session, [string]$Slug, [string]$Title, [string]$How) {
  $stop = Invoke-Stop $Session $Slug $Title {
    param($stop)
    $stop.Did = "Ten times: pressed Ctrl+T, and from 15 ms after it typed example.com, 30 ms a key, $How; read the bar 1.5 s after the last key, then pressed Escape and Ctrl+W. Example Domain is in this profile's history, so the bar's inline completion offers example.com from the first letter."
    $stop.Expected = "the bar reads 'example.com' in all ten tries (#2099, #2124)."
    if (-not (Test-Usable $Session)) { $stop.Seen = "no"; $stop.Facts.Add("no usable window"); return }
    $kept = 0
    for ($try = 1; $try -le 10; $try++) {
      Focus-Window $Session $Session.Main $null | Out-Null
      $mark = Get-LogCount $Session
      $chord = Send-QuickChord @(0x11) 0x54
      $left = 15 - $chord.ElapsedMilliseconds
      if ($left -gt 0) { Start-Sleep -Milliseconds $left }
      Send-Typed "example.com"
      Start-Sleep -Milliseconds 1500
      $field = Read-FocusedText
      $holds = (Get-HoldLines $Session $mark) -join ' / '
      if ($field -ceq "example.com") { $kept++; $stop.Facts.Add("try $try`: kept; $holds") }
      else { $stop.Facts.Add("try $try`: '$field'; $holds; bar marks: $(Format-BarMarks $Session $mark)") }
      Send-Escape
      Start-Sleep -Milliseconds 150
      Send-Chord @(0x11) 0x57
      Start-Sleep -Milliseconds 600
    }
    $stop.Facts.Add("the bar read 'example.com' in $kept of 10")
    Set-Seen $stop ($kept -eq 10)
  }
  if ($stop.Seen -ne "yes") { $script:FailedStops.Add("$($stop.Number) $Title") }
}

function Invoke-HoldTour {
  $env:ARDIA_TEST = "keyHoldReadyMs=$($script:HoldReadyMs)"
  $session = Start-Ardia "hold" -Onboarded
  $env:ARDIA_TEST = ""
  if (-not (Test-Usable $session)) { $script:FailedStops.Add("Hold (hold): no usable window"); Stop-Ardia $session; return }
  $opened = Invoke-Stop $session "hold-page" "Key hold: open Example Domain in the first tab" {
    param($stop)
    $stop.Did = "Launched onboarded, opened example.com in a tab."
    $stop.Expected = "the window's title names example.com."
    Set-Seen $stop (Open-Page $session $stop "example.com" "example\.com")
  }
  if ($opened.Seen -ne "yes") { $script:FailedStops.Add("$($opened.Number) Key hold: open Example Domain in the first tab") }

  Invoke-HoldStop $session "hold-capitals" "Key hold: capitals from a held Shift and from Caps Lock, typed 15 ms after Ctrl+T" "Pressed Ctrl+T, and from 15 ms after it typed A with Shift held, then b, then Caps Lock, c, d, Caps Lock, 30 ms a key." "the new tab's bar reads 'AbCD' (#2099)." {
    param($stop)
    Send-Key 0x10 0; Send-Char 'a'; Send-Key 0x10 2; Start-Sleep -Milliseconds 30
    Send-Char 'b'; Start-Sleep -Milliseconds 30
    Send-Key 0x14 0; Send-Key 0x14 2; Send-Char 'c'; Start-Sleep -Milliseconds 30; Send-Char 'd'; Send-Key 0x14 0; Send-Key 0x14 2
  } { param($stop, $field, $mark) $field -ceq "AbCD" -and @(Get-HoldLines $session $mark | Where-Object { $_ -match " ready after \d+ ms, replayed 4" }).Count -eq 1 }

  Invoke-WholeTextTries $session "hold-whole" "Key hold: example.com typed from 15 ms after Ctrl+T, all of it before the bar is ready, ten tries" "with readiness held to $($script:HoldReadyMs) ms, so all 11 letters are held and replayed"

  Invoke-Stop $session "hold-pairs" "Key hold: ab typed from 15 ms after Ctrl+T, six tries (report only)" {
    param($stop)
    $stop.Did = "Six times: pressed Ctrl+T, and from 15 ms after it typed ab, 10 ms a key, with readiness held to $($script:HoldReadyMs) ms, read the bar after 1.5 s, then pressed Escape and Ctrl+W."
    $stop.Expected = "report only: how often the bar reads 'ab' once both are replayed, since #2101's first-change revert can take the second letter."
    if (-not (Test-Usable $session)) { $stop.Seen = "no"; $stop.Facts.Add("no usable window"); return }
    $kept = 0
    for ($try = 1; $try -le 6; $try++) {
      Focus-Window $session $session.Main $null | Out-Null
      $chord = Send-QuickChord @(0x11) 0x54
      $left = 15 - $chord.ElapsedMilliseconds
      if ($left -gt 0) { Start-Sleep -Milliseconds $left }
      Send-Typed "ab" 10
      Start-Sleep -Milliseconds 1500
      $field = Read-FocusedText
      if ($field -ceq "ab") { $kept++ }
      $stop.Facts.Add("try $try`: '$field'")
      Send-Escape
      Start-Sleep -Milliseconds 150
      Send-Chord @(0x11) 0x57
      Start-Sleep -Milliseconds 500
    }
    $stop.Facts.Add("the bar read 'ab' in $kept of 6")
    $stop.Seen = "yes"
  } | Out-Null

  Invoke-HoldStop $session "hold-backspace" "Key hold: Backspace typed 15 ms after Ctrl+T ends the hold" "Pressed Ctrl+T, and from 15 ms after it typed ab, 10 ms a key, then Backspace." "the hold ends on Backspace with a and b dropped, logged as a drop with keys held, the bar is empty and Example Domain's tab is unchanged (Backspace and Enter end a hold in version 1) (#2099)." {
    param($stop)
    Send-Typed "ab" 10
    Send-Key 0x08 0; Send-Key 0x08 2
  } { param($stop, $field, $mark) $end = Get-HoldEnd $session $mark "Backspace or Enter"; $stop.Facts.Add("the hold ended: $end"); $end -eq "dropped" -and $field -eq "" -and ([ArdiaTour]::TitleOf($session.Main)) -match "Tabs" }

  Invoke-HoldStop $session "hold-escape" "Key hold: typing then Escape 15 ms after Ctrl+T leaves nothing anywhere" "With Example Domain in the first tab, pressed Ctrl+T, and from 15 ms after it typed ab, then Escape." "the new tab's bar is empty and Example Domain's tab is unchanged (#2099)." {
    param($stop)
    Send-Typed "ab"
    Send-Escape
  } { param($stop, $field, $mark) $end = Get-HoldEnd $session $mark "a key without a character"; $stop.Facts.Add("the hold ended: $end"); $end -eq "dropped" -and $field -eq "" -and ([ArdiaTour]::TitleOf($session.Main)) -match "Tabs" }

  $before = @(Get-TopWindows $session)
  Send-Chord @(0x11) 0x4E
  Start-Sleep -Milliseconds 2500
  $second = @(Get-NewWindows $session $before) | Select-Object -First 1
  if ($second) {
    [ArdiaTour]::SetWindowPos($second.Handle, [IntPtr](-1), 500, 400, 520, 360, 0x0040) | Out-Null
    Start-Sleep -Milliseconds 700
    $secondBox = @(Find-Edits $second.Handle) | Select-Object -First 1
    Focus-Window $session $session.Main $null | Out-Null
    Invoke-HoldStop $session "hold-click-ours" "Key hold: typing, then a click into another window of ours before the bar is ready" "Opened a second window, went back to the first, pressed Ctrl+T, and from 15 ms after it typed ab, then clicked the second window's bar." "the hold ends on the click, logged as a drop with keys held, and the second window's bar gets none of it (#2099)." {
      param($stop)
      Send-Typed "ab" 10
      if ($secondBox) { Send-Click $secondBox.X $secondBox.Y }
      Start-Sleep -Milliseconds 500
      $texts = @(Read-EditTexts $second.Handle)
      $script:HoldReadCount = $texts.Count
      $stop.Facts.Add("the second window's fields: $(($texts | ForEach-Object { "'$_'" }) -join ', ')")
      Focus-Window $session $session.Main $null | Out-Null
      return $texts
    } { param($stop, $field, $mark, $acted) $end = Get-HoldEnd $session $mark "(a mouse button|the window lost the keyboard)"; $stop.Facts.Add("the hold ended: $end"); $stop.Facts.Add("the second window's field to click: $(if ($secondBox) { "$($secondBox.X),$($secondBox.Y)" } else { 'not found' })"); $end -eq "dropped" -and $secondBox -and $script:HoldReadCount -ge 1 -and @($acted | Where-Object { $_ -match "[ab]" }).Count -eq 0 }
    [ArdiaTour]::SetWindowPos($second.Handle, [IntPtr](-2), 0, 0, 0, 0, 0x0013) | Out-Null
    [ArdiaTour]::PostMessageW($second.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 800
  } else {
    $script:FailedStops.Add("Key hold: Ctrl+N opened no second window")
  }

  $padsBefore = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match "^notepad$" } | ForEach-Object { $_.Id })
  $notepad = $null
  try { $notepad = Start-Process -FilePath "notepad.exe" -PassThru -ErrorAction Stop } catch { $notepad = $null }
  $pad = [IntPtr]::Zero
  $ours = @()
  if ($notepad) {
    $deadline = (Get-Date).AddSeconds(10)
    while ($pad -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 250
      $ours = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match "^notepad$" -and $padsBefore -notcontains $_.Id })
      $found = @($ours | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }) | Select-Object -First 1
      if ($found) { $pad = $found.MainWindowHandle }
    }
  }
  if ($pad -ne [IntPtr]::Zero) {
    [ArdiaTour]::SetWindowPos($pad, [IntPtr](-1), 640, 420, 360, 260, 0x0040) | Out-Null
    Focus-Window $session $session.Main $null | Out-Null
    Invoke-HoldStop $session "hold-click-other" "Key hold: typing, then a click into another program before the bar is ready" "With Notepad open beside Ardia, pressed Ctrl+T, and from 15 ms after it typed ab, then clicked into Notepad." "the hold ends when Notepad takes the keyboard, logged as a drop with keys held, and Notepad gets none of it (#2099)." {
      param($stop)
      $client = Get-Client $pad
      Send-Typed "ab" 10
      if ($client) { Send-Click ([int]($client.X + $client.Width / 2)) ([int]($client.Y + $client.Height / 2)) }
      Start-Sleep -Milliseconds 500
      $texts = @([ArdiaTour]::EditTextsOf($pad)) + @(Read-EditTexts $pad)
      $script:HoldReadCount = $texts.Count
      $stop.Facts.Add("Notepad's text, from $($texts.Count) field(s) read: $(($texts | ForEach-Object { "'$_'" }) -join ', ')")
      Focus-Window $session $session.Main $null | Out-Null
      return $texts
    } { param($stop, $field, $mark, $acted) $end = Get-HoldEnd $session $mark "(a mouse button|the window lost the keyboard)"; $stop.Facts.Add("the hold ended: $end"); $end -eq "dropped" -and $script:HoldReadCount -ge 1 -and @($acted | Where-Object { $_ -match "[ab]" }).Count -eq 0 }
  } else {
    Invoke-Stop $session "hold-click-other" "Key hold: typing, then a click into another program" { param($stop) $stop.Did = "Tried to open Notepad."; $stop.Expected = "a Notepad window to click into."; $stop.Seen = "unverified"; $stop.Facts.Add("Notepad didn't open on this runner") } | Out-Null
  }
  $padIds = @()
  if ($notepad) { $padIds += $notepad.Id }
  if ($pad -ne [IntPtr]::Zero) { $padIds += [int][ArdiaTour]::ProcessOf($pad) }
  foreach ($id in ($padIds | Select-Object -Unique)) { if ($padsBefore -notcontains $id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }

  try { Set-Clipboard -Value "pasted" } catch { }
  Invoke-HoldStop $session "hold-ctrl-v" "Key hold: Ctrl+V right after Ctrl+T passes through as today" "Put 'pasted' on the clipboard, pressed Ctrl+T, and 15 ms after it pressed Ctrl+V." "the hold ends on the modified key and the paste goes where it does today (a documented limit) (#2099)." {
    param($stop)
    Send-QuickChord @(0x11) 0x56 | Out-Null
  } { param($stop, $field, $mark) @(Get-LinesSince $session $mark "^keys \d+ hold \d+ dropped: a key with Ctrl, Alt or Win").Count -ge 1 }

  Stop-Ardia $session

  $live = Start-Ardia "hold-live" -Onboarded
  if (-not (Test-Usable $live)) { $script:FailedStops.Add("Hold (hold-live): no usable window"); Stop-Ardia $live; return }
  $page = Invoke-Stop $live "hold-live-page" "Key hold, runner's own timing: open Example Domain in the first tab" {
    param($stop)
    $stop.Did = "Launched onboarded without a readiness floor, opened example.com in a tab."
    $stop.Expected = "the window's title names example.com."
    Set-Seen $stop (Open-Page $live $stop "example.com" "example\.com")
  }
  if ($page.Seen -ne "yes") { $script:FailedStops.Add("$($page.Number) Key hold, runner's own timing: open Example Domain") }
  Invoke-WholeTextTries $live "hold-whole-live" "Key hold, runner's own timing: example.com typed from 15 ms after Ctrl+T, ten tries" "at the runner's own timing, so the first letters are held and the rest arrive live"
  Stop-Ardia $live
}

function Invoke-TypeStop($Session, [string]$Slug, [string]$Title, [string]$Did, [scriptblock]$Before, [string]$Into, [string]$Submit, [string]$Issues, [switch]$Required, [int]$FirstKeyMs = 100, [int]$KeyMs = 30, [switch]$ReadEachKey, [switch]$JudgeWholeText, [switch]$RequireGoHold, [switch]$JudgeLaterLetters) {
  $stop = Invoke-Stop $Session $Slug $Title {
    param($stop)
    $stop.Did = $Did
    $firstKey = if ($Into -eq "ctrl+t") { "the new tab's bar takes focus within $($script:FocusBoundMs) ms of the newTab command, and the first key, typed $FirstKeyMs ms after Ctrl+T, lands in the new tab's bar (the first typed mark after the command is the new tab's, and its field starts with 'e' and can't be read as a later 'e' with the keys before it lost)" } else { "the first key lands in the box (its field starts with 'e' and can't be read as a later 'e')" }
    $wholeText = "every key lands, so the field reads 'example.com' after the last key, and $Submit opens Example Domain in a tab"
    $stop.Expected = if ($JudgeWholeText) { "$wholeText ($Issues)." } else { "$firstKey. Report only ($Issues): $wholeText." }
    if (-not (Test-Usable $Session)) { $stop.Seen = "no"; $stop.Facts.Add("no usable window"); return }
    Focus-Window $Session $Session.Main $stop | Out-Null
    $mark = Get-LogCount $Session
    $reads = [System.Collections.Generic.List[string]]::new()
    $firstKeyAt = $null
    $keyReads = $null
    if ($ReadEachKey) { $keyReads = [System.Collections.Generic.List[string]]::new() }
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    if ($Before) { & $Before $stop }
    $stop.Facts.Add("onboarding.json at the press: $(Format-OnboardingNow $Session)")
    if ($Into -eq "ctrl+t") {
      $chord = Send-QuickChord @(0x11) 0x54
      $left = $FirstKeyMs - $chord.ElapsedMilliseconds
      if ($left -gt 0) { Start-Sleep -Milliseconds $left }
      $firstKeyAt = $chord.ElapsedMilliseconds
      $stop.Facts.Add("Ctrl+T sent $($clock.ElapsedMilliseconds - $chord.ElapsedMilliseconds) ms after the step began; first key $($chord.ElapsedMilliseconds) ms after its T key went down")
    } elseif ($Into -eq "box") {
      $box = $null
      while (-not $box -and $clock.ElapsedMilliseconds -lt 3000) { $box = @(Find-Edits $Session.Main) | Select-Object -First 1; if (-not $box) { Start-Sleep -Milliseconds 40 } }
      if ($box) {
        Send-Click $box.X $box.Y
        $stop.Facts.Add("clicked the New Tab page's box ('$($box.Name)', $($box.Width) px wide) $($clock.ElapsedMilliseconds) ms after the step began")
      } else {
        $stop.Facts.Add("no text box showed within 3 s; typed into whatever had focus")
      }
    }
    $rested = $null
    $holdMark = $null
    $goStayed = $false
    if ($Submit -eq "Go") {
      Send-HumanText "e" $keyReads $KeyMs
      $rested = @(@(Find-Named $Session.Main "Go") + @(Find-Named $Session.Main "Tour")) | Select-Object -First 1
      if ($rested) { Send-MouseMove $rested.X $rested.Y }
      $stop.Facts.Add("after the first letter, moved the mouse onto Go: $([bool]$rested)")
      Send-HumanText "xample.com" $keyReads $KeyMs
    } else {
      Send-HumanText "example.com" $keyReads $KeyMs
    }
    $settle = [System.Diagnostics.Stopwatch]::StartNew()
    $typed = Read-FocusedText
    $reads.Add("0ms '$typed'")
    while ($typed -ne "example.com" -and $settle.ElapsedMilliseconds -lt 3000) {
      Start-Sleep -Milliseconds 100
      $now = Read-FocusedText
      if ($now -ne $typed) { $reads.Add("$($settle.ElapsedMilliseconds)ms '$now'") }
      $typed = $now
    }
    Save-Shot $stop $Session.Main | Out-Null
    if ($null -ne $keyReads) { $stop.Facts.Add("the field after every key ($KeyMs ms a key; key +sent ms 'field' at +read ms): $($keyReads -join ', ')") }
    $stop.Facts.Add("the field after the last key, as it settled: $($reads -join ', ')")
    $stop.Facts.Add("the field before $($Submit): '$typed' in $(Read-FocusedId)")
    if ($Submit -eq "Go") {
      $aimedAt = @(Find-Named $Session.Main "Go") | Select-Object -First 1
      $holdMark = Get-LogCount $Session
      if ($script:SuggestRelease) { New-Item -ItemType File -Force -Path $script:SuggestRelease | Out-Null }
      if ($aimedAt) {
        Start-Sleep -Milliseconds 3000
        $after = @(Find-Named $Session.Main "Go")
        $where = if ($after.Count) { "$($after[0].X),$($after[0].Y)" } else { "not found by that name" }
        $stop.Facts.Add("Go was at $($aimedAt.X),$($aimedAt.Y) when the field settled, with the mouse resting over the bar; 3 s later, after the late suggestions came in, it was at $where; clicked $($aimedAt.X),$($aimedAt.Y)")
        $goStayed = [bool]($after.Count -and $after[0].X -eq $aimedAt.X -and $after[0].Y -eq $aimedAt.Y)
        Send-Click $aimedAt.X $aimedAt.Y
      }
      $stop.Facts.Add("Go button found and clicked: $([bool]$aimedAt)")
    } else {
      Send-Key 0x0D 0
      Send-Key 0x0D 2
    }
    $loaded = Wait-Title $Session "example\.com" 20000
    $stop.Facts.Add("window title: '$([ArdiaTour]::TitleOf($Session.Main))'")
    $stop.Facts.Add("foreground: $(Describe-Foreground)")
    $stop.Facts.Add("onboarding.json after: $(Format-OnboardingNow $Session)")
    $around = @(Get-LinesSince $Session $mark "keyboard|focus|keys |follow|page|tab\.|navigat|omnibox|command|error|onboarding|tour|new tab bar" | Select-Object -First 30)
    if ($around.Count) { $stop.Facts.Add("log from the press on: $($around -join ' / ')") }
    $gaps = Get-BarGaps $Session $mark
    $stop.Facts.Add("from Ctrl+T: $($gaps.Text)")
    $stop.Facts.Add("bar marks: $(Format-BarMarks $Session $mark)")
    $startsRight = Test-FirstKeyKept ([string]$typed) "example.com"
    $whole = [bool]($loaded -and $typed -eq "example.com")
    if ($Into -eq "ctrl+t") {
      $focusInTime = $null -ne $gaps.FocusedMs -and $gaps.FocusedMs -le $script:FocusBoundMs
      $firstInNewBar = $null -ne $gaps.FirstTyped -and $gaps.FirstTyped.Tab -eq $gaps.Tab -and $startsRight
      $stop.Facts.Add("required: focus within $($script:FocusBoundMs) ms: $focusInTime; the first key in the new tab's bar: $firstInNewBar")
      $firstKeyOk = $focusInTime -and $firstInNewBar
    } else {
      $firstKeyOk = $startsRight
      $stop.Facts.Add("required: the first key in the box: $firstKeyOk")
    }
    $stop.Facts.Add("report only ($Issues): every key landed and $Submit opened Example Domain: $whole")
    $heldUnderPointer = $false
    if ($RequireGoHold) {
      $heldUnderPointer = [bool]($rested -and $null -ne $holdMark -and @(Get-LinesSince $Session $holdMark "\[ardia windows\] bar rows pointer over, holding").Count -and $goStayed)
      $stop.Facts.Add("search engine: $($script:SuggestProfile)")
      $served = Join-Path $Out "suggest-server.log"
      if (Test-Path -LiteralPath $served) { $stop.Facts.Add("the tour's suggest server: $((Get-Content -LiteralPath $served | Select-Object -Last 4) -join ' / ')") }
      $stop.Facts.Add("required (#2102): the mouse rested on Go, the bar held the late rows under it after Go's position was noted, and Go stayed put: $heldUnderPointer; $Submit opened Example Domain: $([bool]$loaded)")
    }
    $laterKept = $false
    if ($JudgeLaterLetters) {
      $laterKept = $typed -eq "example.com" -or $typed -eq "xample.com"
      $firstKept = Test-FirstKeyKept ([string]$typed) "example.com"
      $focusFirst = [bool]($null -ne $gaps.FocusedMs -and $null -ne $firstKeyAt -and $gaps.FocusedMs -lt $firstKeyAt)
      $firstRead = if ($null -ne $keyReads -and $keyReads.Count) { $keyReads[0] } else { "" }
      $script:FirstLetters.Add([pscustomobject]@{ Number = $stop.Number; Slug = $Slug; Kept = $firstKept; FocusFirst = $focusFirst; FirstRead = $firstRead; Field = [string]$typed; Mounts = $gaps.Mounts })
      $stop.Facts.Add("required (#2101): no letter lost after the first: $laterKept; counted for the first-letter stop (#2124): first letter kept $firstKept, the bar had focus before it $focusFirst")
    }
    Set-Seen $stop ($(if ($JudgeLaterLetters) { $laterKept } elseif ($JudgeWholeText) { $whole } elseif ($RequireGoHold) { $firstKeyOk -and [bool]$loaded -and $heldUnderPointer } else { $firstKeyOk }))
  }
  if ($Required -and $stop.Seen -ne "yes") { $script:FailedStops.Add("$($stop.Number) $Title") }
  return $stop
}

function Start-Hogs([string]$Folder) {
  $jobs = @()
  for ($core = 0; $core -lt [Math]::Max(2, [Environment]::ProcessorCount * 2); $core++) {
    $jobs += Start-Job { $x = 0; while ($true) { $x = ($x + 1) % 1000003 } }
  }
  $jobs += Start-Job -ArgumentList $Folder {
    param($folder)
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $bytes = New-Object byte[] (64MB)
    while ($true) {
      $path = Join-Path $folder "hog.bin"
      [System.IO.File]::WriteAllBytes($path, $bytes)
      [System.IO.File]::ReadAllBytes($path) | Out-Null
      Remove-Item -Force $path
    }
  }
  return $jobs
}

$script:SuggestPort = 0
$script:LateQuery = "example.com"
$script:LateRows = @("example.com tour one", "example.com tour two", "example.com tour three")
$script:LateMs = 500

$script:SuggestRelease = $null

function Start-SuggestServer([string]$Log) {
  Remove-Item -Force -ErrorAction SilentlyContinue $Log
  $script:SuggestRelease = "$Log.release"
  Remove-Item -Force -ErrorAction SilentlyContinue $script:SuggestRelease
  $portFile = "$Log.port"
  Remove-Item -Force -ErrorAction SilentlyContinue $portFile
  $job = Start-Job -ArgumentList $portFile, $script:LateQuery, $script:LateRows, $script:LateMs, $Log, $script:SuggestRelease {
    param($portFile, $lateQuery, $lateRows, $lateMs, $log, $release)
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    Set-Content -LiteralPath $portFile -Value $listener.LocalEndpoint.Port
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    while ($true) {
      $client = $listener.AcceptTcpClient()
      try {
        $stream = $client.GetStream()
        $reader = [System.IO.StreamReader]::new($stream)
        $line = [string]$reader.ReadLine()
        while ($reader.ReadLine()) { }
        $query = $null
        if ($line -match "^GET /suggest\?q=([^ ]*) ") { $query = [Uri]::UnescapeDataString($Matches[1].Replace("+", " ")) }
        $asked = $clock.ElapsedMilliseconds
        $rows = @()
        if ($query -eq $lateQuery) {
          $waited = [System.Diagnostics.Stopwatch]::StartNew()
          while (-not (Test-Path -LiteralPath $release) -and $waited.ElapsedMilliseconds -lt 15000) { Start-Sleep -Milliseconds 50 }
          Start-Sleep -Milliseconds $lateMs
          $rows = $lateRows
        }
        $body = if ($null -ne $query) { ConvertTo-Json -Compress -InputObject @($query, [object[]]$rows) } else { "<!doctype html><title>Tour search</title>" }
        $type = if ($null -ne $query) { "application/json" } else { "text/html" }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $head = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: $type; charset=utf-8`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n")
        $stream.Write($head, 0, $head.Length)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
        Add-Content -LiteralPath $log -Value "asked $asked ms for '$query', answered $($clock.ElapsedMilliseconds) ms with $($rows.Count) rows"
      } catch {
      } finally {
        $client.Dispose()
      }
    }
  }
  $ready = $false
  $deadline = (Get-Date).AddSeconds(15)
  $script:SuggestPort = 0
  while (-not $script:SuggestPort -and (Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $portFile) { $script:SuggestPort = [int](Get-Content -Raw -LiteralPath $portFile) } else { Start-Sleep -Milliseconds 100 }
  }
  while ($script:SuggestPort -and -not $ready -and (Get-Date) -lt $deadline) {
    try {
      $ready = (Invoke-WebRequest -Uri "http://127.0.0.1:$($script:SuggestPort)/suggest?q=ready" -TimeoutSec 2 -UseBasicParsing).Content -eq '["ready",[]]'
    } catch {
      Start-Sleep -Milliseconds 200
    }
  }
  if (-not $ready) { $script:FailedStops.Add("the tour's suggest server never answered on port $($script:SuggestPort)") }
  return $job
}

function Get-SuggestSettings {
  $base = "http://127.0.0.1:$($script:SuggestPort)"
  return @{ customSearchEngines = @(@{ id = "tour"; name = "Tour"; keyword = "tour.test"; url = "$base/search?q=%s"; suggestUrl = "$base/suggest?q=%s" }); searchEngine = "tour" }
}

function Initialize-SuggestProfile([string]$Name) {
  $prep = Start-Ardia $Name
  $path = Join-Path $prep.Data "session.json"
  if (Test-Usable $prep) { Wait-Until $prep { Test-Path -LiteralPath $path } 8000 | Out-Null }
  Stop-Ardia $prep
  $saved = $null
  if (Test-Path -LiteralPath $path) {
    try { $saved = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json -AsHashtable } catch { $saved = $null }
  }
  $how = if ($saved) { "the session the app saved" } else { "a new session file" }
  if (-not $saved) { $saved = @{ version = 11 } }
  if ($saved["settings"] -isnot [System.Collections.IDictionary]) { $saved["settings"] = @{} }
  foreach ($entry in (Get-SuggestSettings).GetEnumerator()) { $saved["settings"][$entry.Key] = $entry.Value }
  if ($saved["settingsMeta"] -isnot [System.Collections.IDictionary]) { $saved["settingsMeta"] = @{ chosen = @(); inferred = @() } }
  $saved["settingsMeta"]["chosen"] = @(@($saved["settingsMeta"]["chosen"]) + @("searchEngine", "customSearchEngines") | Where-Object { $_ } | Select-Object -Unique)
  Set-Content -LiteralPath $path -Value ($saved | ConvertTo-Json -Depth 64 -Compress) -Encoding utf8NoBOM
  return "the tour search engine written into $how"
}

function Invoke-FirstRunLaunch([string]$Name, [string]$Exe, [scriptblock]$Body, [switch]$OwnSuggestions) {
  $saved = $script:App
  if ($Exe) { $script:App = $Exe }
  try {
    $script:SuggestProfile = $null
    if ($OwnSuggestions) { $script:SuggestProfile = Initialize-SuggestProfile $Name }
    $session = if ($OwnSuggestions) { Start-Ardia $Name -KeepData } else { Start-Ardia $Name }
  } finally {
    $script:App = $saved
  }
  if (Test-Usable $session) {
    Write-Host "[tour] '$Name' first window after $($session.FirstWindowMs) ms"
    & $Body $session
  } else {
    Invoke-Stop $session "$Name-launch" "First run ($Name): launch" {
      param($stop)
      $stop.Did = "Launched with a fresh data folder."
      $stop.Expected = "a window within $LaunchSeconds s."
      $stop.Seen = "no"
    } | Out-Null
    $script:FailedStops.Add("First run ($Name): no usable window")
  }
  Stop-Ardia $session
}

function Invoke-FirstRunTour {
  Invoke-FirstRunLaunch "human-ctrl-t" "" {
    param($session)
    $walk = Walk-OnboardingToOutro $session -SkipEach
    Invoke-TypeStop $session "human-ctrl-t" "First run: Ctrl+T about 400 ms after Get Started, the first key 100 ms after it, then Enter" "Skipped every onboarding step to the last screen ($($walk.Screens); at the last screen: $($walk.AtOutro)), clicked Get Started, pressed Ctrl+T about 400 ms after the click (the click waits 300 ms after the mouse button comes up, then 100 ms more) and typed example.com from 100 ms after it, 30 ms a key, then pressed Enter." { param($stop) $clicked = Click-Named $session "Get Started"; $stop.Facts.Add("Get Started clicked: $clicked"); Start-Sleep -Milliseconds 100 } "ctrl+t" "Enter" "#2101" -Required | Out-Null
  }

  Invoke-FirstRunLaunch "human-box" "" {
    param($session)
    $walk = Walk-OnboardingToOutro $session -SkipEach
    Invoke-TypeStop $session "human-box" "First run: the New Tab page's own box right after Get Started, then Enter" "Skipped every onboarding step to the last screen ($($walk.Screens); at the last screen: $($walk.AtOutro)), clicked Get Started, clicked the New Tab page's box as soon as it showed and typed example.com at once, 30 ms a key, then pressed Enter." { param($stop) $clicked = Click-Named $session "Get Started"; $stop.Facts.Add("Get Started clicked: $clicked") } "box" "Enter" "#2101" -Required | Out-Null
  }

  Invoke-FirstRunLaunch "tool-tour" "" {
    param($session)
    $walk = Walk-OnboardingToOutro $session -SkipEach
    Invoke-TypeStop $session "tool-tour-up" "First run: Ctrl+T while the tool tour is up at its first stop" "Skipped to the last onboarding screen ($($walk.Screens)), clicked Take the Tour, waited 1.5 s for its first stop, pressed Ctrl+T and typed example.com from 100 ms after it, 30 ms a key, then pressed Enter." { param($stop) $clicked = Click-Named $session "Take the Tour"; $stop.Facts.Add("Take the Tour clicked: $clicked"); Start-Sleep -Milliseconds 1500; $stop.Facts.Add("tour buttons showing: Next $(@(Find-Named $session.Main 'Next').Count), Skip Tour $(@(Find-Named $session.Main 'Skip Tour').Count)") } "ctrl+t" "Enter" "#2101" -Required | Out-Null
    Invoke-TypeStop $session "tool-tour-ended" "First run: Ctrl+T right after ending the tool tour" "Ended the tool tour with Skip Tour (or Escape), then about 400 ms after the click (its own 300 ms wait, then 100 ms) pressed Ctrl+T and typed example.com from 100 ms after it, 30 ms a key, then pressed Enter." { param($stop) $clicked = Click-Named $session "Skip Tour"; if (-not $clicked) { Send-Escape }; $stop.Facts.Add("Skip Tour clicked: $clicked"); Start-Sleep -Milliseconds 100 } "ctrl+t" "Enter" "#2101" -Required | Out-Null
  }

  $cold = Join-Path $Out "cold-app"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $cold
  Copy-Item -Recurse -Force (Split-Path -Parent $App) $cold
  $hogs = Start-Hogs (Join-Path $Out "hog")
  Write-Host "[tour] started $($hogs.Count) CPU and disk hogs and copied the app to $cold"
  try {
    Invoke-FirstRunLaunch "slow-engine" (Join-Path $cold (Split-Path -Leaf $App)) {
      param($session)
      $engineMs = @(Read-LogLines $session.Log | Where-Object { $_ -match "engine" } | Select-Object -First 3)
      Write-Host "[tour] slow launch, first engine lines: $($engineMs -join ' / ')"
      $walk = Walk-OnboardingToOutro $session -SkipEach
      Invoke-TypeStop $session "slow-engine" "First run under load from a cold copy: Ctrl+T about 400 ms after Get Started, then Enter" "With CPU and disk hogs running and the app copied to a fresh folder (first window $($session.FirstWindowMs) ms after start), skipped to the last onboarding screen ($($walk.Screens)), clicked Get Started, pressed Ctrl+T about 400 ms after the click (the click waits 300 ms after the mouse button comes up, then 100 ms more) and typed example.com from 100 ms after it, 30 ms a key, then pressed Enter." { param($stop) $clicked = Click-Named $session "Get Started"; $stop.Facts.Add("Get Started clicked: $clicked"); Start-Sleep -Milliseconds 100 } "ctrl+t" "Enter" "#2101, #2059" -Required -JudgeWholeText | Out-Null
    }
  } finally {
    $hogs | Stop-Job -ErrorAction SilentlyContinue
    $hogs | Remove-Job -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Out "hog")
  }

  $suggestLog = Join-Path $Out "suggest-server.log"
  $suggestServer = Start-SuggestServer $suggestLog
  try {
  Invoke-FirstRunLaunch "human-go" "" {
    param($session)
    $walk = Walk-OnboardingToOutro $session
    Invoke-TypeStop $session "human-go" "First run: Ctrl+T about 400 ms after Get Started, the first key 100 ms after it, the mouse resting on the bar, then the Go button" "Walked the onboarding with its Continue buttons to the last screen ($($walk.Screens); at the last screen: $($walk.AtOutro)), clicked Get Started, pressed Ctrl+T about 400 ms after the click, typed e 100 ms after it, moved the mouse onto Go (rows then grow above it, so the pointer stays over the bar), typed xample.com 30 ms a key, noted where Go was when the field settled, waited 3 s while the late suggestions came in and clicked there. The profile's default search engine is a custom one whose suggest URL is the tour's own loopback server: it answers every request at once with no rows, except example.com, which it answers with three rows only once the stop has noted Go's position and taken its log mark, then $($script:LateMs) ms later, so the late rows always come after the mouse rests and the measurement starts. Required: the first key lands, the bar held the late rows under the pointer, Go stayed put and Go opened Example Domain (#2102)." { param($stop) $clicked = Click-Named $session "Get Started"; $stop.Facts.Add("Get Started clicked: $clicked"); Start-Sleep -Milliseconds 100 } "ctrl+t" "Go" "the whole text: #2101" -Required -RequireGoHold | Out-Null
  } -OwnSuggestions
  } finally {
    $suggestServer | Stop-Job -ErrorAction SilentlyContinue
    $suggestServer | Remove-Job -Force -ErrorAction SilentlyContinue
  }

  Invoke-FirstRunLaunch "faster-than-a-person" "" {
    param($session)
    $walk = Walk-OnboardingToOutro $session -SkipEach
    Invoke-TypeStop $session "faster-than-a-person" "First run: Ctrl+T with the first key 15 ms after it (#2099)" "Skipped every onboarding step to the last screen ($($walk.Screens)), clicked Get Started, pressed Ctrl+T about 400 ms after the click (the click waits 300 ms after the mouse button comes up, then 100 ms more) and typed example.com from 15 ms after it, 30 ms a key, then pressed Enter. Faster than a person types, so the keys arrive before the new bar has focus; every key has to land (#2099)." { param($stop) $clicked = Click-Named $session "Get Started"; $stop.Facts.Add("Get Started clicked: $clicked"); Start-Sleep -Milliseconds 100 } "ctrl+t" "Enter" "keys typed before the new bar has focus: #2099" -FirstKeyMs 15 -JudgeWholeText -Required | Out-Null
  }

  foreach ($keyMs in 80, 120) {
    foreach ($repeat in 1..10) {
      Invoke-FirstRunLaunch "cadence-$keyMs-$repeat" "" {
        param($session)
        $walk = Walk-OnboardingToOutro $session -SkipEach
        Invoke-TypeStop $session "cadence-$keyMs-$repeat" "First run: Ctrl+T after Get Started, then typing at $keyMs ms a key, try $repeat of 10" "Skipped every onboarding step to the last screen ($($walk.Screens)), clicked Get Started, pressed Ctrl+T about 400 ms after the click (the click waits 300 ms after the mouse button comes up, then 100 ms more) and typed example.com from 100 ms after it, $keyMs ms a key, reading the field after every key, then pressed Enter. A person's pace: no letter after the first may go missing (#2101); the first letter is counted by the first-letter stop after these launches (#2124)." { param($stop) $clicked = Click-Named $session "Get Started"; $stop.Facts.Add("Get Started clicked: $clicked"); Start-Sleep -Milliseconds 100 } "ctrl+t" "Enter" "#2101; the first letter is counted by the first-letter stop (#2124)" -KeyMs $keyMs -ReadEachKey -JudgeLaterLetters -Required | Out-Null
      }
    }
  }
  Invoke-Stop $null "first-letter" "First run: the first letter typed 100 ms after Ctrl+T, at 80 and 120 ms a key, in all $($script:FirstLetters.Count) launches" {
    param($stop)
    $stop.Did = "Counted, over the 80 and 120 ms launches above, whether the first letter typed 100 ms after Ctrl+T reached the new tab's bar."
    $stop.Expected = "the first letter lands in every launch (#2124)."
    $lost = @($script:FirstLetters | Where-Object { -not $_.Kept })
    $inTime = @($script:FirstLetters | Where-Object { $_.FocusFirst })
    $lostInTime = @($lost | Where-Object { $_.FocusFirst })
    $stop.Facts.Add("first letter lost in $($lost.Count) of $($script:FirstLetters.Count); with the bar focused before it: lost in $($lostInTime.Count) of $($inTime.Count)")
    foreach ($try in $lost) { $stop.Facts.Add("stop $($try.Number) $($try.Slug): '$($try.Field)', focus first $($try.FocusFirst), page mounted $($try.Mounts) time(s), first read $($try.FirstRead)") }
    Set-Seen $stop ($lost.Count -eq 0 -and $script:FirstLetters.Count -gt 0)
  } | ForEach-Object { if ($_.Seen -ne "yes") { $script:FailedStops.Add("$($_.Number) the first letter after Ctrl+T (#2124)") } }

}

function Invoke-ContextMenuStop($Session, [string]$Slug, [string]$Title, [string]$Where, [scriptblock]$Point, [switch]$NoArea) {
  Invoke-Stop $Session $Slug $Title {
    param($stop)
    Focus-Window $Session $Session.Main $stop | Out-Null
    Close-Menus $Session
    $target = & $Point
    $stop.Did = "Right-clicked $Where at $($target.X), $($target.Y) ($($target.How))."
    if ($NoArea) {
      $stop.Expected = "one 'context menu area: right press' line and no showMenu, since nothing there has a menu without the engine."
    } else {
      $stop.Expected = "the log lines 'context menu area: right press on ... opening its menu', 'menu showMenu asked' and 'menu pop-up menu shown'."
    }
    $mark = Get-LogCount $Session
    Send-Click $target.X $target.Y -Right
    $shown = Wait-Until $Session { (Get-LinesSince $Session $mark '^menu \d+ pop-up menu (shown|not shown)').Count -gt 0 } 2500
    Start-Sleep -Milliseconds 400
    Save-Shot $stop $Session.Main | Out-Null
    $area = @(Get-LinesSince $Session $mark 'context menu area: right press')
    $asked = @(Get-LinesSince $Session $mark '^menu \d+ showMenu asked')
    $popped = @(Get-LinesSince $Session $mark '^menu \d+ pop-up menu shown')
    if ($NoArea) {
      Set-Seen $stop ($area.Count -gt 0 -and $asked.Count -eq 0)
    } else {
      Set-Seen $stop ($shown -and $area.Count -gt 0 -and $asked.Count -gt 0 -and $popped.Count -gt 0)
    }
    $stop.Facts.Add("area line: $(if ($area.Count) { $area[0] } else { 'none' })")
    $stop.Facts.Add("showMenu asked: $(if ($asked.Count) { $asked[0] } else { 'none' })")
    $stop.Facts.Add("pop-up shown: $(if ($popped.Count) { $popped[0] } else { 'none' })")
    if ($popped.Count) {
      Send-Escape
      $closed = Wait-Until $Session { (Get-LinesSince $Session $mark '^menu \d+ pop-up menu (dismissed|chose|failed)').Count -gt 0 } 2000
      $result = @(Get-LinesSince $Session $mark '^menu \d+ pop-up menu (dismissed|chose|failed)')
      $stop.Facts.Add("after Escape: $(if ($closed -and $result.Count) { $result[0] } else { 'no result line' })")
    }
    Close-Menus $Session
  } | Out-Null
}

function Get-RegionBrightness([int]$Left, [int]$Top, [int]$Width, [int]$Height) {
  if ($Width -le 0 -or $Height -le 0) { return $null }
  try {
    $bitmap = New-Object System.Drawing.Bitmap $Width, $Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($Left, $Top, 0, 0, $bitmap.Size)
      $sum = 0.0
      $count = 0
      for ($y = 0; $y -lt $Height; $y += 2) {
        for ($x = 0; $x -lt $Width; $x += 2) {
          $pixel = $bitmap.GetPixel($x, $y)
          $sum += 0.299 * $pixel.R + 0.587 * $pixel.G + 0.114 * $pixel.B
          $count++
        }
      }
      if ($count -eq 0) { return $null }
      return [Math]::Round($sum / $count, 1)
    } finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  } catch {
    return $null
  }
}

function Get-SidebarTabRows($Session) {
  $client = Get-Client $Session.Main
  if (-not $client) { return @() }
  $sidebarRight = $client.X + [int](190 * $client.Scale)
  $hits = @(Find-Named $Session.Main "New Tab" | Where-Object { $_.X -lt $sidebarRight -and $_.Y -gt $client.Y + [int](12 * $client.Scale) } | Sort-Object Y)
  $rows = @()
  foreach ($hit in $hits) {
    $rows += [pscustomobject]@{
      X = $hit.X
      Y = $hit.Y
      Left = $client.X + [int](20 * $client.Scale)
      Top = $hit.Y - [int](12 * $client.Scale)
      Width = [int](140 * $client.Scale)
      Height = [int](24 * $client.Scale)
    }
  }
  return @($rows)
}

function Invoke-TabClickStop($Session) {
  Invoke-Stop $Session "tab-left-click" "Left click on an unselected sidebar tab" {
    param($stop)
    Focus-Window $Session $Session.Main $stop | Out-Null
    Close-Menus $Session
    $rows = @(Get-SidebarTabRows $Session)
    $stop.Expected = "the clicked row turns into the selected card (brighter) and the row that was selected loses it (darker); no context menu line."
    if ($rows.Count -lt 2) {
      $stop.Did = "Looked for at least two 'New Tab' rows in the sidebar with UI Automation."
      $stop.Seen = "no"
      $stop.Facts.Add("found $($rows.Count) rows")
      return
    }
    $brightness = @($rows | ForEach-Object { Get-RegionBrightness $_.Left $_.Top $_.Width $_.Height })
    $selected = 0
    for ($i = 1; $i -lt $rows.Count; $i++) { if ($brightness[$i] -gt $brightness[$selected]) { $selected = $i } }
    $pick = 0
    if ($selected -eq 0) { $pick = 1 }
    $target = $rows[$pick]
    $stop.Did = "Left-clicked sidebar row $($pick + 1) of $($rows.Count) at $($target.X), $($target.Y); row $($selected + 1) looked selected."
    $mark = Get-LogCount $Session
    Send-Click $target.X $target.Y
    Start-Sleep -Milliseconds 900
    Save-Shot $stop $Session.Main | Out-Null
    $pickAfter = Get-RegionBrightness $target.Left $target.Top $target.Width $target.Height
    $was = $rows[$selected]
    $wasAfter = Get-RegionBrightness $was.Left $was.Top $was.Width $was.Height
    $menuLines = @(Get-LinesSince $Session $mark 'context menu area: right press')
    $stop.Facts.Add("row brightness before: $($brightness -join ', ')")
    $stop.Facts.Add("clicked row $($brightness[$pick]) -> $pickAfter, previously selected row $($brightness[$selected]) -> $wasAfter")
    if ($menuLines.Count) { $stop.Facts.Add("a left click was read as a right press: $($menuLines[0])") }
    $became = $null -ne $pickAfter -and $null -ne $brightness[$pick] -and $pickAfter -gt $brightness[$pick] + 6
    $lost = $null -ne $wasAfter -and $null -ne $brightness[$selected] -and $wasAfter -lt $brightness[$selected] - 6
    Set-Seen $stop ($became -and $lost -and -not $menuLines.Count)
  } | Out-Null
}

function Invoke-ShortcutStop($Session, [string]$Slug, [string]$Title, [string]$Keys, [byte[]]$Modifiers, [byte]$Key, [string]$Command, [string]$Expected, [switch]$WatchBand, [switch]$ClosesOnEscape, [switch]$EscapeCaptured) {
  Invoke-Stop $Session $Slug $Title {
    param($stop)
    $stop.Did = "Pressed $Keys."
    $stop.Expected = $Expected
    Focus-Window $Session $Session.Main $stop | Out-Null
    Close-Menus $Session
    $mark = Get-LogCount $Session
    $before = @(Get-TopWindows $Session)
    Send-Chord $Modifiers $Key
    $commanded = Wait-Command $Session $mark $Command
    Start-Sleep -Milliseconds 900
    $new = @(Get-NewWindows $Session $before)
    Save-Shot $stop $Session.Main | Out-Null
    Set-Seen $stop $commanded
    $stop.Facts.Add("command $Command logged: $commanded")
    if ($new.Count) { $stop.Facts.Add("new windows: $(Format-Windows $new)") }
    if ($WatchBand) { $stop.Facts.Add("title band is now $(Get-TitleBand $Session) (a popover or panel makes it content)") }
    $bandBefore = Get-TitleBand $Session
    $captureOn = (Get-LinesSince $Session $mark '^keys \d+ escape capture on$').Count -gt 0
    if ($EscapeCaptured) { $stop.Facts.Add("native Escape capture turned on: $captureOn") }
    Close-Menus $Session
    $escapeMark = Get-LogCount $Session
    Send-Escape
    Start-Sleep -Milliseconds 500
    foreach ($window in $new) {
      if ([ArdiaTour]::IsWindow($window.Handle) -and $window.ClassName -ne "#32768" -and $window.Width -ge 300) {
        [ArdiaTour]::PostMessageW($window.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
      }
    }
    Start-Sleep -Milliseconds 400
    if ($WatchBand) { $stop.Facts.Add("after Escape the title band is $(Get-TitleBand $Session)") }
    if ($ClosesOnEscape) {
      $bandAfter = Get-TitleBand $Session
      $closed = $bandBefore -eq "content" -and $bandAfter -eq "caption"
      $stop.Facts.Add("closed by Escape (the band went from content back to caption): $closed")
      $seen = $commanded -and $closed
      if ($EscapeCaptured) {
        $sent = (Get-LinesSince $Session $escapeMark '^keys \d+ escape sent to the open popover or drag$').Count -gt 0
        $stop.Facts.Add("native code took the Escape and sent it to the popover: $sent")
        $seen = $seen -and $captureOn -and $sent
      }
      Set-Seen $stop $seen
    }
  } | Out-Null
}

function Find-SettingsWindow($Session) {
  $others = @(Get-BigWindows $Session | Where-Object { $_.Handle -ne $Session.Main })
  $titled = @($others | Where-Object { $_.Title -eq "Settings" })
  if ($titled.Count) { return @($titled[0]) }
  return @($others | Select-Object -First 1)
}

function Read-Appearance($Session) {
  $path = Join-Path $Session.Data "session.json"
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    try {
      if (-not (Test-Path -LiteralPath $path)) { return "auto" }
      $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
      try {
        $document = [System.IO.StreamReader]::new($stream).ReadToEnd() | ConvertFrom-Json
      } finally {
        $stream.Dispose()
      }
      if ($document.settings -and $document.settings.PSObject.Properties.Name -contains "appearance") { return [string]$document.settings.appearance }
      return "auto"
    } catch {
      Start-Sleep -Milliseconds 150
    }
  }
  return "unreadable"
}

function Find-PictureTile([IntPtr]$Window, [string]$Name) {
  $hits = @(Find-Named $Window $Name | Sort-Object -Property Height -Descending)
  if (-not $hits.Count) { return $null }
  $client = Get-Client $Window
  $scale = if ($client) { $client.Scale } else { 1 }
  $tile = $hits[0]
  if ($tile.Height -ge 80 * $scale) {
    return [pscustomobject]@{ X = $tile.X; Y = [int]($tile.Top + $tile.Height * 0.35); How = "the '$Name' tile found by UI Automation ($($tile.Width) by $($tile.Height)), on its picture" }
  }
  return [pscustomobject]@{ X = $tile.X; Y = [int]($tile.Y - 58 * $scale); How = "the picture above the '$Name' label found by UI Automation" }
}

function Invoke-PictureTileStop($Session) {
  Invoke-Stop $Session "settings-picture-tile" "Settings window, Appearance: a click on a picture tile" {
    param($stop)
    $stop.Expected = "a click on the Light tile's picture saves appearance 'light' in session.json, and a click on Automatic's picture saves 'auto' again."
    Focus-Window $Session $script:SettingsWindow $stop | Out-Null
    $before = Read-Appearance $Session
    $stop.Facts.Add("appearance before: $before")
    $results = @()
    foreach ($choice in @(@{ Name = "Light"; Value = "light" }, @{ Name = "Automatic"; Value = "auto" })) {
      $point = Find-PictureTile $script:SettingsWindow $choice.Name
      if (-not $point) {
        $stop.Facts.Add("UI Automation found nothing named '$($choice.Name)'")
        $results += $false
        continue
      }
      Send-Click $point.X $point.Y
      $saved = Wait-Until $Session { (Read-Appearance $Session) -eq $choice.Value } 3000
      $stop.Facts.Add("clicked $($point.How) at $($point.X), $($point.Y): appearance is now $(Read-Appearance $Session)")
      $results += $saved
      Start-Sleep -Milliseconds 600
    }
    $stop.Did = "Clicked the Light tile, then the Automatic tile, in Settings > Appearance."
    Save-Shot $stop $script:SettingsWindow | Out-Null
    $worked = $results.Count -eq 2 -and -not ($results -contains $false)
    if (-not $worked) { Write-Host "::error::a click on a Settings picture tile did not change the setting: $($stop.Facts -join '; ')" }
    Set-Seen $stop $worked
  } | Out-Null
}

function Invoke-SettingsStops($Session, [string]$Suffix, [string]$Label, [switch]$Panes) {
  Invoke-Stop $Session "settings-general$Suffix" "Settings window, General$Label" {
    param($stop)
    $stop.Did = "Pressed Ctrl+, in the browser window."
    $stop.Expected = "a second top-level window of ours, titled Settings."
    Focus-Window $Session $Session.Main $stop | Out-Null
    $mark = Get-LogCount $Session
    Send-Chord @(0x11) 0xBC
    $opened = Wait-Until $Session { @(Find-SettingsWindow $Session).Count -gt 0 } 5000
    $stop.Facts.Add("command openSettings logged: $((Get-LinesSince $Session $mark '^command \d+ openSettings$').Count -gt 0)")
    if ($opened) {
      $found = (Find-SettingsWindow $Session)[0]
      $script:SettingsWindow = $found.Handle
      $stop.Facts.Add("the new window is titled '$($found.Title)'")
      Focus-Window $Session $script:SettingsWindow $stop | Out-Null
      Start-Sleep -Milliseconds 1500
      $frame = Get-Frame $script:SettingsWindow
      $stop.Facts.Add("Settings is $($frame.Width) by $($frame.Height) at $($frame.Left), $($frame.Top)")
      $dark = [ArdiaTour]::DarkModeOf($script:SettingsWindow)
      if ($dark -ge 0) { $stop.Facts.Add("DWM dark title bar: $dark") }
      Save-Shot $stop $script:SettingsWindow | Out-Null
    } else {
      $stop.Facts.Add("windows: $(Format-Windows (Get-TopWindows $Session))")
    }
    Set-Seen $stop $opened
  } | Out-Null
  if (-not $script:SettingsWindow -or -not [ArdiaTour]::IsWindow($script:SettingsWindow)) { return }
  if ($Panes) {
    foreach ($pane in @(@{ Name = "Appearance"; Slug = "settings-appearance"; Row = 4 }, @{ Name = "Keyboard Shortcuts"; Slug = "settings-shortcuts"; Row = 11 })) {
      Invoke-Stop $Session $pane.Slug "Settings window, $($pane.Name)" {
        param($stop)
        $stop.Expected = "the pane changes (more than 5% of the Settings window changes)."
        Focus-Window $Session $script:SettingsWindow $stop | Out-Null
        $client = Get-Client $script:SettingsWindow
        $hits = @(Find-Named $script:SettingsWindow $pane.Name | Where-Object { $client -and $_.X -lt $client.X + [int](214 * $client.Scale) })
        Measure-Screen "" $script:SettingsWindow | Out-Null
        if ($hits.Count) {
          Send-Click $hits[0].X $hits[0].Y
          $stop.Did = "Clicked '$($pane.Name)' in the Settings sidebar, found by UI Automation at $($hits[0].X), $($hits[0].Y)."
        } elseif ($client) {
          $x = $client.X + [int](100 * $client.Scale)
          $y = $client.Y + [int]((52 + 30 * $pane.Row + 15) * $client.Scale)
          Send-Click $x $y
          $stop.Did = "Clicked where '$($pane.Name)' should be in the Settings sidebar ($x, $y, estimated: UI Automation did not find it)."
        } else {
          throw "the Settings window could not be measured"
        }
        Start-Sleep -Milliseconds 1200
        $after = Save-Shot $stop $script:SettingsWindow
        if ($null -ne $after.Changed) { Set-Seen $stop ($after.Changed -gt 5) }
      } | Out-Null
      if ($pane.Slug -eq "settings-appearance") { Invoke-PictureTileStop $Session }
    }
  }
  Invoke-Stop $Session "settings-closed$Suffix" "Settings window closed$Label" {
    param($stop)
    $stop.Did = "Sent WM_CLOSE to the Settings window."
    $stop.Expected = "the Settings window goes away and the app keeps running."
    [ArdiaTour]::PostMessageW($script:SettingsWindow, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    $closed = Wait-Until $Session { -not [ArdiaTour]::IsWindow($script:SettingsWindow) -or -not [ArdiaTour]::IsWindowVisible($script:SettingsWindow) } 4000
    Start-Sleep -Milliseconds 600
    Focus-Window $Session $Session.Main $stop | Out-Null
    Save-Shot $stop $Session.Main | Out-Null
    Set-Seen $stop ($closed -and -not $Session.Process.HasExited)
  } | Out-Null
  $script:SettingsWindow = [IntPtr]::Zero
}

function Invoke-MainTour {
  $session = Start-Ardia "browser" -Onboarded
  Invoke-Stop $session "main-window" "Main window, onboarding done" {
    param($stop)
    $stop.Did = "Launched with onboarding.json marked done and waited for the first window."
    $stop.Expected = "one big window of ours, the first-window log line, the page card at the top of the window with the app's own window buttons in its toolbar, and caption regions marked for Windows."
    if (-not (Test-Usable $session)) { $stop.Seen = "no"; return }
    Focus-Window $session $session.Main $stop -ClickBand | Out-Null
    Start-Sleep -Milliseconds 600
    $shot = Save-Shot $stop $session.Main
    $script:LightBrightness = $shot.Brightness
    $band = Get-TitleBand $session
    Set-Seen $stop ($band -eq "caption")
    $stop.Facts.Add("title band is $band")
    $stop.Facts.Add("windows: $(Format-Windows (Get-TopWindows $session))")
    $stop.Facts.Add("foreground is ours: $(Test-ForegroundIsOurs $session)")
    $stop.Facts.Add("DWM dark title bar: $([ArdiaTour]::DarkModeOf($session.Main))")
  } | Out-Null
  if (-not (Test-Usable $session)) { Stop-Ardia $session; return }

  Invoke-Stop $session "new-tabs" "Three new tabs" {
    param($stop)
    $stop.Did = "Pressed Ctrl+T three times."
    $stop.Expected = "three newTab commands in the log."
    Focus-Window $session $session.Main $stop | Out-Null
    $mark = Get-LogCount $session
    foreach ($i in 1..3) {
      Send-Chord @(0x11) 0x54
      Start-Sleep -Milliseconds 500
    }
    Start-Sleep -Milliseconds 800
    $count = (Get-LinesSince $session $mark '^command \d+ newTab$').Count
    Save-Shot $stop $session.Main | Out-Null
    Set-Seen $stop ($count -eq 3)
    $stop.Facts.Add("$count newTab commands logged")
  } | Out-Null

  Invoke-Stop $session "command-bar" "Command bar with text typed" {
    param($stop)
    $stop.Did = "Pressed Ctrl+L and typed 'ardia'."
    $stop.Expected = "a focusCommandBar command in the log."
    Focus-Window $session $session.Main $stop | Out-Null
    $mark = Get-LogCount $session
    Send-Chord @(0x11) 0x4C
    $commanded = Wait-Command $session $mark "focusCommandBar"
    Start-Sleep -Milliseconds 500
    Send-Text "ardia"
    Start-Sleep -Milliseconds 700
    Save-Shot $stop $session.Main | Out-Null
    Set-Seen $stop $commanded
    $stop.Facts.Add("command focusCommandBar logged: $commanded")
    $stop.Facts.Add("title band is $(Get-TitleBand $session) (an open command panel makes it content)")
    Send-Escape
    Send-Escape
    Start-Sleep -Milliseconds 500
    $stop.Facts.Add("after Escape the title band is $(Get-TitleBand $session)")
  } | Out-Null

  Invoke-ContextMenuStop $session "menu-sidebar-tab" "Context menu on a sidebar tab" "a tab in the sidebar" {
    $client = Get-Client $session.Main
    $sidebarRight = $client.X + [int](190 * $client.Scale)
    $hits = @(Find-Named $session.Main "New Tab" | Where-Object { $_.X -lt $sidebarRight -and $_.Y -gt $client.Y + [int](12 * $client.Scale) } | Sort-Object Y)
    if ($hits.Count) {
      $pick = $hits[[int][Math]::Floor($hits.Count / 2)]
      return [pscustomobject]@{ X = $pick.X; Y = $pick.Y; How = "the middle of $($hits.Count) 'New Tab' labels UI Automation found in the sidebar" }
    }
    return [pscustomobject]@{ X = $client.X + [int](95 * $client.Scale); Y = $client.Y + [int]($client.Height * 0.3); How = "estimated: UI Automation found no 'New Tab' label in the sidebar" }
  }

  Invoke-ContextMenuStop $session "menu-page" "Context menu on the page area" "the middle of the page area" {
    $client = Get-Client $session.Main
    $sidebar = [int](190 * $client.Scale)
    return [pscustomobject]@{ X = $client.X + $sidebar + [int](($client.Width - $sidebar) / 2); Y = $client.Y + [int]($client.Height * 0.68); How = "position" }
  } -NoArea

  Invoke-TabClickStop $session

  Invoke-Stop $session "sidebar-hidden" "Sidebar hidden" {
    param($stop)
    $stop.Did = "Pressed Ctrl+S (Auto-Hide Tabs)."
    $stop.Expected = "the log says the sidebar edge watch turned on, which happens when the sidebar hides."
    Focus-Window $session $session.Main $stop | Out-Null
    $mark = Get-LogCount $session
    Send-Chord @(0x11) 0x53
    $hidden = Wait-Until $session { (Get-LinesSince $session $mark '^window \d+ sidebar edge watch on').Count -gt 0 } 3000
    Start-Sleep -Milliseconds 900
    Save-Shot $stop $session.Main | Out-Null
    Set-Seen $stop $hidden
    $stop.Facts.Add("command toggleSidebar logged: $((Get-LinesSince $session $mark '^command \d+ toggleSidebar$').Count -gt 0)")
  } | Out-Null

  Invoke-Stop $session "sidebar-shown" "Sidebar shown again" {
    param($stop)
    $stop.Did = "Pressed Ctrl+S again."
    $stop.Expected = "the log says the sidebar edge watch turned off."
    Focus-Window $session $session.Main $stop | Out-Null
    $mark = Get-LogCount $session
    Send-Chord @(0x11) 0x53
    $shown = Wait-Until $session { (Get-LinesSince $session $mark '^window \d+ sidebar edge watch off').Count -gt 0 } 3000
    Start-Sleep -Milliseconds 900
    Save-Shot $stop $session.Main | Out-Null
    Set-Seen $stop $shown
  } | Out-Null

  Invoke-ShortcutStop $session "downloads" "Downloads popover" "Ctrl+J" @(0x11) 0x4A "downloads" "a downloads command in the log, the title band turning to content while the popover is open, native code taking Escape for it, and the popover closing on Escape so the band is a caption again." -WatchBand -ClosesOnEscape -EscapeCaptured
  Invoke-ShortcutStop $session "search-tabs" "Search tabs" "Ctrl+Shift+A" @(0x11, 0x10) 0x41 "searchTabs" "a searchTabs command in the log." -WatchBand
  Invoke-ShortcutStop $session "profile-menu" "Profiles menu" "Ctrl+Shift+M" @(0x11, 0x10) 0x4D "openProfileMenu" "an openProfileMenu command in the log."
  Invoke-ShortcutStop $session "task-manager" "Task manager" "Shift+Escape" @(0x10) 0x1B "taskManager" "a taskManager command in the log."

  Invoke-Stop $session "app-menu" "The menu button beside minimize" {
    param($stop)
    $stop.Expected = "a button named Menu at the window's top right; a click opens a menu that lists Settings and Check for Updates (the log lines 'menu showMenu asked' and 'menu pop-up menu shown')."
    Focus-Window $session $session.Main $stop | Out-Null
    Close-Menus $session
    $client = Get-Client $session.Main
    $hits = @(Find-Named $session.Main "Menu" | Where-Object { $client -and $_.X -gt $client.X + $client.Width - [int](200 * $client.Scale) -and $_.Y -lt $client.Y + [int](60 * $client.Scale) })
    if (-not $hits.Count) {
      $stop.Did = "Looked for a button named Menu at the top right with UI Automation and found none."
      Save-Shot $stop $session.Main | Out-Null
      Set-Seen $stop $false
      return
    }
    $stop.Did = "Clicked the Menu button, found by UI Automation at $($hits[0].X), $($hits[0].Y)."
    $mark = Get-LogCount $session
    Send-Click $hits[0].X $hits[0].Y
    $shown = Wait-Until $session { (Get-LinesSince $session $mark '^menu \d+ pop-up menu (shown|not shown)').Count -gt 0 } 2500
    Start-Sleep -Milliseconds 400
    Save-Shot $stop $session.Main | Out-Null
    $asked = @(Get-LinesSince $session $mark '^menu \d+ showMenu asked')
    $popped = @(Get-LinesSince $session $mark '^menu \d+ pop-up menu shown')
    $stop.Facts.Add("showMenu asked: $(if ($asked.Count) { $asked[0] } else { 'none' })")
    $stop.Facts.Add("pop-up shown: $(if ($popped.Count) { $popped[0] } else { 'none' })")
    Set-Seen $stop ($shown -and $asked.Count -gt 0 -and $popped.Count -gt 0)
    if ($popped.Count) {
      Send-Escape
      Wait-Until $session { (Get-LinesSince $session $mark '^menu \d+ pop-up menu (dismissed|chose|failed)').Count -gt 0 } 2000 | Out-Null
    }
  }

  Invoke-SettingsStops $session "" "" -Panes

  Invoke-Stop $session "little-ardia" "Little Ardia window" {
    param($stop)
    $stop.Did = "Pressed Ctrl+Alt+N."
    $stop.Expected = "a newLittleArdia command, a new top-level window of ours, and its command panel drawn whole below the bar's field rather than cut off 24 points down, with the window buttons on the bare bar."
    Focus-Window $session $session.Main $stop | Out-Null
    $mark = Get-LogCount $session
    $before = @(Get-BigWindows $session)
    Send-Chord @(0x11, 0x12) 0x4E
    $commanded = Wait-Command $session $mark "newLittleArdia"
    $opened = Wait-Until $session { @(Get-NewWindows $session $before | Where-Object { $_.ClassName -ne "#32768" -and $_.Width -ge 300 }).Count -gt 0 } 5000
    Start-Sleep -Milliseconds 1500
    $new = @(Get-NewWindows $session $before | Where-Object { $_.ClassName -ne "#32768" -and $_.Width -ge 300 })
    $target = $session.Main
    if ($new.Count) { $target = $new[0].Handle }
    Save-Shot $stop $target | Out-Null
    Set-Seen $stop $opened
    $stop.Facts.Add("command newLittleArdia logged: $commanded")
    $stop.Facts.Add("new windows: $(Format-Windows $new)")
    $client = $null
    if ($new.Count) { $client = Get-Client $target }
    if ($client) {
      $scale = $client.Scale
      $panel = Get-RegionBrightness ($client.X + [int](400 * $scale)) ($client.Y + [int](25 * $scale)) ([int](240 * $scale)) ([int](10 * $scale))
      $caption = Get-RegionBrightness ($client.X + $client.Width - [int](128 * $scale)) ($client.Y + [int](4 * $scale)) ([int](118 * $scale)) ([int](24 * $scale))
      $whole = $null -ne $panel -and $panel -ge 240
      $bare = $null -ne $caption -and $caption -lt 240
      $stop.Facts.Add("command panel brightness at 400 to 640 by 25 to 35 points: $panel (240 or more is the panel; the bare band is darker)")
      $stop.Facts.Add("caption buttons' area brightness: $caption (under 240 is the bare band)")
      Set-Seen $stop ($opened -and $whole -and $bare)
    }
    foreach ($window in $new) { [ArdiaTour]::PostMessageW($window.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
    Start-Sleep -Milliseconds 800
  } | Out-Null

  $restoreFrame = $null
  if (Test-Usable $session) { $restoreFrame = Get-Frame $session.Main }

  Invoke-Stop $session "maximized" "Main window maximized" {
    param($stop)
    $stop.Did = "Maximized the main window with ShowWindow."
    $stop.Expected = "the window reports maximized."
    Focus-Window $session $session.Main $stop | Out-Null
    [ArdiaTour]::ShowWindow($session.Main, 3) | Out-Null
    $zoomed = Wait-Until $session { [ArdiaTour]::IsZoomed($session.Main) } 2000
    Start-Sleep -Milliseconds 1200
    Save-Shot $stop $session.Main | Out-Null
    Set-Seen $stop $zoomed
    $frame = Get-Frame $session.Main
    $stop.Facts.Add("frame $($frame.Width) by $($frame.Height) at $($frame.Left), $($frame.Top)")
    [ArdiaTour]::ShowWindow($session.Main, 9) | Out-Null
    Start-Sleep -Milliseconds 800
  } | Out-Null

  Invoke-Stop $session "small" "Main window at a small size" {
    param($stop)
    $client = Get-Client $session.Main
    $scale = 1.0
    if ($client) { $scale = $client.Scale }
    $width = [int](640 * $scale)
    $height = [int](460 * $scale)
    $stop.Did = "Resized the main window to $width by $height with SetWindowPos."
    $stop.Expected = "the window frame is that size (within 8 px)."
    [ArdiaTour]::SetWindowPos($session.Main, [IntPtr]::Zero, 40, 40, $width, $height, 0x0014) | Out-Null
    Start-Sleep -Milliseconds 1500
    $frame = Get-Frame $session.Main
    Save-Shot $stop $session.Main | Out-Null
    Set-Seen $stop ($frame -and [Math]::Abs($frame.Width - $width) -le 8 -and [Math]::Abs($frame.Height - $height) -le 8)
    $stop.Facts.Add("frame $($frame.Width) by $($frame.Height)")
    if ($restoreFrame) { [ArdiaTour]::SetWindowPos($session.Main, [IntPtr]::Zero, $restoreFrame.Left, $restoreFrame.Top, $restoreFrame.Width, $restoreFrame.Height, 0x0014) | Out-Null }
    Start-Sleep -Milliseconds 500
  } | Out-Null

  Stop-Ardia $session
}

function Wait-Title($Session, [string]$Pattern, [int]$Milliseconds = 25000) {
  return Wait-Until $Session { [ArdiaTour]::TitleOf($Session.Main) -match $Pattern } $Milliseconds
}

function Open-Page($Session, $Stop, [string]$Address, [string]$TitlePattern) {
  Focus-Window $Session $Session.Main $Stop | Out-Null
  $mark = Get-LogCount $Session
  Send-Chord @(0x11) 0x54
  $opened = Wait-Command $Session $mark "newTab"
  Start-Sleep -Milliseconds 700
  Send-Text $Address
  Start-Sleep -Milliseconds 500
  Send-Key 0x0D 0
  Send-Key 0x0D 2
  $loaded = Wait-Title $Session $TitlePattern
  Start-Sleep -Milliseconds 3500
  $Stop.Facts.Add("newTab command logged: $opened")
  $Stop.Facts.Add("window title: '$([ArdiaTour]::TitleOf($Session.Main))'")
  return $loaded
}

function Invoke-PagesTour {
  $session = Start-Ardia "pages" -Onboarded
  Invoke-Stop $session "page-loads" "A page loads in a tab" {
    param($stop)
    $stop.Did = "Pressed Ctrl+T, typed example.com and pressed Enter."
    $stop.Expected = "the window's title names the page's site, and the page shows in the card."
    if (-not (Test-Usable $session)) { $stop.Seen = "no"; return }
    $loaded = Open-Page $session $stop "example.com" "example\.com"
    Save-Shot $stop $session.Main | Out-Null
    Set-Seen $stop $loaded
    $stop.Facts.Add("windows: $(Format-Windows (Get-TopWindows $session))")
  } | Out-Null
  if (-not (Test-Usable $session)) { Stop-Ardia $session; return }

  Invoke-Stop $session "page-find" "Find in the page" {
    param($stop)
    $stop.Did = "Pressed Ctrl+F with the page showing and typed 'domain'."
    $stop.Expected = "a findInPage command in the log, and the find bar over the page."
    $mark = Get-LogCount $session
    Send-Chord @(0x11) 0x46
    $commanded = Wait-Command $session $mark "findInPage"
    Start-Sleep -Milliseconds 600
    Send-Text "domain"
    Start-Sleep -Milliseconds 1200
    Save-Shot $stop $session.Main | Out-Null
    Set-Seen $stop $commanded
    $stop.Facts.Add("command findInPage logged: $commanded")
    Send-Escape
    Start-Sleep -Milliseconds 500
  } | Out-Null

  Invoke-Stop $session "page-command-bar" "The command bar over a page" {
    param($stop)
    $stop.Did = "Pressed Ctrl+L with the page showing."
    $stop.Expected = "a focusCommandBar command in the log, and the command bar drawn over the page."
    $mark = Get-LogCount $session
    Send-Chord @(0x11) 0x4C
    $commanded = Wait-Command $session $mark "focusCommandBar"
    Start-Sleep -Milliseconds 1200
    Save-Shot $stop $session.Main | Out-Null
    Set-Seen $stop $commanded
    $stop.Facts.Add("command focusCommandBar logged: $commanded")
    Send-Escape
    Send-Escape
    Start-Sleep -Milliseconds 500
  } | Out-Null

  Invoke-Stop $session "page-second-tab" "A second page in a second tab" {
    param($stop)
    $stop.Did = "Pressed Ctrl+T, typed developer.mozilla.org and pressed Enter."
    $stop.Expected = "the window's title names the second page's site."
    $loaded = Open-Page $session $stop "developer.mozilla.org" "developer\.mozilla\.org"
    Save-Shot $stop $session.Main | Out-Null
    Set-Seen $stop $loaded
  } | Out-Null

  Invoke-Stop $session "page-back-to-first" "Back to the first tab" {
    param($stop)
    $stop.Did = "Pressed Ctrl+Shift+Tab to go up to the tab above this one."
    $stop.Expected = "the window's title names the first page's site again."
    Send-Chord @(0x11, 0x10) 0x09
    $back = Wait-Title $session "example\.com" 8000
    Start-Sleep -Milliseconds 800
    Save-Shot $stop $session.Main | Out-Null
    Set-Seen $stop $back
    $stop.Facts.Add("window title: '$([ArdiaTour]::TitleOf($session.Main))'")
  } | Out-Null

  Invoke-Stop $session "page-history" "History lists the pages" {
    param($stop)
    $stop.Did = "Pressed Ctrl+H."
    $stop.Expected = "the window's title names History, and the page lists the two sites."
    Focus-Window $session $session.Main $stop | Out-Null
    Send-Chord @(0x11) 0x48
    $shown = Wait-Title $session "History" 8000
    Start-Sleep -Milliseconds 1500
    Save-Shot $stop $session.Main | Out-Null
    Set-Seen $stop $shown
    $stop.Facts.Add("window title: '$([ArdiaTour]::TitleOf($session.Main))'")
  } | Out-Null

  Invoke-Stop $session "page-link-from-outside" "A link from another launch" {
    param($stop)
    $stop.Did = "Started Ardia again with https://example.org/ while it was running."
    $stop.Expected = "the running app opens the link in a window of ours whose title names the site, and no second app stays."
    $before = @(Get-TopWindows $session)
    $second = Start-Process -FilePath $App -ArgumentList "https://example.org/" -PassThru
    $ours = { @(Get-NewWindows $session $before | Where-Object { $_.ClassName -notmatch "^(#32768|Chrome_)" -and $_.Width -ge 300 -and $_.Height -ge 200 }) }
    $opened = Wait-Until $session { (& $ours).Count -gt 0 -and [ArdiaTour]::TitleOf((& $ours)[0].Handle) -match "example\.org" } 25000
    $handed = $second.WaitForExit(10000)
    Start-Sleep -Milliseconds 3000
    $shown = @(& $ours)
    if ($shown.Count) {
      Save-Shot $stop $shown[0].Handle | Out-Null
      $stop.Facts.Add("the new window is titled '$([ArdiaTour]::TitleOf($shown[0].Handle))'")
    } else {
      $stop.Facts.Add("windows: $(Format-Windows (Get-TopWindows $session))")
    }
    $stop.Facts.Add("the second launch exited by itself: $handed")
    Set-Seen $stop ($opened -and $handed)
    foreach ($window in $shown) { [ArdiaTour]::PostMessageW($window.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
    Start-Sleep -Milliseconds 800
  } | Out-Null

  Invoke-Stop $session "page-private" "A page in a private window" {
    param($stop)
    $stop.Did = "Pressed Ctrl+Shift+N, typed example.com in the new window and pressed Enter."
    $stop.Expected = "a second window of ours, dark, whose title names the page's site."
    Focus-Window $session $session.Main $stop | Out-Null
    $before = @(Get-TopWindows $session)
    Send-Chord @(0x11, 0x10) 0x4E
    $ours = { @(Get-NewWindows $session $before | Where-Object { $_.ClassName -notmatch "^(#32768|Chrome_)" -and $_.Width -ge 300 -and $_.Height -ge 200 }) }
    $opened = Wait-Until $session { (& $ours).Count -gt 0 } 8000
    if (-not $opened) {
      $stop.Facts.Add("windows: $(Format-Windows (Get-TopWindows $session))")
      Set-Seen $stop $false
      return
    }
    $private = (& $ours)[0].Handle
    Focus-Window $session $private $stop | Out-Null
    Start-Sleep -Milliseconds 1200
    Send-Text "example.com"
    Start-Sleep -Milliseconds 500
    Send-Key 0x0D 0
    Send-Key 0x0D 2
    $loaded = Wait-Until $session { [ArdiaTour]::TitleOf($private) -match "example\.com" } 25000
    Start-Sleep -Milliseconds 3500
    Save-Shot $stop $private | Out-Null
    Set-Seen $stop $loaded
    $stop.Facts.Add("the new window is titled '$([ArdiaTour]::TitleOf($private))'")
  } | Out-Null
  Stop-Ardia $session
}

$script:TourPagesPort = 9363
$script:TourPages = $null

function Start-TourPages {
  if ($script:TourPages -and -not $script:TourPages.HasExited) { return $true }
  $folder = Join-Path $Out "pages"
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  $serve = Join-Path $folder "serve.ps1"
  Set-Content -LiteralPath $serve -Encoding utf8NoBOM -Value @'
param([int]$Port)
$pages = @{
  "/links" = "<!doctype html><meta charset=utf-8><title>tour links</title><style>body{margin:0;background:#fff}a{position:absolute;left:20px;top:20px;width:320px;height:60px;display:block;background:#cde;font:20px sans-serif}</style><a href='/peeked'>peek this</a>"
  "/peeked" = "<!doctype html><meta charset=utf-8><title>tour peeked</title><style>html,body{margin:0;height:100%;background:#2a7}</style>"
  "/taba" = "<!doctype html><meta charset=utf-8><title>tour tab a</title><style>html,body{margin:0;height:100%;background:#3366cc}a{position:absolute;left:20px;top:20px;width:320px;height:60px;display:block;background:#cde;font:20px sans-serif}</style><a href='/typed'>peek this</a><script>let keys='';addEventListener('keydown',e=>{if(e.key.length===1){keys+=e.key;document.title='a got '+keys}});</script>"
  "/tabb" = "<!doctype html><meta charset=utf-8><title>tour tab b</title><style>html,body{margin:0;height:100%;background:#c0392b}</style>"
  "/typed" = "<!doctype html><meta charset=utf-8><title>tour typed</title><style>html,body{margin:0;height:100%;background:#2a7}</style><script>let keys='';addEventListener('keydown',e=>{if(e.key.length===1){keys+=e.key;document.title='peek got '+keys}});</script>"
}
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $client.ReceiveTimeout = 2000
    $stream = $client.GetStream()
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
    $request = $reader.ReadLine()
    while ($line = $reader.ReadLine()) { }
    $path = if ($request) { ($request.Split(" ")[1]) -replace '\?.*$', '' } else { "" }
    $text = $pages[$path]
    $status = if ($text) { "200 OK" } else { "404 Not Found" }
    $body = [System.Text.Encoding]::UTF8.GetBytes([string]$text)
    $head = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $status`r`nContent-Type: text/html; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n")
    $stream.Write($head, 0, $head.Length)
    $stream.Write($body, 0, $body.Length)
    $stream.Flush()
  } catch { } finally { $client.Close() }
}
'@
  $script:TourPages = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList "-NoProfile", "-NonInteractive", "-File", "`"$serve`"", "-Port", $script:TourPagesPort -WindowStyle Hidden -PassThru
  $by = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $by -and -not $script:TourPages.HasExited) {
    $probe = New-Object System.Net.Sockets.TcpClient
    try { if ($probe.ConnectAsync("127.0.0.1", $script:TourPagesPort).Wait(1000) -and $probe.Connected) { return $true } } catch { } finally { $probe.Dispose() }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function Stop-TourPages {
  if ($script:TourPages -and -not $script:TourPages.HasExited) { Stop-Process -Id $script:TourPages.Id -Force -ErrorAction SilentlyContinue }
  $script:TourPages = $null
}

function Send-Address([string]$Address) {
  foreach ($character in $Address.ToUpperInvariant().ToCharArray()) {
    $shifted = $false
    $key = [byte][char]$character
    if ($character -eq '.') { $key = 0xBE }
    elseif ($character -eq '/') { $key = 0xBF }
    elseif ($character -eq ':') { $key = 0xBA; $shifted = $true }
    if ($shifted) { Send-Key 0x10 0 }
    Send-Key $key 0
    Send-Key $key 2
    if ($shifted) { Send-Key 0x10 2 }
    Start-Sleep -Milliseconds 60
  }
  Start-Sleep -Milliseconds 300
}

if (-not ([System.Management.Automation.PSTypeName]"ArdiaTourScale").Type) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ArdiaTourScale {
  [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")] public static extern bool Get(uint action, uint parameter, ref int value, uint change);
  [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")] public static extern bool Set(uint action, int parameter, IntPtr value, uint change);
}
"@
}

function Get-ScaleStep {
  $value = 0
  [ArdiaTourScale]::Get(0x9E, 0, [ref]$value, 0) | Out-Null
  return $value
}

function Set-ScaleStep([int]$Step) {
  $set = [ArdiaTourScale]::Set(0x9F, $Step, [IntPtr]::Zero, 3)
  Start-Sleep -Milliseconds 2500
  return $set
}

function Get-PageWindow($Session, [string]$TitlePattern) {
  return @(Get-TopWindows $Session | Where-Object { $_.ClassName -match "^Chrome_" -and $_.Title -match $TitlePattern -and $_.Width -ge 100 -and $_.Height -ge 100 -and $_.Left -gt -5000 -and $_.Top -gt -5000 }) | Select-Object -First 1
}

function Measure-Colour([string]$Path, $Box, [int[]]$Colour) {
  if (-not (Test-Path -LiteralPath $Path) -or -not $Box) { return $null }
  $bitmap = [System.Drawing.Bitmap]::FromFile($Path)
  try {
    $left = [Math]::Max(0, $Box.Left + 4)
    $top = [Math]::Max(0, $Box.Top + 4)
    $right = [Math]::Min($bitmap.Width - 1, $Box.Left + $Box.Width - 5)
    $bottom = [Math]::Min($bitmap.Height - 1, $Box.Top + $Box.Height - 5)
    $total = 0
    $other = 0
    for ($y = $top; $y -le $bottom; $y += 4) {
      for ($x = $left; $x -le $right; $x += 4) {
        $pixel = $bitmap.GetPixel($x, $y)
        $total++
        if ([Math]::Abs($pixel.R - $Colour[0]) + [Math]::Abs($pixel.G - $Colour[1]) + [Math]::Abs($pixel.B - $Colour[2]) -gt 40) { $other++ }
      }
    }
    if (-not $total) { return $null }
    return [Math]::Round(100.0 * $other / $total, 1)
  } finally {
    $bitmap.Dispose()
  }
}

function Get-Box($Window) {
  if (-not $Window) { return $null }
  return [pscustomobject]@{ Left = $Window.Left; Top = $Window.Top; Width = $Window.Width; Height = $Window.Height }
}

function Get-Overlap($A, $B) {
  if (-not $A -or -not $B) { return $null }
  $left = [Math]::Max($A.Left, $B.Left)
  $top = [Math]::Max($A.Top, $B.Top)
  $right = [Math]::Min($A.Left + $A.Width, $B.Left + $B.Width)
  $bottom = [Math]::Min($A.Top + $A.Height, $B.Top + $B.Height)
  if ($right -le $left -or $bottom -le $top) { return $null }
  return [pscustomobject]@{ Left = $left; Top = $top; Width = $right - $left; Height = $bottom - $top }
}

function Open-TourPage($Session, $Stop, [string]$Path, [string]$TitlePattern) {
  Focus-Window $Session $Session.Main $Stop | Out-Null
  $mark = Get-LogCount $Session
  Send-Chord @(0x11) 0x54
  $opened = Wait-Command $Session $mark "newTab"
  Start-Sleep -Milliseconds 700
  Send-Address "127.0.0.1:$($script:TourPagesPort)$Path"
  Send-Key 0x0D 0
  Send-Key 0x0D 2
  $loaded = Wait-Until $Session { $null -ne (Get-PageWindow $Session $TitlePattern) } 20000
  Start-Sleep -Milliseconds 2000
  $Stop.Facts.Add("opened $Path in a new tab (newTab logged: $opened, its page window shows: $loaded)")
  return $loaded
}

function Switch-Tab($Session, $Stop, [string]$TitlePattern, [string]$Leaving, [string]$Row) {
  Send-Chord @(0x11) 0x09
  $shown = { $null -ne (Get-PageWindow $Session $TitlePattern) -and $null -eq (Get-PageWindow $Session $Leaving) }
  $switched = Wait-Until $Session $shown 6000
  $how = "Ctrl+Tab"
  if (-not $switched) {
    $rows = @(Find-Named $Session.Main $Row)
    if ($rows.Count) {
      Send-Click $rows[0].X $rows[0].Y
      $switched = Wait-Until $Session $shown 6000
      $how = "Ctrl+Tab, then a click on the tab's row"
    }
  }
  Start-Sleep -Milliseconds 1500
  $pages = @(Get-TopWindows $Session | Where-Object { $_.ClassName -match '^Chrome_' -and $_.Width -ge 100 } | ForEach-Object { "'$($_.Title)'" }) -join ", "
  $Stop.Facts.Add("switched by $how (switched: $switched); page windows shown: $pages")
  return $switched
}

function Note-Required($Stop, [string]$Part) {
  if ($Required -contains $Part -and $Stop.Seen -ne "yes") {
    $script:RequiredFailures.Add("$($Stop.Number) $($Stop.Slug): $($Stop.Seen)")
  }
}

$script:RequiredFailures = [System.Collections.Generic.List[string]]::new()

function Invoke-PeekTabsTour {
  if (-not (Start-TourPages)) {
    $script:Lines.Add("- The peek-tabs part found no loopback page server on port $($script:TourPagesPort).")
    if ($Required -contains "peek-tabs") { $script:RequiredFailures.Add("peek-tabs: no page server") }
    return
  }
  $blue = @(0x33, 0x66, 0xcc)
  $red = @(0xc0, 0x39, 0x2b)
  $session = Start-Ardia "peek-tabs" -Onboarded -Settings @{ appearance = "light" }
  $state = [pscustomobject]@{ Card = $null; PageB = $null; PageA = $null }

  $stop = Invoke-Stop $session "peek-tabs-open" "A Peek on tab A takes the keyboard" {
    param($stop)
    $stop.Did = "Opened a solid red page as tab B and a blue page with a link as tab A, Shift-clicked the link, then typed 'abc'."
    $stop.Expected = "a Peek over tab A, and the letters reach the Peek's page, whose title then reads 'peek got abc'."
    if (-not (Test-Usable $session)) { $stop.Seen = "no"; return }
    $b = Open-TourPage $session $stop "/tabb" "tour tab b"
    $a = Open-TourPage $session $stop "/taba" "tour tab a"
    $page = Get-PageWindow $session "tour tab a"
    $client = Get-Client $session.Main
    if (-not ($a -and $b -and $page -and $client)) {
      $stop.Facts.Add("windows: $(Format-Windows (Get-TopWindows $session))")
      Set-Seen $stop $false
      return
    }
    $state.PageA = Get-Box $page
    Send-Key 0x10 0
    Start-Sleep -Milliseconds 80
    Send-Click ($page.Left + [int](180 * $client.Scale)) ($page.Top + [int](50 * $client.Scale))
    Send-Key 0x10 2
    $peeked = Wait-Until $session { $null -ne (Get-PageWindow $session "tour typed|peek got") } 15000
    Start-Sleep -Milliseconds 2000
    $card = Get-PageWindow $session "tour typed|peek got"
    $state.Card = Get-Box $card
    if ($state.Card) {
      $bar = [int](44 * $client.Scale)
      $state.Card = [pscustomobject]@{ Left = $state.Card.Left - 8; Top = $state.Card.Top - $bar; Width = $state.Card.Width + 16; Height = $state.Card.Height + $bar + 8 }
      $stop.Facts.Add("the Peek card spans $($state.Card.Width) by $($state.Card.Height) at $($state.Card.Left), $($state.Card.Top)")
    }
    Send-Text "abc"
    $typed = Wait-Until $session { $null -ne (Get-PageWindow $session "peek got abc") } 5000
    Save-Shot $stop $session.Main | Out-Null
    $stop.Facts.Add("the Peek opened: $peeked; the Peek's page got 'abc': $typed; the Peek's page is titled '$((Get-PageWindow $session 'tour typed|peek got').Title)'; tab A's page is titled '$((Get-PageWindow $session 'tour tab a|a got').Title)'")
    Set-Seen $stop ($peeked -and $typed)
  }
  Note-Required $stop "peek-tabs"

  $stop = Invoke-Stop $session "peek-tabs-other-tab" "Tab B shows whole while tab A keeps its Peek" {
    param($stop)
    $stop.Did = "Switched to tab B with real input and shot the window."
    $stop.Expected = "tab B's solid red page is whole where the Peek card was: no card-shaped hole, under 2% of its pixels there are not red."
    if (-not $state.Card) { $stop.Facts.Add("no Peek card to compare with"); Set-Seen $stop $false; return }
    $switched = Switch-Tab $session $stop "tour tab b" "tour tab a|a got" "tour tab b"
    Save-Shot $stop $session.Main | Out-Null
    $pageB = Get-PageWindow $session "tour tab b"
    $state.PageB = Get-Box $pageB
    $where = Get-Overlap $state.Card $state.PageB
    $notRed = Measure-Colour $stop.Shot $where $red
    $whole = Measure-Colour $stop.Shot $state.PageB $red
    $stop.Facts.Add("where the card was, $notRed% of tab B's page is not red; over the whole page $whole%")
    $stop.Facts.Add("Peek page windows still shown: $(@(Get-TopWindows $session | Where-Object { $_.ClassName -match '^Chrome_' -and $_.Title -match 'tour typed|peek got' }).Count)")
    Set-Seen $stop ($switched -and $null -ne $notRed -and $notRed -lt 2)
  }
  Note-Required $stop "peek-tabs"

  $stop = Invoke-Stop $session "peek-tabs-back" "Back on tab A the Peek shows and takes the keyboard again" {
    param($stop)
    $stop.Did = "Switched back to tab A with real input, shot the window, then typed 'def'."
    $stop.Expected = "the Peek shows again, and the letters reach its page, whose title then reads 'peek got abcdef'."
    $switched = Switch-Tab $session $stop "tour tab a|a got" "tour tab b" "tour tab a"
    Start-Sleep -Milliseconds 800
    $shown = $null -ne (Get-PageWindow $session "tour typed|peek got")
    Save-Shot $stop $session.Main | Out-Null
    Send-Text "def"
    $typed = Wait-Until $session { $null -ne (Get-PageWindow $session "peek got abcdef") } 5000
    $stop.Facts.Add("the Peek's page window shows: $shown; it got 'def': $typed; the Peek's page is titled '$((Get-PageWindow $session 'tour typed|peek got').Title)'; tab A's page is titled '$((Get-PageWindow $session 'tour tab a|a got').Title)'")
    Set-Seen $stop ($switched -and $shown -and $typed)
  }
  Note-Required $stop "peek-tabs"

  $stop = Invoke-Stop $session "peek-tabs-closed" "Closing the Peek leaves tab A whole and with the keyboard" {
    param($stop)
    $stop.Did = "Pressed Escape to close the Peek, shot the window, then typed 'xyz'."
    $stop.Expected = "tab A's blue page is whole where the card was (under 2% not blue, the link aside), and the letters reach it: its title reads 'a got xyz'."
    Send-Escape
    $closed = Wait-Until $session { $null -eq (Get-PageWindow $session "tour typed|peek got") } 5000
    Start-Sleep -Milliseconds 1200
    Save-Shot $stop $session.Main | Out-Null
    $pageA = Get-Box (Get-PageWindow $session "tour tab a|a got")
    $client = Get-Client $session.Main
    $where = Get-Overlap $state.Card $pageA
    if ($where -and $client) {
      $below = [int](90 * $client.Scale)
      $where = [pscustomobject]@{ Left = $where.Left; Top = [Math]::Max($where.Top, $pageA.Top + $below); Width = $where.Width; Height = $where.Top + $where.Height - [Math]::Max($where.Top, $pageA.Top + $below) }
    }
    $notBlue = Measure-Colour $stop.Shot $where $blue
    Send-Text "xyz"
    $typed = Wait-Until $session { $null -ne (Get-PageWindow $session "a got xyz") } 5000
    $stop.Facts.Add("the Peek closed: $closed; where the card was, $notBlue% of tab A's page is not blue; tab A got 'xyz': $typed; tab A's page is titled '$((Get-PageWindow $session 'tour tab a|a got').Title)'")
    Set-Seen $stop ($closed -and $null -ne $notBlue -and $notBlue -lt 2 -and $typed)
  }
  Note-Required $stop "peek-tabs"
  Stop-Ardia $session
}

function Invoke-PeekTour([string]$Name, [hashtable]$Settings, [string]$Look, [int]$Height = 0, [int]$ScaleSteps = 0) {
  if (-not (Start-TourPages)) {
    $script:Lines.Add("- The $Name part found no loopback page server on port $($script:TourPagesPort).")
    return
  }
  $savedStep = $null
  if ($ScaleSteps) {
    $savedStep = Get-ScaleStep
    $set = Set-ScaleStep ($savedStep + $ScaleSteps)
    $script:Lines.Add("- The $Name part moved the display scale override from step $savedStep to $(Get-ScaleStep) (set: $set).")
  }
  $session = Start-Ardia $Name -Onboarded -Settings $Settings
  Invoke-Stop $session $Name "A Peek over a page, $Look" {
    param($stop)
    $stop.Did = "Opened a loopback page with one link, then Shift-clicked the link."
    $stop.Expected = "a Peek card over the page with all four corners rounded alike, its page green, the page behind dimmed."
    if (-not (Test-Usable $session)) { $stop.Seen = "no"; return }
    if ($Height -gt 0) {
      $frame = Get-Frame $session.Main
      [ArdiaTour]::SetWindowPos($session.Main, [IntPtr]::Zero, $frame.Left, $frame.Top, $frame.Width, $Height, 0x0014) | Out-Null
      Start-Sleep -Milliseconds 1200
      $stop.Facts.Add("the main window was made $Height pixels tall")
    }
    Focus-Window $session $session.Main $stop | Out-Null
    $mark = Get-LogCount $session
    Send-Chord @(0x11) 0x54
    $opened = Wait-Command $session $mark "newTab"
    Start-Sleep -Milliseconds 700
    Send-Address "127.0.0.1:$($script:TourPagesPort)/links"
    Send-Key 0x0D 0
    Send-Key 0x0D 2
    $loaded = Wait-Title $session "tour links"
    Start-Sleep -Milliseconds 2500
    $stop.Facts.Add("newTab command logged: $opened; the links page loaded: $loaded")
    $page = Get-PageWindow $session "tour links"
    $client = Get-Client $session.Main
    if (-not $page -or -not $client) {
      $stop.Facts.Add("no page window for the links page: $(Format-Windows (Get-TopWindows $session))")
      Set-Seen $stop $false
      return
    }
    $x = $page.Left + [int](180 * $client.Scale)
    $y = $page.Top + [int](50 * $client.Scale)
    $stop.Facts.Add("the links page window is $($page.Width) by $($page.Height) at $($page.Left), $($page.Top); Shift-clicking at $x, $y")
    Send-Key 0x10 0
    Start-Sleep -Milliseconds 80
    Send-Click $x $y
    Send-Key 0x10 2
    $peeked = Wait-Until $session { $null -ne (Get-PageWindow $session "tour peeked") } 15000
    Start-Sleep -Milliseconds 2500
    Save-Shot $stop $session.Main | Out-Null
    $card = Get-PageWindow $session "tour peeked"
    if ($card) { $stop.Facts.Add("the Peek's page window is $($card.Width) by $($card.Height) at $($card.Left), $($card.Top)") }
    $stop.Facts.Add("main window client $($client.Width) by $($client.Height) at $($client.X), $($client.Y), scale $($client.Scale)")
    Set-Seen $stop $peeked
    Send-Escape
    Start-Sleep -Milliseconds 800
  } | Out-Null
  Stop-Ardia $session
  if ($null -ne $savedStep) { Set-ScaleStep $savedStep | Out-Null }
}

function Invoke-LayoutTour([string]$Name, [hashtable]$Settings, [string]$Title, [string]$Expected) {
  $session = Start-Ardia $Name -Onboarded -Settings $Settings
  Invoke-Stop $session $Name $Title {
    param($stop)
    $stop.Did = "Launched with $(($Settings.GetEnumerator() | ForEach-Object { "$($_.Key) = $($_.Value)" }) -join ', ') in config.json, then pressed Ctrl+T twice."
    $stop.Expected = $Expected
    if (-not (Test-Usable $session)) { $stop.Seen = "no"; return }
    Focus-Window $session $session.Main $stop | Out-Null
    $mark = Get-LogCount $session
    Send-Chord @(0x11) 0x54
    Send-Chord @(0x11) 0x54
    Start-Sleep -Milliseconds 1200
    Save-Shot $stop $session.Main | Out-Null
    $band = Get-TitleBand $session
    Set-Seen $stop ($band -eq "caption")
    $stop.Facts.Add("title band is $band")
    $stop.Facts.Add("$((Get-LinesSince $session $mark '^command \d+ newTab$').Count) newTab commands logged")
    $problems = @(Read-LogLines $session.Log | Where-Object { $_ -match "\[config\]" })
    if ($problems.Count) { $stop.Facts.Add("config log lines: $(($problems | Select-Object -First 3) -join ' | ')") }
  } | Out-Null
  Stop-Ardia $session
}

function Invoke-DarkTour {
  $session = Start-Ardia "dark" -Onboarded -Settings @{ appearance = "dark" }
  Invoke-Stop $session "dark-main" "Dark mode, main window" {
    param($stop)
    $stop.Did = "Launched with appearance = dark in config.json."
    $stop.Expected = "the window's DWM dark mode attribute is on, and the window is darker than the light main window."
    if (-not (Test-Usable $session)) { $stop.Seen = "no"; return }
    Focus-Window $session $session.Main $stop | Out-Null
    Start-Sleep -Milliseconds 800
    $shot = Save-Shot $stop $session.Main
    $dark = [ArdiaTour]::DarkModeOf($session.Main)
    $darker = $null
    if ($null -ne $shot.Brightness -and $null -ne $script:LightBrightness) {
      $darker = $shot.Brightness -lt ($script:LightBrightness - 30)
      $stop.Facts.Add("brightness $($shot.Brightness) against $($script:LightBrightness) in light mode")
    }
    $stop.Facts.Add("DWM dark title bar: $dark (-1 means it could not be read)")
    if ($dark -eq 1 -or $darker -eq $true) { $stop.Seen = "yes" }
    elseif ($dark -eq 0 -or $darker -eq $false) { $stop.Seen = "no" }
  } | Out-Null
  if (Test-Usable $session) { Invoke-SettingsStops $session "-dark" ", dark mode" }
  Stop-Ardia $session
}

function Get-Motion($Session, [int]$Mark) {
  return @(Get-LinesSince $Session $Mark "\[ardia windows\] motion \d+ frames in \d+ ms" | ForEach-Object {
    if ($_ -match "motion (\d+) frames in (\d+) ms, longest (\d+) ms, (\d+) long") {
      [pscustomobject]@{ Frames = [int]$Matches[1]; Milliseconds = [int]$Matches[2]; Longest = [int]$Matches[3]; Long = [int]$Matches[4] }
    }
  })
}

function Invoke-MotionStop($Session, [string]$Slug, [string]$Title, [string]$Keys, [byte[]]$Modifiers, [byte]$Key, [string]$Command, [int]$AtLeastMs, [switch]$JumpsWithAnimationsOff) {
  Invoke-Stop $Session $Slug $Title {
    param($stop)
    $stop.Did = "Pressed $Keys."
    $jumps = $JumpsWithAnimationsOff -and -not [ArdiaTour]::AnimationsOn()
    $stop.Expected = "the launch log reports animation frames for at least $AtLeastMs ms, at 30 a second or more apart from its one longest gap."
    if ($jumps) { $stop.Expected = "no slide: Windows' animation effects are off here, and this one follows that setting." }
    Focus-Window $Session $Session.Main $stop | Out-Null
    Close-Menus $Session
    $mark = Get-LogCount $Session
    Send-Chord $Modifiers $Key
    $commanded = Wait-Command $Session $mark $Command
    Wait-Until $Session { (Get-Motion $Session $mark).Count -gt 0 } 3000 | Out-Null
    Start-Sleep -Milliseconds 700
    $bursts = @(Get-Motion $Session $mark)
    Save-Shot $stop $Session.Main | Out-Null
    $stop.Facts.Add("command $Command logged: $commanded")
    $stop.Facts.Add("Windows' animation effects are on: $([ArdiaTour]::AnimationsOn())")
    if (-not $bursts.Count) {
      $stop.Facts.Add("no animation frames were logged")
      Set-Seen $stop ($commanded -and $jumps)
      return
    }
    foreach ($burst in $bursts) {
      $rate = [Math]::Round($burst.Frames * 1000 / [Math]::Max(1, $burst.Milliseconds))
      $stop.Facts.Add("$($burst.Frames) frames in $($burst.Milliseconds) ms ($rate a second), longest gap $($burst.Longest) ms, $($burst.Long) long gaps")
    }
    $longest = $bursts | Sort-Object Milliseconds -Descending | Select-Object -First 1
    $smooth = ($longest.Frames - 1) * 1000 / [Math]::Max(1, $longest.Milliseconds - $longest.Longest) -ge 30
    Set-Seen $stop ($commanded -and ($jumps -or ($longest.Milliseconds -ge $AtLeastMs -and $smooth)))
  } | Out-Null
}

function Invoke-MotionTour {
  $session = Start-Ardia "motion" -Onboarded
  if (Test-Usable $session) {
    Invoke-MotionStop $session "motion-sidebar-hides" "The sidebar slides away" "Ctrl+S" @(0x11) 0x53 "toggleSidebar" 150 -JumpsWithAnimationsOff
    Invoke-MotionStop $session "motion-sidebar-shows" "The sidebar slides back" "Ctrl+S" @(0x11) 0x53 "toggleSidebar" 150 -JumpsWithAnimationsOff
    Invoke-MotionStop $session "motion-new-tab" "A new tab's row slides in" "Ctrl+T" @(0x11) 0x54 "newTab" 80
  }
  Stop-Ardia $session
}

$script:SettingsWindow = [IntPtr]::Zero

if (-not (Test-Path -LiteralPath $App)) {
  $script:Lines.Add("- No app at '$App': nothing to tour (did the build fail?).")
  Write-Tour
  Write-Host "[tour] no app at $App"
  exit 0
}
$App = (Resolve-Path -LiteralPath $App).Path
New-Item -ItemType File -Force -Path (Join-Path (Split-Path -Parent $App) "Ardia.test-build") | Out-Null

$tours = @(
  @{ Name = "onboarding"; Run = { Invoke-OnboardingTour } },
  @{ Name = "browser"; Run = { Invoke-MainTour } },
  @{ Name = "top tabs"; Run = { Invoke-LayoutTour "top-tabs" @{ tabLayout = "top" } "Tabs in a top strip" "the window buttons sit at the end of the strip, and the gap beside them is a caption region." } },
  @{ Name = "sidebar on the right"; Run = { Invoke-LayoutTour "sidebar-right" @{ sidebarSide = "right" } "Sidebar on the right" "the window buttons sit in the sidebar's header, and the gap beside them is a caption region." } },
  @{ Name = "dark"; Run = { Invoke-DarkTour } },
  @{ Name = "motion"; Run = { Invoke-MotionTour } }
)

if (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $App) "chrome.dll")) {
  $tours += @{ Name = "pages"; Run = { Invoke-PagesTour } }
  $tours += @{ Name = "first-run"; Run = { Invoke-FirstRunTour }; Required = $true }
  $tours += @{ Name = "typing"; Run = { Invoke-TypingTour }; Required = $true }
  $tours += @{ Name = "peek"; Run = { Invoke-PeekTour "peek-light" @{ appearance = "light" } "light" } }
  $tours += @{ Name = "peek-dark"; Run = { Invoke-PeekTour "peek-dark" @{ appearance = "dark" } "dark" } }
  $tours += @{ Name = "peek-tabs"; Run = { Invoke-PeekTabsTour } }
  $tours += @{ Name = "peek-layouts"; Run = {
      Invoke-PeekTour "peek-sidebar-address" @{ appearance = "light"; addressBar = "sidebar" } "light, address bar in the sidebar"
      Invoke-PeekTour "peek-borderless" @{ appearance = "light"; borderlessMode = $true } "light, Borderless"
      Invoke-PeekTour "peek-top-tabs" @{ appearance = "light"; tabLayout = "top" } "light, tabs on top"
      Invoke-PeekTour "peek-short" @{ appearance = "light" } "light, a 460 pixel tall window" 460
      Invoke-PeekTour "peek-scale-up" @{ appearance = "light" } "light, the display scale one step up" 0 1
      Invoke-PeekTour "peek-scale-up-dark" @{ appearance = "dark" } "dark, the display scale one step up" 0 1
    } }
}

if ($Only.Count) {
  $tours = @($tours | Where-Object { $Only -contains $_.Name })
  if (-not $tours.Count) { throw "no part of the tour is named $($Only -join ', ')" }
}

foreach ($tour in $tours) {
  Write-Host "[tour] === $($tour.Name) ==="
  try {
    & $tour.Run
  } catch {
    $script:Lines.Add("- The $($tour.Name) part stopped early: $($_.Exception.Message)")
    Write-Host "[tour] the $($tour.Name) part stopped early: $($_.Exception.Message)"
    if ($tour.Required) { $script:FailedStops.Add("the $($tour.Name) part stopped early: $($_.Exception.Message)") }
  } finally {
    foreach ($session in @($script:Sessions | Where-Object { -not $_.Stopping })) { Stop-Ardia $session }
  }
}

Stop-TourPages
$env:ARDIA_DATA_DIR = ""
foreach ($part in $Required) {
  if (-not @($tours | Where-Object { $_.Name -eq $part }).Count) { $script:RequiredFailures.Add("$($part): not run") }
}
if ($script:RequiredFailures.Count) {
  $script:Lines.Add("- Required stops that were not seen: $($script:RequiredFailures -join '; ').")
  Set-Content -LiteralPath (Join-Path $Out "required-failed.txt") -Value ($script:RequiredFailures -join "`n") -Encoding utf8NoBOM
}
Write-Tour
$elapsed = [Math]::Round(((Get-Date) - $script:Started).TotalSeconds)
$crashed = @($script:Sessions | Where-Object { $_.Crashed })
Write-Host "[tour] $($script:StopNumber) stops in $elapsed s; tour.md and the screenshots are in $Out"
if ($script:FailedStops.Count) {
  foreach ($failed in $script:FailedStops) { Write-Host "::error::required tour stop failed: $failed" }
}
if ($crashed.Count -or $script:FailedStops.Count) {
  foreach ($session in $crashed) { Write-Host "::error::the app crashed or exited on its own during the '$($session.Name)' launch: $($session.Summary)" }
  exit 1
}
exit 0
