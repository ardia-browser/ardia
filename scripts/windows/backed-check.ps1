param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = "Stop"

$lab = @{ Tile = 48; Slot = 64; Left = 24; Top = 96; Rounds = 3; RoundMs = 1600; ShownMs = 1000 }
$probes = @("marker", "raw background+zIndex", "background+zIndex", "background", "background with a child below zero", "setNativeProps background")
$captureMs = 30000
$labMs = $lab.Rounds * $lab.RoundMs + 2500
$shotAfterSecondMarkMs = 400
$whiteAt = 220
$darkBelow = 30
$shownWithinMs = 100

if (-not ([System.Management.Automation.PSTypeName]"ArdiaBackedCheck").Type) {
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ArdiaBackedCheck {
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct BitmapInfoHeader { public uint Size; public int Width, Height; public ushort Planes, BitCount; public uint Compression, SizeImage; public int XPelsPerMeter, YPelsPerMeter; public uint ClrUsed, ClrImportant; }
  delegate bool EnumWindowsCallback(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int max);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfoHeader header, uint usage, out IntPtr bits, IntPtr section, uint offset);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr item);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr item);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dc, int x, int y, int width, int height, IntPtr source, int sx, int sy, uint op);
  [DllImport("gdi32.dll")] static extern bool GdiFlush();
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);

  public class Sample { public long Ms; public int[] Values; public bool Ours; }
  public class Shot { public long Ms; public int Width; public int Height; public byte[] Pixels; public string Front; }
  public class Run { public long WindowMs = -1; public double Scale = 1; public List<Sample> Samples = new List<Sample>(); public List<Shot> Shots = new List<Shot>(); public Process Process; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

  static string Describe(IntPtr window, uint process) {
    if (window == IntPtr.Zero) return "none";
    uint owner;
    GetWindowThreadProcessId(window, out owner);
    StringBuilder name = new StringBuilder(64);
    GetClassName(window, name, 64);
    return name.ToString() + (owner == process ? " (ours)" : " (pid " + owner + ")");
  }

  static Shot Whole(IntPtr window, IntPtr screen, IntPtr memory, long at, uint process) {
    Rect client;
    GetClientRect(window, out client);
    Point origin = new Point();
    ClientToScreen(window, ref origin);
    Shot shot = new Shot();
    shot.Ms = at;
    shot.Width = client.Right - client.Left;
    shot.Height = client.Bottom - client.Top;
    shot.Front = Describe(GetForegroundWindow(), process);
    if (shot.Width < 8 || shot.Height < 8) return shot;
    BitmapInfoHeader header = new BitmapInfoHeader();
    header.Size = (uint)Marshal.SizeOf(typeof(BitmapInfoHeader));
    header.Width = shot.Width;
    header.Height = -shot.Height;
    header.Planes = 1;
    header.BitCount = 32;
    IntPtr bits;
    IntPtr section = CreateDIBSection(screen, ref header, 0, out bits, IntPtr.Zero, 0);
    if (section == IntPtr.Zero) return shot;
    IntPtr previous = SelectObject(memory, section);
    if (BitBlt(memory, 0, 0, shot.Width, shot.Height, screen, origin.X, origin.Y, 0x40CC0020)) {
      shot.Pixels = new byte[shot.Width * shot.Height * 4];
      GdiFlush();
      Marshal.Copy(bits, shot.Pixels, 0, shot.Pixels.Length);
    }
    SelectObject(memory, previous);
    DeleteObject(section);
    return shot;
  }

  static IntPtr Find(uint process) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr window, IntPtr data) {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner != process || !IsWindowVisible(window)) return true;
      StringBuilder name = new StringBuilder(64);
      GetClassName(window, name, 64);
      if (name.ToString() != "Microsoft.UI.Windowing.Window") return true;
      found = window;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  static bool OursAt(Point point, uint process) {
    IntPtr top = GetAncestor(WindowFromPoint(point), 2);
    uint owner;
    GetWindowThreadProcessId(top, out owner);
    return owner == process;
  }

  public static Run Capture(string app, string arguments, int milliseconds, int afterWindowMs, int tiles, int left, int slot, int tile, int[] tops, long shotAfterSecondMarkMs, int whiteAt, int darkBelow) {
    SetProcessDPIAware();
    Run run = new Run();
    Stopwatch clock = Stopwatch.StartNew();
    ProcessStartInfo start = new ProcessStartInfo(app, arguments);
    start.UseShellExecute = false;
    run.Process = Process.Start(start);
    IntPtr window = IntPtr.Zero;
    IntPtr screen = GetDC(IntPtr.Zero);
    IntPtr memory = CreateCompatibleDC(screen);
    IntPtr section = IntPtr.Zero, bits = IntPtr.Zero, previous = IntPtr.Zero;
    int width = 0, x0 = 0;
    int[] ys = new int[tops.Length];
    int[] xs = new int[tiles];
    int rises = 0;
    bool lit = false;
    long shotDue = -1;
    IntPtr shotMemory = CreateCompatibleDC(screen);
    Point probe = new Point(), firstTile = new Point(), lastTile = new Point();
    try {
      while (clock.ElapsedMilliseconds < milliseconds && (run.WindowMs < 0 || clock.ElapsedMilliseconds - run.WindowMs < afterWindowMs) && !run.Process.HasExited) {
        if (window == IntPtr.Zero) {
          window = Find((uint)run.Process.Id);
          if (window == IntPtr.Zero) { Thread.Sleep(1); continue; }
          run.WindowMs = clock.ElapsedMilliseconds;
          run.Scale = GetDpiForWindow(window) / 96.0;
          Point origin = new Point();
          ClientToScreen(window, ref origin);
          x0 = origin.X + (int)(left * run.Scale);
          width = (int)(tiles * slot * run.Scale);
          for (int r = 0; r < tops.Length; r++) ys[r] = origin.Y + (int)((tops[r] + tile / 2) * run.Scale);
          for (int i = 0; i < tiles; i++) xs[i] = (int)((i * slot + tile / 2) * run.Scale);
          probe.X = x0 + width / 2;
          probe.Y = (ys[0] + ys[ys.Length - 1]) / 2;
          firstTile.X = x0 + xs[0];
          firstTile.Y = probe.Y;
          lastTile.X = x0 + xs[tiles - 1];
          lastTile.Y = probe.Y;
          BitmapInfoHeader header = new BitmapInfoHeader();
          header.Size = (uint)Marshal.SizeOf(typeof(BitmapInfoHeader));
          header.Width = width;
          header.Height = -(ys[ys.Length - 1] - ys[0] + 1);
          header.Planes = 1;
          header.BitCount = 32;
          section = CreateDIBSection(screen, ref header, 0, out bits, IntPtr.Zero, 0);
          previous = SelectObject(memory, section);
        }
        long at = clock.ElapsedMilliseconds;
        if (shotDue >= 0 && at >= shotDue && run.Shots.Count == 0) {
          run.Shots.Add(Whole(window, screen, shotMemory, at - run.WindowMs, (uint)run.Process.Id));
          continue;
        }
        Sample sample = new Sample();
        sample.Ms = at;
        sample.Values = new int[tiles * ys.Length];
        int band = ys[ys.Length - 1] - ys[0] + 1;
        if (!BitBlt(memory, 0, 0, width, band, screen, x0, ys[0], 0x40CC0020)) { Thread.Sleep(1); continue; }
        GdiFlush();
        byte[] rows = new byte[width * band * 4];
        Marshal.Copy(bits, rows, 0, rows.Length);
        sample.Ours = OursAt(probe, (uint)run.Process.Id) && OursAt(firstTile, (uint)run.Process.Id) && OursAt(lastTile, (uint)run.Process.Id);
        for (int r = 0; r < ys.Length; r++) {
          int offset = (ys[r] - ys[0]) * width * 4;
          for (int i = 0; i < tiles; i++) {
            int p = offset + xs[i] * 4;
            sample.Values[r * tiles + i] = (rows[p] + rows[p + 1] + rows[p + 2]) / 3;
          }
        }
        run.Samples.Add(sample);
        int mark = sample.Values[0];
        if (mark >= whiteAt && !lit) {
          lit = true;
          rises++;
          if (rises == 2) shotDue = at + shotAfterSecondMarkMs;
        } else if (mark < darkBelow) lit = false;
        Thread.Sleep(2);
      }
    } catch {
      try { if (!run.Process.HasExited) { run.Process.Kill(); run.Process.WaitForExit(10000); } } catch { }
      throw;
    } finally {
      if (section != IntPtr.Zero) { SelectObject(memory, previous); DeleteObject(section); }
      DeleteDC(memory);
      DeleteDC(shotMemory);
      ReleaseDC(IntPtr.Zero, screen);
    }
    return run;
  }
}
"@
}

$data = Join-Path $Out "backed-check-data"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $data
New-Item -ItemType Directory -Force -Path $data | Out-Null
Set-Content -LiteralPath (Join-Path $data "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM
$log = Join-Path $Out "backed-check.log"
Remove-Item -Force -ErrorAction SilentlyContinue $log
$config = Join-Path $Out "backed-check-config"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $config
New-Item -ItemType Directory -Force -Path $config | Out-Null
$kept = @{}
foreach ($name in @("ARDIA_DATA_DIR", "ARDIA_CONFIG_DIR", "ARDIA_BACKGROUND", "ARDIA_TEST")) { $kept[$name] = [Environment]::GetEnvironmentVariable($name) }
$env:ARDIA_DATA_DIR = $data
$env:ARDIA_CONFIG_DIR = $config
$env:ARDIA_BACKGROUND = ""
$env:ARDIA_TEST = "backedLab=1"
try {
  $run = [ArdiaBackedCheck]::Capture($App, "--log-file=`"$log`"", $captureMs, $labMs, $probes.Count, $lab.Left, $lab.Slot, $lab.Tile, [int[]]@($lab.Top), $shotAfterSecondMarkMs, $whiteAt, $darkBelow)
} finally {
  foreach ($name in $kept.Keys) { if ($null -eq $kept[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue } else { [Environment]::SetEnvironmentVariable($name, $kept[$name]) } }
}
if ($run.Process -and -not $run.Process.HasExited) {
  Stop-Process -Id $run.Process.Id -Force -ErrorAction SilentlyContinue
  if (-not $run.Process.WaitForExit(10000)) { Write-Host "backed check: the lab's app hadn't exited 10 s after it was stopped" }
}

Add-Type -AssemblyName System.Drawing
foreach ($shot in @($run.Shots)) {
  if (-not $shot.Pixels) { Write-Host "backed check: no picture at $($shot.Ms) ms, in front: $($shot.Front)"; continue }
  $bitmap = [System.Drawing.Bitmap]::new($shot.Width, $shot.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
  $box = [System.Drawing.Rectangle]::new(0, 0, $shot.Width, $shot.Height)
  $locked = $bitmap.LockBits($box, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bitmap.PixelFormat)
  [System.Runtime.InteropServices.Marshal]::Copy($shot.Pixels, 0, $locked.Scan0, $shot.Pixels.Length)
  $bitmap.UnlockBits($locked)
  $bitmap.Save((Join-Path $Out "backed-check.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  Write-Host "backed check: picture at $($shot.Ms) ms after the window, $shotAfterSecondMarkMs ms after round 2's marker, in front: $($shot.Front)"
}

$samples = @($run.Samples)
$ours = @($samples | Where-Object { $_.Ours }).Count
Write-Host "backed check: window at $($run.WindowMs) ms, scale $($run.Scale), $ours of $($samples.Count) samples with our window at the lab"
if ($ours -lt 100) { return @("backed check: only $ours samples showed our window at the lab (in front at the picture: $(@($run.Shots | Select-Object -First 1).Front))") }

$intervals = @()
$on = $null
foreach ($sample in $samples) {
  $marked = $sample.Values[0] -ge $whiteAt
  if ($marked -and $null -eq $on) { $on = $sample.Ms }
  if (-not $marked -and $null -ne $on -and $sample.Values[0] -lt $darkBelow) { $intervals += , @($on, $sample.Ms); $on = $null }
}
$problems = @()
if ($intervals.Count -lt $lab.Rounds) { $problems += "backed check: the marker showed $($intervals.Count) rounds, not $($lab.Rounds)" }
if ($intervals.Count) {
  $covered = @($samples | Where-Object { $sample = $_; -not $sample.Ours -and @($intervals | Where-Object { $sample.Ms -ge $_[0] - 100 -and $sample.Ms -le $_[1] + 100 }).Count }).Count
  if ($covered) { return @("backed check: another window covered the lab in $covered samples during the rounds, so they can't be judged") }
}

for ($p = 1; $p -lt $probes.Count; $p++) {
  $notes = @()
  $hidden = 0
  for ($r = 1; $r -lt $intervals.Count; $r++) {
    $from = $intervals[$r][0]
    $to = $intervals[$r][1]
    $inRound = @($samples | Where-Object { $_.Ms -ge $from -and $_.Ms -lt $to })
    $white = @($inRound | Where-Object { $_.Values[$p] -ge $whiteAt }) | Select-Object -First 1
    $landed = if ($white) { [int]($white.Ms - $from) } else { $null }
    $last = if ($inRound.Count) { $inRound[-1].Values[$p] } else { -1 }
    $notes += "r$($r + 1) $(if ($null -eq $landed) { "never (last $last)" } else { "white at $landed ms, last $last" })"
    if ($null -eq $landed) { $hidden++ }
    if ($p -eq 1) { continue }
    if ($null -eq $landed -or $landed -gt $shownWithinMs) { $problems += "backed check, $($probes[$p]), round $($r + 1): the child mounted with the round wasn't drawn above the background within $shownWithinMs ms ($(if ($null -eq $landed) { "never, last $last" } else { "white at $landed ms" }))" }
    elseif ($last -lt $whiteAt) { $problems += "backed check, $($probes[$p]), round $($r + 1): drawn at $landed ms but gone before the round's end (last $last)" }
  }
  Write-Host "backed check, $($probes[$p]): $($notes -join '; ')"
  if ($p -eq 1) { Write-Host "backed check: React Native Windows' own View with a background and zIndex hid a child mounted later in $hidden of $([Math]::Max(0, $intervals.Count - 1)) rounds; when this reads 0 after an upgrade, the backed View in packages/expo-windows/metroResolution.js can go" }
}
return $problems
