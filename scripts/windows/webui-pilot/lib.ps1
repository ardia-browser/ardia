$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wait.ps1')
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Pilot {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string reserved; public string desktop; public string title; public int x, y, width, height, xChars, yChars, fill, flags; public short show, reserved2; public IntPtr reserved3, stdIn, stdOut, stdErr; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr process; public IntPtr thread; public int pid; public int tid; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct PROCESSENTRY32 { public int size; public int usage; public int pid; public IntPtr heap; public int module; public int threads; public int parent; public int priority; public int flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, StringBuilder commandLine, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  public static IntPtr OpenFolder(string path, uint access) { return CreateFileW(path, access, 0x1 | 0x2, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero); }
  public static void CloseFolder(IntPtr handle) { CloseHandle(handle); }
  public static HashSet<int> Roots = new HashSet<int>();
  static Dictionary<int, PROCESS_INFORMATION> started = new Dictionary<int, PROCESS_INFORMATION>();
  public static int StartSuspended(string exe, string commandLine) {
    STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(exe, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, 0x00000004, IntPtr.Zero, null, ref si, out pi)) return -1;
    started[pi.pid] = pi; Roots.Add(pi.pid); return pi.pid;
  }
  public static void Resume(int pid) { ResumeThread(started[pid].thread); }
  public static long WaitExit(int pid, int ms) {
    PROCESS_INFORMATION pi = started[pid];
    if (WaitForSingleObject(pi.process, (uint)ms) != 0) return -1;
    uint code; GetExitCodeProcess(pi.process, out code); return code;
  }
  public static string[] Argv(string commandLine) {
    int count; IntPtr argv = CommandLineToArgvW(commandLine, out count);
    var result = new string[count];
    for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
    LocalFree(argv); return result;
  }
  public static Dictionary<int, int> Parents() {
    var map = new Dictionary<int, int>();
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    PROCESSENTRY32 e = new PROCESSENTRY32(); e.size = Marshal.SizeOf(typeof(PROCESSENTRY32));
    if (Process32FirstW(snapshot, ref e)) { do { map[e.pid] = e.parent; } while (Process32NextW(snapshot, ref e)); }
    CloseHandle(snapshot); return map;
  }
  public static bool IsTracked(int pid) {
    if (!IsPilotProcess(pid)) return false;
    var parents = Parents();
    for (int hop = 0, at = pid; hop < 16; hop++) {
      if (Roots.Contains(at)) return true;
      int parent; if (!parents.TryGetValue(at, out parent) || parent == 0 || parent == at) return false;
      at = parent;
    }
    return false;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT p);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
  public static string AppDir = "";
  public static bool IsPilotProcess(int pid) {
    try { return Process.GetProcessById(pid).MainModule.FileName.StartsWith(AppDir, StringComparison.OrdinalIgnoreCase); } catch { return false; }
  }
  public static void Aware() { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
  static INPUT Mouse(uint flags, int x, int y, uint data) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dx = x; i.u.mi.dy = y; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags; return i;
  }
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i;
  }
  static void Send(params INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }
  public static void MoveTo(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int nx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1)), ny = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
    Send(Mouse(0x0001 | 0x8000 | 0x4000, nx, ny, 0));
  }
  public static void Glide(int x, int y, int steps, int ms) {
    POINT p; GetCursorPos(out p);
    for (int s = 1; s <= steps; s++) { MoveTo(p.X + (x - p.X) * s / steps, p.Y + (y - p.Y) * s / steps); Thread.Sleep(ms); }
  }
  public static void Down() { Send(Mouse(0x0002, 0, 0, 0)); }
  public static void Up() { Send(Mouse(0x0004, 0, 0, 0)); }
  public static void Click(int x, int y) { Glide(x, y, 12, 12); Thread.Sleep(80); Down(); Thread.Sleep(60); Up(); }
  public static void DoubleClick(int x, int y) { Glide(x, y, 12, 12); Thread.Sleep(80); Down(); Up(); Thread.Sleep(60); Down(); Up(); }
  public static void Drag(int x0, int y0, int x1, int y1, int steps) { Glide(x0, y0, 10, 15); Thread.Sleep(120); Down(); Thread.Sleep(120); Glide(x1, y1, steps, 16); Thread.Sleep(200); Up(); }
  public static void KeyDown(ushort vk) { Send(Key(vk, 0, (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B ? 1u : 0u)); }
  public static void KeyUp(ushort vk) { Send(Key(vk, 0, 2u | ((vk >= 0x21 && vk <= 0x2E) || vk == 0x5B ? 1u : 0u))); }
  public static void Chord(params ushort[] vks) { foreach (var v in vks) { KeyDown(v); Thread.Sleep(30); } Thread.Sleep(60); for (int k = vks.Length - 1; k >= 0; k--) { KeyUp(vks[k]); Thread.Sleep(30); } }
  public static void Type(string text) {
    foreach (char c in text) { Send(Key(0, c, 0x0004), Key(0, c, 0x0004 | 0x0002)); Thread.Sleep(35); }
  }
  static bool IsShell(IntPtr h) {
    if (!IsWindowVisible(h)) return false;
    var c = new StringBuilder(256); GetClassName(h, c, 256);
    if (!c.ToString().StartsWith("Chrome_WidgetWin")) return false;
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (!IsTracked((int)pid)) return false;
    RECT r; GetWindowRect(h, out r);
    return (r.Right - r.Left) > 400 && (r.Bottom - r.Top) > 300;
  }
  public static IntPtr FindShell(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { if (IsShell(h)) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static int CountShells(string title) {
    int n = 0;
    EnumWindows((h, l) => { if (IsShell(h)) n++; return true; }, IntPtr.Zero);
    return n;
  }
  public static List<IntPtr> Shells() {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => { if (IsShell(h)) found.Add(h); return true; }, IntPtr.Zero);
    return found;
  }
  public static RECT Frame(IntPtr hwnd) { RECT r; DwmGetWindowAttribute(hwnd, 9, out r, Marshal.SizeOf(typeof(RECT))); return r; }
  public static RECT Outer(IntPtr hwnd) { RECT r; GetWindowRect(hwnd, out r); return r; }
  public static string Hit(int x, int y) {
    POINT p; p.X = x; p.Y = y; IntPtr h = WindowFromPoint(p);
    long l = ((long)(short)y << 16) | (ushort)(short)x;
    IntPtr r = SendMessage(h, 0x0084, IntPtr.Zero, new IntPtr(l));
    var c = new StringBuilder(256); GetClassName(h, c, 256);
    string via = "";
    if (r.ToInt64() == -1) { IntPtr root = GetAncestor(h, 2); via = c.ToString() + ">"; h = root; r = SendMessage(h, 0x0084, IntPtr.Zero, new IntPtr(l)); c = new StringBuilder(256); GetClassName(h, c, 256); }
    return via + c.ToString() + ":" + r.ToInt64();
  }
}
"@
[Pilot]::Aware() | Out-Null

function Shot([string]$path) {
  if (-not (Test-Path -LiteralPath C:\tools\ffmpeg.exe -PathType Leaf)) { return }
  & C:\tools\ffmpeg.exe -hide_banner -loglevel error -y -f gdigrab -framerate 1 -i desktop -frames:v 1 $path
}

function Shell-Window { [Pilot]::FindShell('Ardia') }

function Wait-Shell([int]$seconds = 60) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $h = Shell-Window
    if ($h -ne [IntPtr]::Zero) { return $h }
    Start-Sleep -Milliseconds 300
  }
  throw "no Ardia WebUI window after $seconds s"
}

function Shell-Lines { @(Get-Content "$($script:Data)\Chromium\chrome_debug.log" -ErrorAction SilentlyContinue | Select-String 'WebUI shell' | ForEach-Object { $_.Line.Substring($_.Line.IndexOf('WebUI shell')) }) }

function Shell-Lines-Matching([string]$pattern, [int]$after = 0) { @(Shell-Lines | Select-Object -Skip $after | Where-Object { $_ -match $pattern }) }

function Wait-ShellReady([int]$Seconds = 60, [int]$After = 0) {
  $h = Wait-Shell $Seconds
  Wait-Until { DevTools-Port } $Seconds "this run's own DevTools port" | Out-Null
  Wait-Until { (Shell-Lines-Matching 'shell painted( in window \S+|; the start is settled)' $After).Count -ge 1 } $Seconds 'the shell to report it painted' | Out-Null
  Wait-Until { (Cdp-Eval 'typeof window.__ardiaHost === "object" && !!document.querySelector(".ardia-window-controls") && document.getElementById("root").innerText.trim().length > 0') -eq $true } $Seconds 'the shell UI to render' | Out-Null
  $h
}

function Rect-Text($r) { "$($r.Left),$($r.Top) $($r.Right - $r.Left)x$($r.Bottom - $r.Top)" }

function DevTools-Port {
  if ($script:Port -and $script:PortOwner -and [Pilot]::IsTracked($script:PortOwner)) { return $script:Port }
  $script:Port = 0
  $script:PortOwner = 0
  $file = Join-Path $script:Data 'Chromium\DevToolsActivePort'
  $first = Get-Content -LiteralPath $file -TotalCount 1 -ErrorAction SilentlyContinue
  $port = 0
  if (-not [int]::TryParse("$first", [ref]$port) -or $port -le 0) { return 0 }
  $owner = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object OwningProcess | Where-Object { [Pilot]::IsTracked([int]$_) }) | Select-Object -First 1
  if (-not $owner) { return 0 }
  $script:Port = $port
  $script:PortOwner = [int]$owner
  $port
}

function Cdp-List {
  $port = DevTools-Port
  if (-not $port) { throw "this run's browser has no DevTools port yet" }
  $all = Invoke-RestMethod -TimeoutSec 10 "http://127.0.0.1:$port/json/list"
  @($all | ForEach-Object { $_ })
}

function Cdp-Command([string]$method, $params, [string]$match = 'chrome://ardia/', [switch]$NoReply) {
  $targets = Cdp-List
  $target = $targets | Where-Object { $_.url -like "$match*" } | Select-Object -First 1
  if (-not $target) { return $null }
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $deadline = New-Object Threading.CancellationTokenSource 15000
  if (-not $ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, $deadline.Token).Wait(15000)) { $ws.Dispose(); throw "CDP connect timed out" }
  $body = @{ id = 1; method = $method; params = $params } | ConvertTo-Json -Depth 6 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  if (-not $ws.SendAsync([ArraySegment[byte]]$bytes, 'Text', $true, $deadline.Token).Wait(15000)) { $ws.Dispose(); throw "CDP send timed out" }
  if ($NoReply) { $ws.CloseOutputAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, '', $deadline.Token).Wait(3000) | Out-Null; $ws.Dispose(); return $null }
  $buffer = New-Object byte[] 1048576
  $text = ''
  do {
    $receive = $ws.ReceiveAsync([ArraySegment[byte]]$buffer, $deadline.Token)
    if (-not $receive.Wait(15000)) { $ws.Dispose(); throw "CDP reply timed out" }
    $r = $receive.Result
    $text += [Text.Encoding]::UTF8.GetString($buffer, 0, $r.Count)
  } while (-not $r.EndOfMessage)
  $ws.Dispose()
  ($text | ConvertFrom-Json).result
}

function Cdp-Eval([string]$expression, [string]$match = 'chrome://ardia/') {
  $result = Cdp-Command 'Runtime.evaluate' @{ expression = $expression; returnByValue = $true; awaitPromise = $true } $match
  if ($result) { $result.result.value } else { $null }
}

$App = if ($env:PILOT_APP) { $env:PILOT_APP } else { 'C:\pilot\app' }
$RunsRoot = if ($env:PILOT_RUNS) { $env:PILOT_RUNS } else { 'C:\pilot\runs' }
$Proof = if ($env:PILOT_PROOF) { $env:PILOT_PROOF } else { 'C:\pilot\proof' }
$Launcher = 'chrome.exe'
$RunRoot = $null
$Data = $null
$Port = 0
$PortOwner = 0
New-Item -ItemType Directory -Force $Proof, $RunsRoot | Out-Null

function New-PilotRun {
  $id = [guid]::NewGuid().ToString('N')
  $root = Join-Path $RunsRoot $id
  New-Item -ItemType Directory $root | Out-Null
  Set-Content -LiteralPath (Join-Path $root '.pilot-run') $id -NoNewline
  $script:RunRoot = $root
  $script:Data = Join-Path $root 'data'
  New-Item -ItemType Directory $script:Data | Out-Null
  $root
}

function Remove-PilotRun([string]$root) {
  $marker = Join-Path $root '.pilot-run'
  if (-not (Test-Path -LiteralPath $marker)) { throw "refusing to delete ${root}: it has no .pilot-run marker" }
  $id = Get-Content -LiteralPath $marker -Raw
  if ($root -ne (Join-Path $RunsRoot $id)) { throw "refusing to delete ${root}: its marker names run $id" }
  Get-ChildItem -LiteralPath $root -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue |
    Sort-Object { $_.FullName.Length } -Descending |
    ForEach-Object { if ($_.PSIsContainer) { cmd /c rmdir "$($_.FullName)" | Out-Null } else { Remove-Item -LiteralPath $_.FullName -Force } }
  Remove-Item -LiteralPath $root -Recurse -Force
}

function Start-Shell([switch]$Fresh, [string[]]$Extra = @()) {
  if ($Fresh -or -not $script:Data) { New-PilotRun | Out-Null }
  $env:ARDIA_DATA_DIR = $script:Data
  $env:ARDIA_REMOTE_DEBUGGING_PORT = '0'
  $script:Port = 0
  $script:PortOwner = 0
  Remove-Item -LiteralPath (Join-Path $script:Data 'Chromium\DevToolsActivePort') -Force -ErrorAction SilentlyContinue
  $arguments = @('--ardia-shell=webui', '--enable-logging', '--v=0') + $Extra
  $p = Start-Process (Join-Path $App $script:Launcher) -ArgumentList (Join-Arguments $arguments) -PassThru
  [Pilot]::Roots.Add($p.Id) | Out-Null
  $p
}

function Find-Launcher([string]$folder) {
  foreach ($name in 'chrome.exe', 'Ardia.exe') { if (Test-Path -LiteralPath (Join-Path $folder $name) -PathType Leaf) { return $name } }
  'chrome.exe'
}

function Use-App([string]$folder) {
  $script:App = $folder.TrimEnd('\')
  $script:Launcher = Find-Launcher $script:App
  [Pilot]::AppDir = $script:App + '\'
  $script:Port = 0
  $script:PortOwner = 0
}

Use-App $App

function Window-Identity([string]$match = 'chrome://ardia/') {
  $answer = Cdp-Eval '__ardiaHost.invoke("ArdiaShell.windowIdentity", {}).then(r => JSON.stringify(r === undefined ? null : r), e => JSON.stringify({ error: String(e && e.message || e) }))' $match
  if ($answer) { $answer | ConvertFrom-Json } else { $null }
}

function Is-Window([object]$identity, [string]$windowId = 'main') {
  [bool]($identity -and ($identity.windowId -is [string]) -and ($identity.windowId -ceq $windowId) -and ("$($identity.rendererGeneration)" -match '^[1-9]\d{0,19}$'))
}

function Identity-Text([object]$identity) { if ($null -eq $identity) { 'no answer' } else { $identity | ConvertTo-Json -Compress } }

function App-Processes {
  $folder = $App.TrimEnd('\') + '\'
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($folder, [StringComparison]::OrdinalIgnoreCase) })
}

function Engine-Processes { @(Get-Process chrome, Ardia -ErrorAction SilentlyContinue | Where-Object { [Pilot]::IsTracked($_.Id) }) }

function Stop-Engine {
  Engine-Processes | Stop-Process -Force -ErrorAction SilentlyContinue
  Wait-Until { (Engine-Processes).Count -eq 0 } 15 'the engine processes to exit' -NoThrow | Out-Null
}

function Start-Recording([string]$name, [int]$seconds) {
  Start-Process C:\tools\ffmpeg.exe -ArgumentList @('-hide_banner', '-loglevel', 'error', '-y', '-f', 'gdigrab', '-framerate', '15', '-draw_mouse', '1', '-i', 'desktop', '-t', "$seconds", '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', "$Proof\$name.mp4") -PassThru -WindowStyle Hidden
}

function Shell-Rect($h) { [Pilot]::Frame($h) }

