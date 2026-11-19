$script:QuitPort = 9461
$script:QuitData = $null
$script:StillThereSeconds = 20

if (-not ('QuitPages' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
public static class QuitPages {
  static TcpListener listener;
  public static int Port;
  static readonly ConcurrentDictionary<string, int> loads = new ConcurrentDictionary<string, int>();
  static readonly ConcurrentDictionary<string, string> scripts = new ConcurrentDictionary<string, string>();
  static readonly ManualResetEvent downloadsReleased = new ManualResetEvent(false);
  static int downloadsStarted;
  public static int DownloadsStarted { get { return Volatile.Read(ref downloadsStarted); } }
  static int downloadsClosed;
  static long downloadClosedAt;
  public static int DownloadsOpen { get { return Volatile.Read(ref downloadsStarted) - Volatile.Read(ref downloadsClosed); } }
  public static string DownloadClosedAt { get { long at = Interlocked.Read(ref downloadClosedAt); return at == 0 ? "never" : new DateTime(at, DateTimeKind.Utc).ToString("HH:mm:ss.fff"); } }
  public static void ReleaseDownloads() { downloadsReleased.Set(); }
  public static void Start() {
    listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    Port = ((IPEndPoint)listener.LocalEndpoint).Port;
    var runner = new Thread(() => {
      while (true) {
        TcpClient client;
        try { client = listener.AcceptTcpClient(); } catch { return; }
        ThreadPool.QueueUserWorkItem(_ => Serve(client));
      }
    });
    runner.IsBackground = true;
    runner.Start();
  }
  public static void Stop() { ReleaseDownloads(); try { listener.Stop(); } catch { } }
  public static void SetScript(string name, string script) { scripts[name] = script; }
  public static int LoadsOf(string name) { int n; return loads.TryGetValue(name, out n) ? n : 0; }
  static void Serve(TcpClient client) {
    using (client) {
      try {
        client.ReceiveTimeout = 5000;
        var stream = client.GetStream();
        var buffer = new byte[8192];
        var request = new StringBuilder();
        while (!request.ToString().Contains("\r\n\r\n")) {
          int got = stream.Read(buffer, 0, buffer.Length);
          if (got <= 0) break;
          request.Append(Encoding.ASCII.GetString(buffer, 0, got));
        }
        string[] line = request.ToString().Split(' ');
        string path = line.Length > 1 ? line[1] : "/";
        if (path == "/download-held") {
          byte[] start = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nX-Content-Type-Options: nosniff\r\nContent-Disposition: attachment; filename=\"relaunch-download.txt\"\r\nContent-Length: 104857600\r\nConnection: keep-alive\r\n\r\n");
          stream.Write(start, 0, start.Length);
          byte[] first = Encoding.ASCII.GetBytes(new string('r', 65536));
          stream.Write(first, 0, first.Length);
          stream.Flush();
          Interlocked.Increment(ref downloadsStarted);
          byte[] more = Encoding.ASCII.GetBytes("r");
          while (!downloadsReleased.WaitOne(250)) {
            try { stream.Write(more, 0, more.Length); stream.Flush(); }
            catch {
              Interlocked.Exchange(ref downloadClosedAt, DateTime.UtcNow.Ticks);
              Interlocked.Increment(ref downloadsClosed);
              return;
            }
          }
          return;
        }
        string status = "404 Not Found";
        string body = "";
        if (path.StartsWith("/quit-") && path.EndsWith(".html")) {
          string name = path.Substring(6, path.Length - 11);
          if (line[0] == "GET") loads.AddOrUpdate(name, 1, (key, n) => n + 1);
          string script;
          scripts.TryGetValue(name, out script);
          status = "200 OK";
          body = "<!doctype html><meta charset=utf-8><title>quit " + name + "</title><p>opened during a quit: " + name + "</p><script>" + (script ?? "") + "</script>";
        }
        byte[] bytes = Encoding.UTF8.GetBytes(body);
        byte[] head = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + "\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: " + bytes.Length + "\r\nConnection: close\r\n\r\n");
        stream.Write(head, 0, head.Length);
        stream.Write(bytes, 0, bytes.Length);
      } catch { }
    }
  }
}
'@
}

function Quit-LogFiles { return @((Join-Path $script:QuitData "Logs\launch.previous.log"), (Join-Path $script:QuitData "Logs\launch.log")) }

function Quit-Log {
  $lines = @()
  foreach ($file in @(Quit-LogFiles)) { if (Test-Path -LiteralPath $file) { $lines += @(Get-Content -LiteralPath $file) } }
  return $lines
}

function Count-QuitLines([string]$pattern) { return @(@(Quit-Log) | Where-Object { $_ -match $pattern }).Count }

function Keep-QuitLog([string]$name) {
  $to = Join-Path $Out "during-quit"
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  foreach ($file in @(Quit-LogFiles)) {
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $to "$name-$(Split-Path -Leaf $file)") -Force }
  }
}

function Clear-QuitLog { foreach ($file in @(Quit-LogFiles)) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue } }

function Fail-Quit([string]$what, [string]$why) {
  Keep-QuitLog $what
  throw "$what`: $why"
}

function Wait-QuitLine([string]$pattern, [string]$what, [int]$seconds = 30) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if ((Count-QuitLines $pattern) -gt 0) { return }
    Start-Sleep -Milliseconds 25
  }
  Fail-Quit $what "the launch log never said '$pattern'"
}

function Assert-QuitLine([string]$pattern, [string]$what, [string]$why) {
  if (-not (Count-QuitLines $pattern)) { Fail-Quit $what $why }
}

function Assert-NoQuitLine([string]$pattern, [string]$what, [string]$why) {
  if (Count-QuitLines $pattern) { Fail-Quit $what $why }
}

function Count-QuitsEnded { return Count-QuitLines '^launch \d+ process ending$' }

function Assert-QuitsEnded([string]$what, [int]$count) {
  $ended = Count-QuitsEnded
  if ($ended -ne $count) { Fail-Quit $what "the launch log has $ended 'process ending' lines, not $count (each real quit writes one, and nothing else does)" }
}

function Quit-Link([string]$name, [string]$pageScript = "") {
  if ($pageScript) { [QuitPages]::SetScript($name, $pageScript) }
  return "http://127.0.0.1:$([QuitPages]::Port)/quit-$name.html"
}

function Start-WithTest([string]$test, [string[]]$arguments = @(), [switch]$Visible) {
  $saved = $env:ARDIA_TEST
  $savedBackground = $env:ARDIA_BACKGROUND
  if ($test) { $env:ARDIA_TEST = $test } else { Remove-Item -Path Env:ARDIA_TEST -ErrorAction SilentlyContinue }
  if ($Visible) { Remove-Item -Path Env:ARDIA_BACKGROUND -ErrorAction SilentlyContinue }
  try {
    $started = if ($arguments.Count) { Start-Process -FilePath $exe -ArgumentList $arguments -PassThru } else { Start-Process -FilePath $exe -PassThru }
    $null = $started.Handle
    Remember-Pid $started.Id $started
    return $started
  } finally {
    if ($null -eq $saved) { Remove-Item -Path Env:ARDIA_TEST -ErrorAction SilentlyContinue } else { $env:ARDIA_TEST = $saved }
    if ($null -eq $savedBackground) { Remove-Item -Path Env:ARDIA_BACKGROUND -ErrorAction SilentlyContinue } else { $env:ARDIA_BACKGROUND = $savedBackground }
  }
}

function Page-Targets {
  try { return @(Invoke-RestMethod -Uri "http://127.0.0.1:$($script:QuitPort)/json/list" -TimeoutSec 2 | Where-Object { $_.type -eq "page" }) } catch { return @() }
}

function Wait-QuitLinkOnce([string]$what, [string]$name, [int]$seconds = 45) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline -and -not [QuitPages]::LoadsOf($name)) { Start-Sleep -Milliseconds 100 }
  if (-not [QuitPages]::LoadsOf($name)) { Fail-Quit $what "the link the launch carried (quit-$name.html) was never loaded" }
  Start-Sleep -Seconds 2
  Assert-LoadedOnce $what $name
}

function Assert-LoadedOnce([string]$what, [string]$name) {
  $loads = [QuitPages]::LoadsOf($name)
  if ($loads -ne 1) { Fail-Quit $what "the link the launch carried (quit-$name.html) was loaded $loads times, not once" }
}

function Open-QuitInstance([string]$what, [string]$test, [switch]$Visible) {
  if (@(Browsers).Count) { throw "$what`: an Ardia was still running before this case" }
  Clear-QuitLog
  Start-WithTest $test -Visible:$Visible | Out-Null
  $shown = Wait-Window $what 120
  Wait-QuitLine "^launch \d+ process started inside the engine pid=$($shown.Pid)$" $what
  Wait-QuitLine 'events reach the UI' $what
  Start-Sleep -Milliseconds 1500
  return $shown
}

function Describe-Browsers { return (@(Browsers) | ForEach-Object { "$($_.ProcessId) ($([RelaunchCheck.Native]::AppWindows([uint32]$_.ProcessId).Count) windows)" }) -join ', ' }

function Assert-SameArdiaKeepsIt([string]$what, $old, $launched, [string]$name) {
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and -not ($launched.HasExited -and [RelaunchCheck.Native]::AppWindows([uint32]$old.Pid).Count -gt 0)) { Start-Sleep -Milliseconds 100 }
  if (-not (Get-Process -Id $old.Pid -ErrorAction SilentlyContinue)) { Fail-Quit $what "the Ardia that was closing ($($old.Pid)) ended instead of taking the launch (browsers: $(Describe-Browsers))" }
  if (-not $launched.HasExited) { Fail-Quit $what "the launch ($($launched.Id)) is still running instead of handing over to Ardia $($old.Pid)" }
  if ($launched.ExitCode -ne 0) { Fail-Quit $what "the launch ($($launched.Id)) exited with $($launched.ExitCode), not 0" }
  if (-not [RelaunchCheck.Native]::AppWindows([uint32]$old.Pid).Count) { Fail-Quit $what "Ardia $($old.Pid) took the launch but shows no window" }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline -and @(Browsers | Where-Object { [int]$_.ProcessId -ne $old.Pid }).Count) { Start-Sleep -Milliseconds 100 }
  if (@(Browsers | Where-Object { [int]$_.ProcessId -ne $old.Pid }).Count) { Fail-Quit $what "another browser runs beside Ardia $($old.Pid): $(Describe-Browsers)" }
  Wait-QuitLinkOnce $what $name
  Start-Sleep -Seconds 5
  if (-not (Get-Process -Id $old.Pid -ErrorAction SilentlyContinue) -or -not [RelaunchCheck.Native]::AppWindows([uint32]$old.Pid).Count) { Fail-Quit $what "Ardia $($old.Pid) showed the launch's window, then lost it within 5 s (browsers: $(Describe-Browsers))" }
  Assert-LoadedOnce $what $name
  Keep-QuitLog $what
  return [pscustomobject]@{ Pid = $old.Pid; Window = [RelaunchCheck.Native]::AppWindows([uint32]$old.Pid)[0] }
}

function Assert-OneFreshArdia([string]$what, [int]$old, [string]$name, [int[]]$notThese = @()) {
  $deadline = (Get-Date).AddSeconds(75)
  $fresh = 0
  while ((Get-Date) -lt $deadline) {
    $windowed = @(Browsers | Where-Object { [RelaunchCheck.Native]::AppWindows([uint32]$_.ProcessId).Count -gt 0 })
    if ($windowed.Count -eq 1 -and (-not $old -or -not (Get-Process -Id $old -ErrorAction SilentlyContinue))) {
      $fresh = [int]$windowed[0].ProcessId
      Remember-Pid $fresh $windowed[0]
      break
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $fresh) {
    $alive = if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) { "still running" } else { "gone" }
    Fail-Quit $what "no single fresh Ardia with a window within 75 s (the closing Ardia $old is $alive; browsers: $(Describe-Browsers))"
  }
  if ($notThese -contains $fresh) { Fail-Quit $what "the window is in Ardia $fresh, a process this case expected to end" }
  Assert-OneBrowser $what
  Wait-QuitLinkOnce $what $name
  Start-Sleep -Seconds $script:StillThereSeconds
  if (-not (Get-Process -Id $fresh -ErrorAction SilentlyContinue) -or -not [RelaunchCheck.Native]::AppWindows([uint32]$fresh).Count) { Fail-Quit $what "the fresh Ardia ($fresh) was gone or windowless $($script:StillThereSeconds) s later (browsers: $(Describe-Browsers))" }
  if (@(Browsers).Count -ne 1) { Fail-Quit $what "$($script:StillThereSeconds) s later there are $(@(Browsers).Count) browsers: $(Describe-Browsers)" }
  Assert-LoadedOnce $what $name
  Keep-QuitLog $what
  return [pscustomobject]@{ Pid = $fresh; Window = [RelaunchCheck.Native]::AppWindows([uint32]$fresh)[0] }
}

function Close-QuitInstance([string]$what, $shown) {
  $ended = Count-QuitsEnded
  $windows = @([RelaunchCheck.Native]::AppWindows([uint32]$shown.Pid))
  if (-not $windows.Count) { $windows = @($shown.Window) }
  foreach ($window in $windows) { Close-Window ([pscustomobject]@{ Pid = $shown.Pid; Window = $window }) }
  try {
    Wait-Exit $shown.Pid $what | Out-Null
  } catch {
    Keep-QuitLog $what
    Fail-Quit $what "Ardia ($($shown.Pid)) was still running 60 s after its $($windows.Count) app window(s) were closed, with $(@([RelaunchCheck.Native]::AppWindows([uint32]$shown.Pid)).Count) still open"
  }
  Assert-QuitsEnded $what ($ended + 1)
  Keep-QuitLog $what
}

function Test-LaunchBeforeTheQuitBegins {
  $what = "a launch in the wait between the last window closing and the quit"
  $old = Open-QuitInstance $what "lastWindowWaitMs=4000"
  $link = Quit-Link "before"
  Close-Window $old
  Wait-QuitLine 'test: the quit waits 4000 ms after the last window closed' $what
  $launched = Start-WithTest "" @($link)
  $shown = Assert-SameArdiaKeepsIt $what $old $launched "before"
  Assert-NoQuitLine 'began \((user|update)\)' $what "a quit began although a launch came before it"
  Note "$what`: the same Ardia ($($shown.Pid)) showed a window with the link, loaded once"
  Close-QuitInstance $what $shown
}

function Read-QuitDialog {
  $file = Join-Path $script:QuitData "dialog.json"
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try { return Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } catch { return $null }
}

function Wait-QuitDialog([string]$what, [int]$processId, [int]$seconds = 15) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $asked = Read-QuitDialog
    $shown = @([RelaunchCheck.Native]::DialogWindows([uint32]$processId))
    if ($asked -and $shown.Count) { return [pscustomobject]@{ Asked = $asked; Window = $shown[0]; Pid = $processId } }
    Start-Sleep -Milliseconds 100
  }
  Fail-Quit $what "no question on screen within $seconds s (dialog.json written: $($null -ne (Read-QuitDialog)); Ardia $processId running: $($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)))"
}

function Find-QuitDialog([int]$processId, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $asked = Read-QuitDialog
    $shown = @([RelaunchCheck.Native]::DialogWindows([uint32]$processId))
    if ($asked -and $shown.Count) { return [pscustomobject]@{ Asked = $asked; Window = $shown[0]; Pid = $processId } }
    if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { return $null }
    Start-Sleep -Milliseconds 100
  }
  return $null
}

function Answer-QuitDialog($dialog, [int]$button) {
  Remove-Item -LiteralPath (Join-Path $script:QuitData "dialog.json") -Force -ErrorAction SilentlyContinue
  [RelaunchCheck.Native]::PostMessageW($dialog.Window, 0x0466, [IntPtr]$button, [IntPtr]::Zero) | Out-Null
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline -and (@([RelaunchCheck.Native]::DialogWindows([uint32]$dialog.Pid)) -contains $dialog.Window)) { Start-Sleep -Milliseconds 50 }
}

function Test-LaunchWhileTheDownloadsQuestionShows {
  $what = "a launch while the question about running downloads is on screen"
  $old = Open-QuitInstance $what "appDialog" -Visible
  $startedBefore = [QuitPages]::DownloadsStarted
  $starter = Start-WithTest "" @((Quit-Link "download" "setTimeout(() => { location.href = '/download-held'; }, 300);")) -Visible
  if (-not $starter.WaitForExit(30000) -or $starter.ExitCode -ne 0) { Fail-Quit $what "the launch that opens the download page didn't hand over and exit 0" }
  Wait-QuitLinkOnce $what "download"
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and [QuitPages]::DownloadsStarted -le $startedBefore) { Start-Sleep -Milliseconds 100 }
  if ([QuitPages]::DownloadsStarted -le $startedBefore) { Fail-Quit $what "the page never started its download" }
  Start-Sleep -Seconds 5
  if (@([RelaunchCheck.Native]::AppWindows([uint32]$old.Pid)).Count -gt 1) { Close-Window $old }
  $deadline = (Get-Date).AddSeconds(15)
  $left = @([RelaunchCheck.Native]::AppWindows([uint32]$old.Pid))
  while ((Get-Date) -lt $deadline -and $left.Count -ne 1) {
    Start-Sleep -Milliseconds 200
    $left = @([RelaunchCheck.Native]::AppWindows([uint32]$old.Pid))
  }
  if ($left.Count -ne 1) { Fail-Quit $what "15 s after closing the first window, Ardia $($old.Pid) has $($left.Count) app windows, not just the one with the download page" }
  if ([QuitPages]::DownloadsOpen -lt 1) { Fail-Quit $what "the browser dropped the held download (at $([QuitPages]::DownloadClosedAt) UTC) before the last window closed" }
  $last = $left[0]
  Remove-Item -LiteralPath (Join-Path $script:QuitData "dialog.json") -Force -ErrorAction SilentlyContinue
  $openAtClose = [QuitPages]::DownloadsOpen
  [RelaunchCheck.Native]::PostMessageW($last, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero) | Out-Null
  $question = $null
  $earlier = @()
  for ($round = 0; $round -lt 3 -and -not $question; $round++) {
    $dialog = Find-QuitDialog $old.Pid 15
    if (-not $dialog) { Fail-Quit $what "closing the last window of a shown Ardia (no ARDIA_BACKGROUND, so the app may ask) brought no question within 15 s (held downloads open when it closed: $openAtClose, now: $([QuitPages]::DownloadsOpen), last dropped at $([QuitPages]::DownloadClosedAt) UTC; Ardia $($old.Pid) running: $($null -ne (Get-Process -Id $old.Pid -ErrorAction SilentlyContinue)))" }
    if ("$($dialog.Asked.message)" -match 'downloads? in progress') { $question = $dialog; break }
    $earlier += "'$($dialog.Asked.title)'"
    Answer-QuitDialog $dialog 1001
  }
  if (-not $question) { Fail-Quit $what "closing the window never asked about the running download (asked first: $($earlier -join ', '))" }
  $link = Quit-Link "asking"
  $launched = Start-WithTest "" @($link) -Visible
  $shown = Assert-SameArdiaKeepsIt $what $old $launched "asking"
  if (-not (@([RelaunchCheck.Native]::DialogWindows([uint32]$old.Pid)) -contains $question.Window)) { Fail-Quit $what "the launch took the question about downloads off the screen" }
  Assert-NoQuitLine 'began \((user|update)\)' $what "a quit began although the question was still on screen"
  Assert-NoQuitLine 'relaunch: a launch cancels the quit' $what "the launch cancelled a quit that hadn't begun"
  $ended = Count-QuitsEnded
  Answer-QuitDialog $question 1001
  $answers = 1
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and (Get-Process -Id $old.Pid -ErrorAction SilentlyContinue)) {
    $open = @([RelaunchCheck.Native]::AppWindows([uint32]$old.Pid))
    if ($open.Count) {
      foreach ($window in $open) { Close-Window ([pscustomobject]@{ Pid = $old.Pid; Window = $window }) }
      $again = Find-QuitDialog $old.Pid 8
      if ($again) {
        if ($answers -ge 3) { Fail-Quit $what "the question about downloads came back $answers times" }
        Answer-QuitDialog $again 1001
        $answers++
      }
    }
    Start-Sleep -Milliseconds 200
  }
  Wait-Exit $old.Pid $what | Out-Null
  Assert-QuitLine 'began \(user\)' $what "answering Quit didn't start the normal quit"
  Assert-QuitLine 'the app answered yes after \d+ ms' $what "the app didn't answer the quit after the question"
  Assert-QuitsEnded $what ($ended + 1)
  Assert-LoadedOnce $what "asking"
  Assert-NoQuitLine '\[quit\] not asked on a hidden instance' $what "the shown Ardia logged itself as a hidden instance that didn't ask"
  $askedLines = @(@(Quit-Log) | Where-Object { $_ -match '\[quit\] asked: ' })
  $cancelled = @($askedLines | Where-Object { $_ -match 'answered cancel' })
  if ($cancelled.Count) { Fail-Quit $what "the log has a quit question answered cancel, which the case never gave: $($cancelled -join ' | ')" }
  $downloadAsks = @($askedLines | Where-Object { $_ -match '\[quit\] asked: 1 download in progress, warning (on|off); answered quit' })
  if ($downloadAsks.Count -ne $answers -or $askedLines.Count -ne $answers) { Fail-Quit $what "the log has $($askedLines.Count) '[quit] asked:' line(s), $($downloadAsks.Count) of them '1 download in progress ...; answered quit', not exactly one per the $answers question(s) the case answered Quit: $($askedLines -join ' | ')" }
  [QuitPages]::ReleaseDownloads()
  Keep-QuitLog $what
  $before = if ($earlier.Count) { " after $($earlier -join ', ')" } else { "" }
  Note "$what`: in a shown Ardia (no ARDIA_BACKGROUND, which answers every question unseen), the question stayed$before, the same Ardia ($($shown.Pid)) opened the link once (in Little Ardia) with no quit begun, and Quit then ended it through the normal quit with its 'process ending' ($answers download question(s) answered Quit, the last when its last window closed; the log has one '[quit] asked: 1 download in progress, ...; answered quit' line per question)"
}

function Test-HiddenQuitWithADownloadIsLogged {
  $what = "a hidden Ardia's quit with a download running"
  $old = Open-QuitInstance $what ""
  $startedBefore = [QuitPages]::DownloadsStarted
  $starter = Start-WithTest "" @((Quit-Link "hidden-download" "setTimeout(() => { location.href = '/download-held'; }, 300);"))
  if (-not $starter.WaitForExit(30000) -or $starter.ExitCode -ne 0) { Fail-Quit $what "the launch that opens the download page didn't hand over and exit 0" }
  Wait-QuitLinkOnce $what "hidden-download"
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and [QuitPages]::DownloadsStarted -le $startedBefore) { Start-Sleep -Milliseconds 100 }
  if ([QuitPages]::DownloadsStarted -le $startedBefore) { Fail-Quit $what "the page never started its download" }
  Start-Sleep -Seconds 5
  if (@([RelaunchCheck.Native]::AppWindows([uint32]$old.Pid)).Count -gt 1) { Close-Window $old }
  $deadline = (Get-Date).AddSeconds(15)
  $left = @([RelaunchCheck.Native]::AppWindows([uint32]$old.Pid))
  while ((Get-Date) -lt $deadline -and $left.Count -ne 1) {
    Start-Sleep -Milliseconds 200
    $left = @([RelaunchCheck.Native]::AppWindows([uint32]$old.Pid))
  }
  if ($left.Count -ne 1) { Fail-Quit $what "15 s after closing the first window, Ardia $($old.Pid) has $($left.Count) app windows, not just the one with the download page" }
  if ([QuitPages]::DownloadsOpen -lt 1) { Fail-Quit $what "the browser dropped the held download (at $([QuitPages]::DownloadClosedAt) UTC) before the last window closed" }
  $ended = Count-QuitsEnded
  [RelaunchCheck.Native]::PostMessageW($left[0], 0x0112, [IntPtr]0xF060, [IntPtr]::Zero) | Out-Null
  Wait-Exit $old.Pid $what | Out-Null
  Assert-QuitsEnded $what ($ended + 1)
  $notAsked = @(@(Quit-Log) | Where-Object { $_ -match '\[quit\] not asked on a hidden instance: 1 download in progress, warning (on|off)' })
  if ($notAsked.Count -ne 1) { Fail-Quit $what "the hidden Ardia's quit with a download running logged $($notAsked.Count) '[quit] not asked on a hidden instance: 1 download in progress' line(s), not one" }
  Assert-NoQuitLine '\[quit\] asked: ' $what "a hidden Ardia logged a quit question as shown"
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline -and [QuitPages]::DownloadsOpen -gt 0) { Start-Sleep -Milliseconds 200 }
  if ([QuitPages]::DownloadsOpen -gt 0) { Fail-Quit $what "the held download was still open on the page server 10 s after Ardia ended" }
  Keep-QuitLog $what
  Note "$what`: closing its last window quit it with no question, and the log says it saw the download: '$($notAsked[0] -replace '^.*\[quit\] ', '[quit] ')'"
}

function Test-LaunchAtTheQuitSeam {
  $what = "a launch whose window is still on its way when the last window's wait ends"
  $old = Open-QuitInstance $what "lastWindowWaitMs=1500,windowOpenHoldMs=3000"
  $link = Quit-Link "seam"
  Close-Window $old
  Wait-QuitLine 'test: the quit waits 1500 ms after the last window closed' $what
  $launched = Start-WithTest "" @($link)
  Wait-QuitLine 'not begun: a launch arrived after the last window closed' $what
  $shown = Assert-SameArdiaKeepsIt $what $old $launched "seam"
  Assert-NoQuitLine 'began \((user|update)\)' $what "the quit began while the launch's window was on its way"
  Note "$what`: the quit waited for the launch's window, and Ardia $($shown.Pid) kept it with the link, loaded once"
  Close-QuitInstance $what $shown
}

function Test-LaunchDuringTheQuitWait {
  $what = "a launch while the quit waits for the app's answer"
  $old = Open-QuitInstance $what "quitWaitMs=4000"
  $link = Quit-Link "wait"
  Close-Window $old
  Wait-QuitLine 'began \(user\)' $what
  $launched = Start-WithTest "" @($link)
  $shown = Assert-SameArdiaKeepsIt $what $old $launched "wait"
  Assert-QuitLine 'cancelled by a relaunch after \d+ ms' $what "the log doesn't say the launch cancelled the quit"
  Assert-QuitLine 'relaunch: a launch cancels the quit' $what "the engine doesn't say the launch cancelled the quit"
  Assert-NoQuitLine '^launch \d+ quitting$' $what "the app unloaded although the launch cancelled the quit"
  Note "$what`: the quit was cancelled and Ardia $($shown.Pid) kept running with the link, loaded once"
  Close-QuitInstance $what $shown
  Note "$what`: a later quit still ends Ardia, with its 'process ending'"
}

function Test-LaunchTakenInTheTurnOfTheAnswer {
  $what = "a launch taken just before the app's answer, reaching the app after it"
  $old = Open-QuitInstance $what "quitAnswerHoldMs=2000,handOffDeliveryHoldMs=7000"
  $link = Quit-Link "answer"
  Close-Window $old
  Wait-QuitLine 'began \(user\)' $what
  $launched = Start-WithTest "" @($link)
  Wait-QuitLine 'test: a launch this Ardia took reaches the app 7000 ms late' $what
  $shown = Assert-SameArdiaKeepsIt $what $old $launched "answer"
  Assert-QuitLine 'an answer came after its quit was cancelled or had finished; ignored' $what "the app's answer arrived between the launch and its delivery but isn't in the log as set aside"
  Assert-NoQuitLine '^launch \d+ quitting$' $what "the answer that came between the launch and its delivery ended the quit"
  Assert-NoQuitLine 'it is lost' $what "the launch reached the app after the point of no return"
  Note "$what`: the launch cancelled the quit when it was taken, so the answer that came before its delivery was set aside and Ardia $($shown.Pid) opened the link once"
  Close-QuitInstance $what $shown
}

function Assert-EndedAtOnce([string]$what, $launched, [int]$seconds, [string]$which) {
  if (-not $launched.WaitForExit($seconds * 1000)) { Fail-Quit $what "$which ($($launched.Id)) was still running $seconds s later: it waited instead of ending" }
  if ($launched.ExitCode -ne 0) { Fail-Quit $what "$which ($($launched.Id)) exited with $($launched.ExitCode), not 0" }
}

function Test-LaunchDuringAnUpdateQuit {
  $what = "launches during an update's quit"
  $old = Open-QuitInstance $what "quitWaitMs=3000,quitReason=update"
  $handed = Start-WithTest "handOffHoldMs=2500" @((Quit-Link "update-handed"))
  Wait-QuitLine "^refused \d+ pid=$($handed.Id) test: this launch waits 2500 ms" $what
  Close-Window $old
  Wait-QuitLine 'began \(update\)' $what
  $guarded = Start-WithTest "" @((Quit-Link "update-guarded"))
  Assert-EndedAtOnce $what $guarded 5 "the launch that met the update's quit at the guard"
  Assert-QuitLine "^refused \d+ pid=$($guarded.Id) launch guard: Ardia is closing for an update; this launch ends here" $what "the launch that met the update's quit didn't say why it ended"
  Assert-EndedAtOnce $what $handed 8 "the launch handed over during the update's quit"
  Assert-QuitLine "relaunch: a launch during an update's quit is taken and left for the installer" $what "the engine doesn't say it took and dropped the launch handed over during the update's quit"
  $waiting = @(Browsers | Where-Object { [int]$_.ProcessId -ne $old.Pid })
  if ($waiting.Count) { Fail-Quit $what "an Ardia is waiting beside the one quitting for an update: $(Describe-Browsers)" }
  Wait-Exit $old.Pid $what 30 | Out-Null
  Assert-NoQuitLine 'cancelled by a relaunch' $what "a launch cancelled an update's quit"
  Assert-NoQuitLine 'turned a launch away' $what "a launch during an update's quit was turned away into a waiting launch"
  $deadline = (Get-Date).AddSeconds(3)
  while ((Get-Date) -lt $deadline -and -not @(Browsers).Count) { Start-Sleep -Milliseconds 100 }
  if (@(Browsers).Count) { Fail-Quit $what "an Ardia is running after an update's quit, before any installer: $(Describe-Browsers)" }
  foreach ($name in "update-handed", "update-guarded") { if ([QuitPages]::LoadsOf($name)) { Fail-Quit $what "the link of a launch during an update's quit (quit-$name.html) was opened" } }
  Assert-QuitsEnded $what 1
  Note "$what`: both launches ended at once with 0 (one at the guard, one taken and dropped), none waited, and the quit went on for the installer to reopen Ardia"
}

function Test-LateAnswerAfterACancelledQuit {
  $what = "the app's answer to a quit a launch cancelled"
  $old = Open-QuitInstance $what "quitAnswerHoldMs=4000"
  $link = Quit-Link "late"
  Close-Window $old
  Wait-QuitLine 'began \(user\)' $what
  $secondCloseAt = (Get-Date).AddMilliseconds(1600)
  Start-WithTest "" @($link) | Out-Null
  Wait-QuitLine 'cancelled by a relaunch after \d+ ms' $what
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and -not [RelaunchCheck.Native]::AppWindows([uint32]$old.Pid).Count) { Start-Sleep -Milliseconds 100 }
  $windows = [RelaunchCheck.Native]::AppWindows([uint32]$old.Pid)
  if (-not $windows.Count) { Fail-Quit $what "Ardia $($old.Pid) showed no window after the launch cancelled its quit (browsers: $(Describe-Browsers))" }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline -and -not [QuitPages]::LoadsOf("late")) { Start-Sleep -Milliseconds 50 }
  while ((Get-Date) -lt $secondCloseAt) { Start-Sleep -Milliseconds 50 }
  Close-Window ([pscustomobject]@{ Pid = $old.Pid; Window = $windows[0] })
  Wait-Exit $old.Pid $what 45 | Out-Null
  $began = @(@(Quit-Log) | ForEach-Object { if ($_ -match '^quit (\d+) began \(user\)') { [int]$Matches[1] } })
  if ($began.Count -ge 2 -and ($began[1] - $began[0]) -le 1100) { Fail-Quit $what "the check's own timing: the second quit began $($began[1] - $began[0]) ms after the first, so the first quit's answer (held 4000 ms) could not land inside the second quit's 3000 ms wait" }
  Assert-QuitLine 'an answer (to an earlier, cancelled quit came during this one|came after its quit was cancelled or had finished); ignored' $what "the answer to the cancelled quit wasn't set aside"
  Assert-LoadedOnce $what "late"
  $outcomes = @(@(Quit-Log) | Where-Object { $_ -match '(the app answered (yes|no) after \d+ ms|no answer in \d+ ms|cancelled by a relaunch after \d+ ms)' })
  if ($outcomes.Count -ne 2) { Fail-Quit $what "expected two quits in the log (the cancelled one and the real one), found $($outcomes.Count): $($outcomes -join ' | ')" }
  if ($outcomes[1] -notmatch 'no answer in \d+ ms') { Fail-Quit $what "the second quit ended on '$($outcomes[1])', not on its own missing answer: the first quit's late answer ended it" }
  Assert-QuitsEnded $what 1
  Note "$what`: the late answer was set aside, the app stayed up, and the next quit ended Ardia on its own terms"
}

function Test-CancelWhoseWindowNeverOpens {
  $what = "a quit cancelled by a launch whose window never opens"
  $old = Open-QuitInstance $what "quitWaitMs=3000,windowOpenHoldMs=9000"
  $link = Quit-Link "nowindow"
  Close-Window $old
  Wait-QuitLine 'began \(user\)' $what
  Start-WithTest "" @($link) | Out-Null
  Wait-QuitLine 'cancelled by a relaunch after \d+ ms' $what
  Wait-QuitLine 'no window opened within 5000 ms of the launch that kept this Ardia; quitting' $what 15
  Wait-Exit $old.Pid $what 30 | Out-Null
  Assert-QuitsEnded $what 1
  $deadline = (Get-Date).AddSeconds(3)
  while ((Get-Date) -lt $deadline -and -not @(Browsers).Count) { Start-Sleep -Milliseconds 100 }
  if (@(Browsers).Count) { Fail-Quit $what "an Ardia is still running: $(Describe-Browsers)" }
  Note "$what`: 5 s after the launch, with no window, the quit began again and Ardia ended"
}

function Test-LaunchAfterThePointOfNoReturn {
  $what = "a launch after the quit's point of no return"
  $old = Open-QuitInstance $what "quitUnloadHoldMs=3000,quitFlushHoldMs=2000"
  $link = Quit-Link "after"
  Close-Window $old
  Wait-QuitLine 'test: the engine is asked to quit 3000 ms after the unload' $what
  Start-WithTest "" @($link) | Out-Null
  $shown = Assert-OneFreshArdia $what $old.Pid "after"
  Assert-QuitLine 'launch guard: waited \d+ ms for the previous Ardia on this profile to finish exiting' $what "the launch didn't wait for the closing Ardia"
  Assert-QuitsEnded $what 1
  Note "$what`: the launch waited for the closing Ardia, then one fresh Ardia ($($shown.Pid)) with the link, loaded once (opened in Little Ardia, as a single outside link is when Little Ardia is on, beside the restored window), still there $($script:StillThereSeconds) s later"
  Close-QuitInstance $what $shown
}

function Test-LaunchTurnedAwayAfterThePointOfNoReturn {
  $what = "a launch handed over after the quit's point of no return"
  $old = Open-QuitInstance $what "quitWaitMs=1500,quitUnloadHoldMs=4000"
  $link = Quit-Link "turned"
  Close-Window $old
  Wait-QuitLine 'began \(user\)' $what
  $launched = Start-WithTest "handOffHoldMs=3000" @($link)
  Wait-QuitLine 'turned a launch away' $what 30
  $shown = Assert-OneFreshArdia $what $old.Pid "turned" @($launched.Id)
  if (-not $launched.HasExited) { Fail-Quit $what "the turned-away launch ($($launched.Id)) is still running" }
  if ($launched.ExitCode -ne 0) { Fail-Quit $what "the turned-away launch exited with $($launched.ExitCode), not 0, after starting Ardia again" }
  Assert-QuitLine 'started again after the closing Ardia turned the last launch away' $what "the fresh Ardia doesn't say it was started again after being turned away"
  Assert-QuitLine "^refused \d+ pid=$($launched.Id) launch guard: the closing Ardia \(\d+\) turned this launch away" $what "the turned-away launch's lines aren't under its own 'refused' category with its pid"
  Assert-NoQuitLine '^refused .*process ending' $what "a launch that never became the browser wrote 'process ending'"
  Assert-NoQuitLine 'cancelled by a relaunch' $what "the launch reached the app before the point of no return"
  Assert-QuitsEnded $what 1
  Note "$what`: the closing Ardia turned it away, the launch waited for it to end and started itself again ($($shown.Pid)), with the link loaded once, still there $($script:StillThereSeconds) s later"
  Close-QuitInstance $what $shown
}

function Test-TurnedAwayWhosePredecessorIsGone {
  $what = "a launch turned away when the Ardia that held the profile is already gone"
  Clear-QuitLog
  $link = Quit-Link "gone"
  New-Item -ItemType Directory -Force -Path (Join-Path $script:QuitData "Chromium") | Out-Null
  $lock = [IO.File]::Open((Join-Path $script:QuitData "Chromium\lockfile"), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
  try {
    $launched = Start-WithTest "" @($link)
    Wait-QuitLine 'the Ardia that held the profile is gone; it starts again once' $what 45
  } finally {
    $lock.Dispose()
  }
  $shown = Assert-OneFreshArdia $what 0 "gone" @($launched.Id)
  if ($launched.ExitCode -ne 0) { Fail-Quit $what "the turned-away launch exited with $($launched.ExitCode), not 0, after starting Ardia again" }
  Assert-NoQuitLine 'app start failed' $what "a launch whose predecessor was gone ended in a start failure"
  Assert-QuitLine "^refused \d+ pid=$($launched.Id) launch guard: started again as Ardia $($shown.Pid)$" $what "the turned-away launch didn't say, under its own 'refused' category, which Ardia it started"
  Note "$what`: it started itself again once and opened the link, loaded once, in Ardia $($shown.Pid)"
  Close-QuitInstance $what $shown
}

function Test-HungPredecessorIsNotKilled {
  $what = "a launch that meets an Ardia too busy to answer"
  $old = Open-QuitInstance $what "quitWaitMs=1500,quitFlushHoldMs=15000"
  $oldProcess = Get-Process -Id $old.Pid
  $null = $oldProcess.Handle
  $link = Quit-Link "hung"
  Close-Window $old
  Wait-QuitLine 'began \(user\)' $what
  $launched = Start-WithTest "handOffHoldMs=9000,handOffTimeoutMs=1500" @($link)
  Wait-QuitLine 'test: the flush is held 15000 ms' $what
  $shown = Assert-OneFreshArdia $what $old.Pid "hung" @($launched.Id)
  if ($oldProcess.ExitCode -ne 0) { Fail-Quit $what "the busy Ardia ($($old.Pid)) ended with $($oldProcess.ExitCode): it was killed instead of waited for" }
  Assert-QuitsEnded $what 1
  Assert-QuitLine "^refused \d+ pid=$($launched.Id) launch guard: the closing Ardia \(\d+\) turned this launch away" $what "the launch didn't wait for the busy Ardia as a turned-away launch"
  Assert-NoQuitLine 'relaunch: turned a launch away' $what "the busy Ardia answered the launch, so the hung path wasn't taken"
  Note "$what`: Chromium's hand-off timed out, the busy Ardia ($($old.Pid)) wasn't killed and finished its flush, and the launch started Ardia again ($($shown.Pid)) with the link loaded once"
  Close-QuitInstance $what $shown
}

function Invoke-PageCommands([string]$socketUrl, [object[]]$commands) {
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $none = [Threading.CancellationToken]::None
  if (-not $socket.ConnectAsync([Uri]$socketUrl, $none).Wait(5000)) { throw "the page's DevTools socket didn't open" }
  try {
    $answers = @()
    $id = 0
    foreach ($command in $commands) {
      $id++
      $bytes = [Text.Encoding]::UTF8.GetBytes((@{ id = $id; method = $command.method; params = $command.params } | ConvertTo-Json -Depth 8 -Compress))
      if (-not $socket.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $none).Wait(5000)) { throw "$($command.method) wasn't sent" }
      $deadline = (Get-Date).AddSeconds(10)
      $answer = $null
      while (-not $answer -and (Get-Date) -lt $deadline) {
        $buffer = New-Object byte[] 65536
        $text = New-Object System.Text.StringBuilder
        do {
          $receiving = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $none)
          if (-not $receiving.Wait(10000)) { throw "no answer to $($command.method)" }
          [void]$text.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $receiving.Result.Count))
        } while (-not $receiving.Result.EndOfMessage)
        $message = $text.ToString() | ConvertFrom-Json
        if ($message.id -eq $id) { $answer = $message }
      }
      if (-not $answer) { throw "no answer to $($command.method)" }
      $answers += $answer
    }
    return $answers
  } finally {
    $socket.Dispose()
  }
}

function Test-QuitWithABeforeUnloadPage {
  $what = "a quit with a page that asks before it unloads"
  $old = Open-QuitInstance $what "quitByMessage=1"
  $link = Quit-Link "unload" "addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });"
  $launched = Start-WithTest "" @($link)
  if (-not $launched.WaitForExit(30000)) { Fail-Quit $what "the launch carrying the page was still running 30 s later" }
  Wait-QuitLinkOnce $what "unload"
  $page = @(Page-Targets | Where-Object { $_.url -like "*quit-unload.html" })[0]
  if (-not $page) { Fail-Quit $what "the page with the beforeunload handler isn't listed over DevTools" }
  $press = @{ type = "mousePressed"; x = 40; y = 40; button = "left"; clickCount = 1 }
  $release = @{ type = "mouseReleased"; x = 40; y = 40; button = "left"; clickCount = 1 }
  $answers = Invoke-PageCommands $page.webSocketDebuggerUrl @(
    @{ method = "Input.dispatchMouseEvent"; params = $press },
    @{ method = "Input.dispatchMouseEvent"; params = $release },
    @{ method = "Runtime.evaluate"; params = @{ expression = "navigator.userActivation.hasBeenActive"; returnByValue = $true } }
  )
  if ($answers[2].result.result.value -ne $true) { Fail-Quit $what "the page has no user activation, so its beforeunload would never ask (answer: $($answers[2] | ConvertTo-Json -Compress -Depth 6))" }
  $message = [RelaunchCheck.Native]::RegisterWindowMessageW("ArdiaTestQuit")
  [RelaunchCheck.Native]::PostMessageW($old.Window, $message, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Wait-QuitLine 'test: asked to quit by a message' $what 10
  Wait-QuitLine '^launch \d+ quitting$' $what 10
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.Elapsed.TotalSeconds -lt 5 -and (Get-Process -Id $old.Pid -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 50 }
  if (Get-Process -Id $old.Pid -ErrorAction SilentlyContinue) { Fail-Quit $what "Ardia $($old.Pid) was still running 5 s after the app unloaded, with $([RelaunchCheck.Native]::AppWindows([uint32]$old.Pid).Count) windows: the page's beforeunload held the engine's quit" }
  Assert-QuitsEnded $what 1
  Note "$what`: Ardia ended $([int]$watch.Elapsed.TotalMilliseconds) ms after the app unloaded, without asking the page"
}

function Test-TurnedAwayLaunchKeepsItsUserDataDir {
  $what = "a launch with its own --user-data-dir turned away by a closing Ardia"
  $saved = @{ ARDIA_DATA_DIR = $env:ARDIA_DATA_DIR; ARDIA_REMOTE_DEBUGGING_PORT = $env:ARDIA_REMOTE_DEBUGGING_PORT }
  $custom = Join-Path $script:QuitData "custom-profile"
  New-Item -ItemType Directory -Force -Path $custom | Out-Null
  $key = [RelaunchCheck.Native]::ProfileKey($custom)
  $link = Quit-Link "custom"
  $closing = Start-Process -FilePath "pwsh" -ArgumentList @("-NoProfile", "-Command", "Start-Sleep -Seconds 10") -WindowStyle Hidden -PassThru
  $null = $closing.Handle
  $owner = [IO.MemoryMappedFiles.MemoryMappedFile]::CreateNew("Local\ArdiaBrowser.$key.owner", 16)
  $view = $owner.CreateViewAccessor(0, 16)
  $view.Write(0, [uint32]$closing.Id)
  $view.Write(4, [uint32]0)
  $view.Write(8, [int64]$closing.StartTime.ToFileTimeUtc())
  $created = $false
  $alive = New-Object System.Threading.Mutex($true, "Local\ArdiaBrowser.$key.alive", [ref]$created)
  $lock = [IO.File]::Open((Join-Path $custom "lockfile"), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
  $exiting = $null
  $released = $false
  $restarts = Count-LogLines 'started again after the closing Ardia turned the last launch away'
  Set-Content -LiteralPath (Join-Path $data "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM
  Remove-Item -Path Env:ARDIA_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item -Path Env:ARDIA_REMOTE_DEBUGGING_PORT -ErrorAction SilentlyContinue
  try {
    $launched = Start-WithTest "" @("--user-data-dir=$custom", $link)
    Start-Sleep -Seconds 1
    $exiting = New-Object System.Threading.EventWaitHandle($true, [System.Threading.EventResetMode]::ManualReset, "Local\ArdiaBrowser.$key.exiting")
    if (-not $closing.WaitForExit(30000)) { throw "$what`: the stand-in for the closing Ardia didn't end" }
    $lock.Dispose()
    $alive.ReleaseMutex()
    $released = $true
  } finally {
    $lock.Dispose()
    if (-not $released) { try { $alive.ReleaseMutex() } catch { } }
    $alive.Dispose()
    if ($exiting) { $exiting.Dispose() }
    $view.Dispose()
    $owner.Dispose()
    foreach ($name in $saved.Keys) { if ($null -ne $saved[$name]) { Set-Item -Path "Env:$name" -Value $saved[$name] } }
  }
  if (-not $launched.WaitForExit(60000)) { throw "$what`: the turned-away launch was still running 60 s later" }
  if ($launched.ExitCode -ne 0) { Keep-Log $what; throw "$what`: the turned-away launch exited with $($launched.ExitCode), not 0" }
  $deadline = (Get-Date).AddSeconds(90)
  $fresh = $null
  while ((Get-Date) -lt $deadline -and -not $fresh) {
    $fresh = @(Browsers | Where-Object { "$($_.CommandLine)" -like "*--user-data-dir=$custom*" -and [RelaunchCheck.Native]::AppWindows([uint32]$_.ProcessId).Count -gt 0 }) | Select-Object -First 1
    if (-not $fresh) { Start-Sleep -Milliseconds 250 }
  }
  if (-not $fresh) { Keep-Log $what; throw "$what`: no Ardia with a window on $custom within 90 s (browsers: $(Describe-Browsers))" }
  $freshId = [int]$fresh.ProcessId
  Wait-LogLine 'started again after the closing Ardia turned the last launch away' $what $restarts
  $held = $false
  try { ([IO.File]::Open((Join-Path $custom "lockfile"), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)).Dispose() } catch { $held = $true }
  if (-not $held) { Keep-Log $what; throw "$what`: the fresh Ardia ($freshId) doesn't hold $custom's lockfile" }
  Wait-QuitLinkOnce $what "custom"
  Start-Sleep -Seconds $script:StillThereSeconds
  if (-not (Get-Process -Id $freshId -ErrorAction SilentlyContinue) -or -not [RelaunchCheck.Native]::AppWindows([uint32]$freshId).Count) { Keep-Log $what; throw "$what`: the fresh Ardia ($freshId) was gone or windowless $($script:StillThereSeconds) s later" }
  Assert-LoadedOnce $what "custom"
  if (@(Browsers).Count -ne 1) { Keep-Log $what; throw "$what`: $(@(Browsers).Count) browsers at the end, not one: $(Describe-Browsers)" }
  Note "$what`: it waited for the closing Ardia, then started again ($freshId) on its own --user-data-dir, with the link loaded once, still there $($script:StillThereSeconds) s later"
  $windows = @([RelaunchCheck.Native]::AppWindows([uint32]$freshId))
  foreach ($window in $windows) { Close-Window ([pscustomobject]@{ Pid = $freshId; Window = $window }) }
  try {
    Wait-Exit $freshId $what | Out-Null
  } catch {
    Keep-Log $what
    Fail-Quit $what "Ardia ($freshId) was still running 60 s after its $($windows.Count) app window(s) were closed, with $(@([RelaunchCheck.Native]::AppWindows([uint32]$freshId)).Count) still open"
  }
}

function Test-LaunchRefusedForGood {
  $what = "a launch whose profile another program holds"
  Clear-QuitLog
  New-Item -ItemType Directory -Force -Path (Join-Path $script:QuitData "Chromium") | Out-Null
  $lock = [IO.File]::Open((Join-Path $script:QuitData "Chromium\lockfile"), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
  try {
    $launched = Start-WithTest "" @((Quit-Link "held"))
    Wait-QuitLine 'launch guard: started again as Ardia \d+' $what 45
    $said = @(@(Quit-Log) | Where-Object { $_ -match 'started again as Ardia (\d+)' }) | Select-Object -Last 1
    $again = if ("$said" -match 'started again as Ardia (\d+)') { [int]$Matches[1] } else { 0 }
    $restarted = if ($again) { Get-Process -Id $again -ErrorAction SilentlyContinue } else { $null }
    if ($restarted) { $null = $restarted.Handle }
    Wait-QuitLine 'app start failed: (.+)$' $what 45
    if ($restarted -and -not $restarted.WaitForExit(30000)) { throw "$what`: the restarted Ardia ($again) was still running 30 s after its start failed" }
  } finally {
    $lock.Dispose()
  }
  $failed = @(@(Quit-Log) | Where-Object { $_ -match 'app start failed: (.+)$' })
  Keep-QuitLog $what
  if (-not $launched.WaitForExit(10000)) { throw "$what`: the first launch ($($launched.Id)) was still running after it started Ardia again" }
  if ($launched.ExitCode -ne 0) { throw "$what`: the first launch exited with $($launched.ExitCode); it should have started itself again once and exited 0" }
  if ($restarted -and $restarted.ExitCode -eq 0) { throw "$what`: the restarted Ardia ($again) exited with 0 although it couldn't start" }
  if (@(Browsers).Count) { throw "$what`: an Ardia is running although the start failed" }
  $shown = Open-QuitInstance "a launch after a refused start" ""
  $facts = Get-Content -LiteralPath (Join-Path $script:QuitData "launch-guard.json") -Raw | ConvertFrom-Json
  if ($facts.refusedStartsBefore -ne 1) { throw "$what`: the next start counted $($facts.refusedStartsBefore) refused starts, not 1" }
  Note "$what`: it started itself again once, that start failed with the reason in the log ($($failed[0] -replace '^.*app start failed: ', '')), and the next start counted it (a hidden instance shows no start-failure message, so this case doesn't check that message)"
  Close-QuitInstance $what $shown
}

function New-QuitData {
  New-Item -ItemType Directory -Force -Path $script:QuitData | Out-Null
  Set-Content -LiteralPath (Join-Path $script:QuitData "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM
}

function Stop-QuitLeftovers {
  foreach ($process in @(Running)) { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline -and @(Running).Count) { Start-Sleep -Milliseconds 200 }
  if (@(Running).Count) { Note "launches during a quit: $(@(Running).Count) Ardia process(es) still running after the leftovers were ended" }
}

function Save-QuitDumps([string]$case) {
  $found = @(Get-ChildItem -LiteralPath $script:QuitData -Recurse -Filter "*.dmp" -ErrorAction SilentlyContinue)
  if (-not $found.Count) { return }
  $dumpCopies = Join-Path $Out "during-quit\dumps"
  New-Item -ItemType Directory -Force -Path $dumpCopies | Out-Null
  foreach ($dump in $found) {
    Copy-Item -LiteralPath $dump.FullName -Destination (Join-Path $dumpCopies "$case-$($dump.Directory.Name)-$($dump.Name)") -Force
    $script:QuitDumps += "$case`: $($dump.FullName.Substring($script:QuitData.Length))"
  }
}

function Test-LaunchesDuringQuit {
  $script:QuitData = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($Out))) ("relaunch-during-quit-" + [guid]::NewGuid().ToString("N").Substring(0, 8))))
  $marker = Join-Path $folder "Ardia.test-build"
  $saved = @{ ARDIA_DATA_DIR = $env:ARDIA_DATA_DIR; ARDIA_TEST = $env:ARDIA_TEST; ARDIA_REMOTE_DEBUGGING_PORT = $env:ARDIA_REMOTE_DEBUGGING_PORT }
  Set-Content -LiteralPath $marker -Value "relaunch-check" -Encoding ascii
  $env:ARDIA_DATA_DIR = $script:QuitData
  Remove-Item -Path Env:ARDIA_TEST -ErrorAction SilentlyContinue
  $env:ARDIA_REMOTE_DEBUGGING_PORT = "$($script:QuitPort)"
  $cases = @(
    "Test-LaunchBeforeTheQuitBegins",
    "Test-LaunchAtTheQuitSeam",
    "Test-LaunchDuringTheQuitWait",
    "Test-LaunchTakenInTheTurnOfTheAnswer",
    "Test-LaunchDuringAnUpdateQuit",
    "Test-LateAnswerAfterACancelledQuit",
    "Test-CancelWhoseWindowNeverOpens",
    "Test-LaunchAfterThePointOfNoReturn",
    "Test-LaunchTurnedAwayAfterThePointOfNoReturn",
    "Test-HungPredecessorIsNotKilled",
    "Test-TurnedAwayWhosePredecessorIsGone",
    "Test-QuitWithABeforeUnloadPage",
    "Test-TurnedAwayLaunchKeepsItsUserDataDir",
    "Test-LaunchRefusedForGood",
    "Test-HiddenQuitWithADownloadIsLogged",
    "Test-LaunchWhileTheDownloadsQuestionShows"
  )
  $script:QuitFailures = @()
  [QuitPages]::Start()
  $watch = [Diagnostics.Stopwatch]::StartNew()
  try {
    foreach ($case in $cases) {
      Stop-QuitLeftovers
      Remove-Item -LiteralPath $script:QuitData -Recurse -Force -ErrorAction SilentlyContinue
      New-QuitData
      try {
        & $case
      } catch {
        $script:QuitFailures += "$case`: $($_.Exception.Message)"
        Note "FAILED $case`: $($_.Exception.Message)"
        Keep-QuitLog "$case-failed"
      } finally {
        Stop-QuitLeftovers
        Save-QuitDumps $case
      }
    }
    Note "launches during a quit (Little Ardia on, the default; hidden instances, except the downloads question, which runs shown): $($cases.Count) cases in $([int]$watch.Elapsed.TotalSeconds) s, $($script:QuitFailures.Count) failed"
  } finally {
    Keep-QuitLog "final"
    [QuitPages]::Stop()
    Stop-QuitLeftovers
    foreach ($name in $saved.Keys) {
      if ($null -eq $saved[$name]) { Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue } else { Set-Item -Path "Env:$name" -Value $saved[$name] }
    }
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:QuitData -Recurse -Force -ErrorAction SilentlyContinue
  }
}
