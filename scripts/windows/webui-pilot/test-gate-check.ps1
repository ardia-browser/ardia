param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Label = 'test-gate-webui',
  [switch]$RequireRealProfile
)

$ErrorActionPreference = 'Stop'
$App = (Resolve-Path -LiteralPath $App).Path.TrimEnd('\')
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path -LiteralPath $Out).Path.TrimEnd('\')
$script:Proof = $Out
. (Join-Path $PSScriptRoot 'wait.ps1')
$ErrorActionPreference = 'Continue'

$results = New-Object System.Collections.Specialized.OrderedDictionary ([StringComparer]::Ordinal)
$skipped = [ordered]@{}
$started = Get-Date
$stepStarted = Get-Date

function Check([string]$Name, [bool]$Ok, [string]$Detail) {
  $ms = [int]((Get-Date) - $script:stepStarted).TotalMilliseconds
  $results[$Name] = @{ ok = $Ok; detail = $Detail; ms = $ms }
  Log ("{0} {1} ({2} ms): {3}" -f ($(if ($Ok) { 'PASS' } else { 'FAIL' }), $Name, $ms, $Detail))
  $script:stepStarted = Get-Date
}

function Find-Launcher([string]$Folder) {
  foreach ($name in 'Ardia.exe', 'chrome.exe') {
    if (Test-Path -LiteralPath (Join-Path $Folder $name) -PathType Leaf) { return $name }
  }
  return ''
}

function Get-FolderProcesses([string]$Folder) {
  if (-not $Folder) { return @() }
  $prefix = $Folder.TrimEnd('\') + '\'
  @(Get-CimInstance Win32_Process -OperationTimeoutSec 15 -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
}

function Stop-FolderProcesses([string]$Folder) {
  if (-not $Folder) { return }
  foreach ($proc in (Get-FolderProcesses $Folder)) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Wait-Until { (Get-FolderProcesses $Folder).Count -eq 0 } 15 "processes from $Folder to exit" -NoThrow | Out-Null
}

function Stop-GateLaunch([object]$Run, [string]$AppFolder) {
  if ($Run -and -not $Run.HasExited) {
    Stop-Process -Id $Run.Id -Force -ErrorAction SilentlyContinue
    try { $Run.WaitForExit(10000) | Out-Null } catch {}
  }
  Stop-FolderProcesses $AppFolder
}

function Clear-GateEnv {
  Remove-Item Env:ARDIA_DATA_DIR, Env:ARDIA_TEST, Env:ARDIA_TRACE, Env:ARDIA_REMOTE_DEBUGGING_PORT, Env:ARDIA_BACKGROUND -ErrorAction SilentlyContinue
}

function Get-FreePorts([int]$Count) {
  $listeners = @()
  try {
    for ($i = 0; $i -lt $Count; $i++) {
      $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
      $listener.Start()
      $listeners += $listener
    }
    return @($listeners | ForEach-Object { [int]$_.LocalEndpoint.Port })
  } finally {
    foreach ($listener in $listeners) { try { $listener.Stop() } catch {} }
  }
}

function Test-PortOpen([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { return $client.ConnectAsync('127.0.0.1', $Port).Wait(1500) -and $client.Connected } catch { return $false } finally { $client.Dispose() }
}

function Start-ExtensionListener([int]$Port) {
  $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), $Port
  $listener.Start()
  return @($listener, $listener.AcceptTcpClientAsync())
}

function Remove-Junction([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return }
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    cmd /c rmdir "$Path" 2>$null | Out-Null
  }
}

function Clear-Directory([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
  Wait-Until {
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    try {
      Get-ChildItem -LiteralPath $Path -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue |
        Sort-Object { $_.FullName.Length } -Descending |
        ForEach-Object {
          if ($_.PSIsContainer) { cmd /c rmdir "$($_.FullName)" 2>$null | Out-Null }
          else { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
        }
      $rootItem = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
      if ($rootItem -and ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        cmd /c rmdir "$Path" 2>$null | Out-Null
      } else {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
      }
      -not (Test-Path -LiteralPath $Path)
    } catch { $false }
  } 15 "removing $Path" -NoThrow | Out-Null
}

$runId = [guid]::NewGuid().ToString('N')
$runsRoot = Join-Path $Out 'runs'
New-Item -ItemType Directory -Force -Path $runsRoot | Out-Null
$runs = Join-Path $runsRoot $runId
New-Item -ItemType Directory -Path $runs -ErrorAction Stop | Out-Null
Set-Content -LiteralPath (Join-Path $runs '.test-gate-run') -Value $runId -NoNewline -Encoding ascii

function Clear-OwnedRun([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
  $marker = Join-Path $Path '.test-gate-run'
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
    Log "refusing to delete ${Path}: missing .test-gate-run marker"
    return
  }
  $owner = (Get-Content -LiteralPath $marker -Raw -ErrorAction SilentlyContinue)
  if ("$owner".Trim() -ne $runId -or $Path -ne (Join-Path $runsRoot $runId)) {
    Log "refusing to delete ${Path}: marker names '$owner', not '$runId'"
    return
  }
  Clear-Directory $Path
}

function New-OwnedProfile([string]$Path) {
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $staging = Join-Path $parent ('.ardia-test-gate-staging-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $staging -ErrorAction Stop | Out-Null
  try {
    Set-Content -LiteralPath (Join-Path $staging '.ardia-test-gate-owned') -Value $runId -NoNewline -Encoding ascii
    [System.IO.Directory]::Move($staging, $Path)
  } catch {
    Clear-Directory $staging
    throw
  }
}

function Clear-OwnedProfile([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
  $marker = Join-Path $Path '.ardia-test-gate-owned'
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
    Log "refusing to delete ${Path}: missing .ardia-test-gate-owned marker"
    return
  }
  $owner = (Get-Content -LiteralPath $marker -Raw -ErrorAction SilentlyContinue)
  if ("$owner".Trim() -ne $runId) {
    Log "refusing to delete ${Path}: owned by '$owner', not '$runId'"
    return
  }
  Clear-Directory $Path
}

function Start-GateLaunch(
  [string]$AppFolder,
  [string]$CaseName,
  [string]$DataDirectory,
  [string]$TestValue,
  [string]$PortValue,
  [string[]]$Extra = @(),
  [string]$WorkingDirectory = ''
) {
  $exe = Join-Path $AppFolder (Find-Launcher $AppFolder)
  $safe = $CaseName -replace '[^A-Za-z0-9._-]', '-'
  $caseLog = Join-Path $Out "gate-$safe.log"
  Remove-Item -LiteralPath $caseLog -Force -ErrorAction SilentlyContinue
  Clear-GateEnv
  if ($DataDirectory) { $env:ARDIA_DATA_DIR = $DataDirectory }
  if ($TestValue) { $env:ARDIA_TEST = $TestValue }
  if ($PortValue) { $env:ARDIA_REMOTE_DEBUGGING_PORT = $PortValue }
  $env:ARDIA_BACKGROUND = '1'
  try {
    $params = @{
      FilePath = $exe
      ArgumentList = (Join-Arguments (@("--log-file=$caseLog") + $Extra))
      PassThru = $true
    }
    if ($WorkingDirectory) { $params.WorkingDirectory = $WorkingDirectory }
    $proc = Start-Process @params
    try { $null = $proc.Handle } catch {}
    return @($proc, $caseLog)
  } finally {
    Clear-GateEnv
  }
}

function Wait-GateLine([object]$Run, [string]$AppFolder, [string]$CaseLog, [string]$Pattern, [int]$Seconds = 45) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $CaseLog) {
      $line = Select-String -LiteralPath $CaseLog -Pattern $Pattern -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($line) { return $line }
    }
    if ($Run.HasExited -and $Run.ExitCode -ne 0 -and (Get-FolderProcesses $AppFolder).Count -eq 0) {
      if (Test-Path -LiteralPath $CaseLog) {
        return (Select-String -LiteralPath $CaseLog -Pattern $Pattern -ErrorAction SilentlyContinue | Select-Object -First 1)
      }
      return $null
    }
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $CaseLog) {
    return (Select-String -LiteralPath $CaseLog -Pattern $Pattern -ErrorAction SilentlyContinue | Select-Object -First 1)
  }
  return $null
}

function Test-ChildSwitchesStripped([string]$AppFolder, [string[]]$ForbiddenSwitches) {
  $hasRenderer = [bool](Wait-Until {
    @(Get-FolderProcesses $AppFolder | Where-Object { $_.CommandLine -match '--type=renderer(\s|$)' }).Count -ge 1
  } 20 'a renderer child process to start directly without --renderer-cmd-prefix' -NoThrow)
  $procs = @(Get-FolderProcesses $AppFolder)
  $pids = @($procs | ForEach-Object { [int]$_.ProcessId })
  $children = @($procs | Where-Object { $_.CommandLine -match '--type=' })
  $renderers = @($children | Where-Object { $_.CommandLine -match '--type=renderer(\s|$)' })
  $directRenderer = @($renderers | Where-Object { $pids -contains [int]$_.ParentProcessId }).Count -ge 1
  $cmdChildren = @(Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" -OperationTimeoutSec 15 -ErrorAction SilentlyContinue |
    Where-Object { $pids -contains [int]$_.ParentProcessId })
  $leaked = @()
  foreach ($child in $children) {
    $cmdLine = "$($child.CommandLine)"
    foreach ($switchName in $ForbiddenSwitches) {
      if ($cmdLine -match "(?:^|[\s`"])$([regex]::Escape($switchName))(?:=|[\s`"]|$)") {
        $leaked += "$($child.ProcessId):$switchName"
      }
    }
  }
  $ok = $hasRenderer -and $directRenderer -and ($cmdChildren.Count -eq 0) -and ($leaked.Count -eq 0)
  $detail = "children=$($children.Count) renderers=$($renderers.Count) directRenderer=$directRenderer cmdChildren=$($cmdChildren.Count) leaked=[$($leaked -join ', ')]"
  return @{ ok = $ok; detail = $detail }
}

function New-ScratchDir([string]$Name) {
  $dir = Join-Path $runs $Name
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return $dir
}

function Invoke-CorsProbe([string]$AppFolder, [string]$DataDirectory, [string]$CaseName, [int]$CdpPort = 0) {
  $safe = $CaseName -replace '[^A-Za-z0-9._-]', '-'
  $probeDir = New-ScratchDir "cors-$safe"
  $readyFile = Join-Path $probeDir 'ready.json'
  $resultFile = Join-Path $probeDir 'result.txt'
  $probeScript = Join-Path $PSScriptRoot 'cors-probe.mjs'
  $nodeProc = Start-Process -FilePath 'node' -ArgumentList (Join-Arguments @($probeScript, $readyFile, $resultFile)) -PassThru -WindowStyle Hidden
  $handoff = $null
  try {
    $ready = Wait-Until {
      if (Test-Path -LiteralPath $readyFile) {
        $raw = Get-Content -LiteralPath $readyFile -Raw -ErrorAction SilentlyContinue
        if ($raw) { return ($raw | ConvertFrom-Json) }
      }
      $null
    } 15 'the CORS probe server to bind' -NoThrow
    if (-not $ready -or -not $ready.probeUrl) { return 'server-failed' }
    if ($CdpPort -gt 0) {
      try {
        Invoke-RestMethod -Method Put -Uri ("http://127.0.0.1:$CdpPort/json/new?" + $ready.probeUrl) -TimeoutSec 10 | Out-Null
      } catch {
        return 'cdp-new-failed'
      }
      $state = Wait-Until {
        if (Test-Path -LiteralPath $resultFile) {
          $text = Get-Content -LiteralPath $resultFile -Raw -ErrorAction SilentlyContinue
          if ($text) { return $text.Trim() }
        }
        $null
      } 20 "the CORS probe result for $CaseName" -NoThrow
      if ($state) { return $state }
      return 'timeout'
    }
    $profileRoot = if ($DataDirectory) { $DataDirectory } else { $realWebUI }
    $userDataDir = Join-Path $profileRoot 'Chromium'
    $exe = Join-Path $AppFolder (Find-Launcher $AppFolder)
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      Clear-GateEnv
      if ($DataDirectory) { $env:ARDIA_DATA_DIR = $DataDirectory }
      $env:ARDIA_BACKGROUND = '1'
      try {
        $handoff = Start-Process -FilePath $exe -ArgumentList (Join-Arguments @('--ardia-shell=webui', "--user-data-dir=$userDataDir", '--single-argument', "$($ready.probeUrl)")) -PassThru
      } finally {
        Clear-GateEnv
      }
      try { $handoff.WaitForExit(15000) | Out-Null } catch {}
      $state = Wait-Until {
        if (Test-Path -LiteralPath $resultFile) {
          $text = Get-Content -LiteralPath $resultFile -Raw -ErrorAction SilentlyContinue
          if ($text) { return $text.Trim() }
        }
        $null
      } 10 "the CORS probe result for $CaseName (attempt $attempt)" -NoThrow
      if ($state) { return $state }
      if ($handoff -and -not $handoff.HasExited) {
        Stop-Process -Id $handoff.Id -Force -ErrorAction SilentlyContinue
      }
    }
    return 'timeout'
  } finally {
    if ($handoff -and -not $handoff.HasExited) {
      Stop-Process -Id $handoff.Id -Force -ErrorAction SilentlyContinue
    }
    if ($nodeProc -and -not $nodeProc.HasExited) {
      Stop-Process -Id $nodeProc.Id -Force -ErrorAction SilentlyContinue
      try { $nodeProc.WaitForExit(5000) | Out-Null } catch {}
    }
  }
}

function New-CallingExtension([int]$Port) {
  $folder = New-ScratchDir 'gate-extension'
  Set-Content -LiteralPath (Join-Path $folder 'manifest.json') -Encoding ascii -Value '{"name":"gate","version":"1","manifest_version":3,"permissions":["cookies"],"host_permissions":["<all_urls>"],"background":{"service_worker":"worker.js"}}'
  Set-Content -LiteralPath (Join-Path $folder 'worker.js') -Encoding ascii -Value ('fetch("http://127.0.0.1:' + $Port + '/loaded").catch(() => {});')
  return $folder
}

$savedEnv = @{
  ARDIA_DATA_DIR = $env:ARDIA_DATA_DIR
  ARDIA_TEST = $env:ARDIA_TEST
  ARDIA_TRACE = $env:ARDIA_TRACE
  ARDIA_REMOTE_DEBUGGING_PORT = $env:ARDIA_REMOTE_DEBUGGING_PORT
  ARDIA_BACKGROUND = $env:ARDIA_BACKGROUND
}

$knownLocal = [Environment]::GetFolderPath('LocalApplicationData')
$knownRoaming = [Environment]::GetFolderPath('ApplicationData')
$liveProfiles = @(
  foreach ($root in @($knownLocal, $env:LOCALAPPDATA, $knownRoaming, $env:APPDATA) | Where-Object { $_ } | Select-Object -Unique) {
    foreach ($name in 'Ardia', 'Ardia WebUI') {
      $candidate = Join-Path $root $name
      if (Test-Path -LiteralPath $candidate) { $candidate }
    }
  }
)
$realWebUI = Join-Path $knownLocal 'Ardia WebUI'
$realRnw = Join-Path $knownLocal 'Ardia'
$unmarkedApp = ''
$markedApp = ''
$gatePort, $extPort = Get-FreePorts 2
$strippedSwitchNames = @(
  '--load-extension',
  '--remote-debugging-port',
  '--remote-allow-origins',
  '--disable-web-security',
  '--enable-automation',
  '--no-sandbox',
  '--renderer-cmd-prefix'
)

function Test-GateRefused(
  [string]$Name,
  [string]$AppFolder,
  [string]$DataDirectory,
  [string]$ExpectedReasonPattern,
  [string[]]$Extra = @(),
  [string]$WorkingDirectory = '',
  [int]$ExtensionPort = 0,
  [string]$NoLocalStateIn = '',
  [switch]$CheckStrippedSwitches
) {
  $listener = $null
  $accept = $null
  if ($ExtensionPort -gt 0) {
    $listener, $accept = Start-ExtensionListener $ExtensionPort
  }
  $run, $caseLog = Start-GateLaunch $AppFolder $Name $DataDirectory 'reauth=granted' "$gatePort" $Extra $WorkingDirectory
  try {
    $line = Wait-GateLine $run $AppFolder $caseLog '^engine 0 test gate: ' 45
    if (-not $line) {
      $exitInfo = if ($run.HasExited) { "exited $($run.ExitCode)" } else { 'still running' }
      Check $Name $false "no 'engine 0 test gate:' line in $caseLog ($exitInfo)"
      return
    }
    $text = $line.Line
    $reasonOk = $text -match "not a test instance \($ExpectedReasonPattern\); ardiacore test instance: no; reauth=granted honoured: no$"
    $portClosed = Never { Test-PortOpen $gatePort } 5
    $extBlocked = $true
    if ($listener) {
      if ($accept.Wait(8000)) {
        try { $accept.Result.Dispose() } catch {}
        $extBlocked = $false
      }
    }
    $switchesResult = if ($CheckStrippedSwitches) { Test-ChildSwitchesStripped $AppFolder $strippedSwitchNames } else { @{ ok = $true; detail = '' } }
    $corsState = if ($CheckStrippedSwitches) { Invoke-CorsProbe $AppFolder $DataDirectory $Name } else { '' }
    $corsOk = (-not $CheckStrippedSwitches) -or ($corsState -eq 'blocked')
    $noLocalState = (-not $NoLocalStateIn) -or (-not (Test-Path -LiteralPath (Join-Path $NoLocalStateIn 'Local State')))
    $ok = $reasonOk -and $portClosed -and $extBlocked -and $switchesResult.ok -and $corsOk -and $noLocalState
    $detail = "$text; port $gatePort closed=$portClosed"
    if ($listener) { $detail += "; extension blocked=$extBlocked" }
    if ($CheckStrippedSwitches) { $detail += "; stripped($($switchesResult.ok)): $($switchesResult.detail); corsProbe=$corsState" }
    if ($NoLocalStateIn) { $detail += "; no Local State in $NoLocalStateIn=$noLocalState" }
    Check $Name $ok $detail
  } finally {
    Stop-GateLaunch $run $AppFolder
    if ($listener) { try { $listener.Stop() } catch {} }
  }
}

function Test-EarlyRefusal(
  [string]$Name,
  [string]$AppFolder,
  [string]$DataDirectory,
  [string[]]$Extra = @(),
  [string]$UntouchedPath = '',
  [string]$WorkingDirectory = ''
) {
  $run, $caseLog = Start-GateLaunch $AppFolder $Name $DataDirectory 'reauth=granted' "$gatePort" $Extra $WorkingDirectory
  try {
    $exited = $run.WaitForExit(20000)
    $exitCode = if ($exited) { $run.ExitCode } else { -1 }
    $noProcesses = [bool](Wait-Until { (Get-FolderProcesses $AppFolder).Count -eq 0 } 10 'the refused launch to leave no process' -NoThrow)
    $portClosed = -not (Test-PortOpen $gatePort)
    $untouched = (-not $UntouchedPath) -or (-not (Test-Path -LiteralPath $UntouchedPath))
    $ok = $exited -and ($exitCode -eq 1) -and $noProcesses -and $portClosed -and $untouched
    $detail = "exited=$exited code=$exitCode processesGone=$noProcesses portClosed=$portClosed"
    if ($UntouchedPath) { $detail += " untouched($UntouchedPath)=$untouched" }
    Check $Name $ok $detail
  } finally {
    Stop-GateLaunch $run $AppFolder
  }
}

function Test-GateAllowed([string]$Name, [string]$AppFolder, [string]$DataDirectory) {
  $run, $caseLog = Start-GateLaunch $AppFolder $Name $DataDirectory 'reauth=granted' "$gatePort" @() ''
  try {
    $line = Wait-GateLine $run $AppFolder $caseLog '^engine 0 test gate: ' 45
    if (-not $line) {
      $exitInfo = if ($run.HasExited) { "exited $($run.ExitCode)" } else { 'still running' }
      Check $Name $false "no 'engine 0 test gate:' line in $caseLog ($exitInfo)"
      return
    }
    $text = $line.Line
    $lineOk = $text -match "a test instance; remote debugging port: $gatePort; ardiacore test instance: yes; reauth=granted honoured: yes$"
    $portOpened = [bool](Wait-Until { Test-PortOpen $gatePort } 20 "remote debugging port $gatePort" -NoThrow)
    $browser = ''
    if ($portOpened) {
      try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$gatePort/json/version" -TimeoutSec 10
        $browser = "$($version.Browser)"
      } catch {
        $browser = ''
      }
    }
    Check $Name ($lineOk -and $portOpened -and [bool]$browser) "$text; port $gatePort open=$portOpened; browser='$browser'"
  } finally {
    Stop-GateLaunch $run $AppFolder
  }
}

function Test-ExtensionAllowed([string]$Name, [string]$AppFolder, [string]$ExtensionDir, [int]$Port) {
  $listener, $accept = Start-ExtensionListener $Port
  $run, $caseLog = Start-GateLaunch $AppFolder $Name (New-ScratchDir 'gate-extension-control') '' '' @("--load-extension=$ExtensionDir") ''
  try {
    $ran = $accept.Wait(30000)
    if ($ran) { try { $accept.Result.Dispose() } catch {} }
    Check $Name $ran "extension callback on port $Port received=$ran"
  } finally {
    Stop-GateLaunch $run $AppFolder
    try { $listener.Stop() } catch {}
  }
}

function Test-SwitchPropagationControl([string]$Name, [string]$AppFolder, [string]$DataDirectory) {
  $run, $caseLog = Start-GateLaunch $AppFolder $Name $DataDirectory '' "$gatePort" @('--no-sandbox', '--enable-automation', '--disable-web-security') ''
  try {
    $shellLine = Wait-GateLine $run $AppFolder $caseLog '^engine 0 webui shell: ' 45
    $shellPage = [bool](Wait-Until {
      try {
        $pages = @(Invoke-RestMethod -Uri "http://127.0.0.1:$gatePort/json/list" -TimeoutSec 5)
        @($pages | Where-Object { $_.url -like 'chrome://ardia/*' }).Count -ge 1
      } catch {
        $false
      }
    } 20 'chrome://ardia/ shell target in switch-propagation control' -NoThrow)
    $renderer = Wait-Until {
      Get-FolderProcesses $AppFolder |
        Where-Object { $_.CommandLine -match '--type=renderer(\s|$)' } |
        Select-Object -First 1
    } 25 'a renderer child process in the positive switch-propagation control' -NoThrow
    $cmdLine = if ($renderer) { "$($renderer.CommandLine)" } else { '' }
    $hasNoSandbox = $cmdLine -match '(?:^|[\s"])--no-sandbox(?:[\s"]|$)'
    $hasAutomation = $cmdLine -match '(?:^|[\s"])--enable-automation(?:[\s"]|$)'
    $corsState = if ($renderer -and $shellLine -and $shellPage) { Invoke-CorsProbe $AppFolder $DataDirectory $Name $gatePort } else { 'shell-not-ready' }
    Check $Name ([bool]$renderer -and $hasNoSandbox -and $hasAutomation -and ($corsState -eq 'leaked')) "renderer=$([bool]$renderer) shellReady=$([bool]($shellLine -and $shellPage)) hasNoSandbox=$hasNoSandbox hasEnableAutomation=$hasAutomation corsProbe=$corsState"
  } finally {
    Stop-GateLaunch $run $AppFolder
  }
}

try {
  $launcher = Find-Launcher $App
  $hasChromeDll = Test-Path -LiteralPath (Join-Path $App 'chrome.dll') -PathType Leaf
  $hasUi = Test-Path -LiteralPath (Join-Path $App 'ardia-ui\index.html') -PathType Leaf
  $hasMarker = Test-Path -LiteralPath (Join-Path $App 'Ardia.test-build')
  $hasRnwDll = Test-Path -LiteralPath (Join-Path $App 'ArdiaApp.dll')
  Check 'unmarked-webui-build' ([bool]$launcher -and $hasChromeDll -and $hasUi -and -not $hasMarker -and -not $hasRnwDll) "launcher='$launcher' chrome.dll=$hasChromeDll ui=$hasUi marker=$hasMarker ArdiaApp.dll=$hasRnwDll"
  if (-not $results['unmarked-webui-build'].ok) { throw "$App is not an unmarked WebUI build" }

  $unmarkedApp = Join-Path $runs 'unmarked-app'
  Copy-Item -LiteralPath $App -Destination $unmarkedApp -Recurse
  $markedApp = Join-Path $runs 'marked-app'
  Copy-Item -LiteralPath $App -Destination $markedApp -Recurse
  New-Item -ItemType File -Force -Path (Join-Path $markedApp 'Ardia.test-build') | Out-Null

  $extensionDir = New-CallingExtension $extPort
  $hostileSwitches = @(
    "--load-extension=$extensionDir",
    "--remote-debugging-port=$gatePort",
    '--remote-allow-origins=*',
    '--disable-web-security',
    '--enable-automation',
    '--no-sandbox',
    '--renderer-cmd-prefix=cmd.exe'
  )

  Test-GateRefused 'unmarked-build-refused' $unmarkedApp (New-ScratchDir 'gate-unmarked') 'not a test build: no Ardia\.test-build beside the app'

  $relCwd = New-ScratchDir 'gate-relative-cwd'
  Test-EarlyRefusal 'relative-data-dir-refused' $markedApp 'gate-relative' @() (Join-Path (Join-Path $relCwd 'gate-relative') 'Chromium') $relCwd

  $scratchTarget = New-ScratchDir 'gate-scratch-target'
  $scratchJunction = Join-Path (New-ScratchDir 'gate-scratch-junction') 'profile'
  New-Item -ItemType Junction -Path $scratchJunction -Target $scratchTarget | Out-Null
  try {
    Test-GateRefused 'scratch-junction-refused' $markedApp $scratchJunction 'ARDIA_DATA_DIR or its Chromium folder is a link'
  } finally {
    Remove-Junction $scratchJunction
  }

  Test-GateRefused 'load-extension-and-debug-switches-unmarked-refused' $unmarkedApp (New-ScratchDir 'gate-unmarked-ext') 'not a test build: no Ardia\.test-build beside the app' $hostileSwitches '' $extPort '' -CheckStrippedSwitches

  $allowRealProfile = $RequireRealProfile -or ($env:GITHUB_ACTIONS -eq 'true')
  if (-not $allowRealProfile) {
    $why = 'real-profile test-gate checks run only with -RequireRealProfile or in GITHUB_ACTIONS'
    $skipped['real-profile-refusals'] = $why
    Log "SKIP real-profile-refusals: $why"
  } elseif ($liveProfiles.Count) {
    $why = "this account already has $($liveProfiles -join ', '); real-profile test-gate checks only run where none exist"
    if ($RequireRealProfile) {
      Check 'real-profile-clean' $false "-RequireRealProfile, but $why"
    } else {
      $skipped['real-profile-refusals'] = $why
      Log "SKIP real-profile-refusals: $why"
    }
  } else {
    try {
      New-OwnedProfile $realWebUI
      Test-GateRefused 'real-webui-profile-refused' $markedApp $realWebUI 'ARDIA_DATA_DIR is or overlaps the real profile folder'
    } finally {
      Clear-OwnedProfile $realWebUI
    }

    $webuiJunction = Join-Path (New-ScratchDir 'gate-webui-junction') 'profile'
    try {
      New-OwnedProfile $realWebUI
      New-Item -ItemType Junction -Path $webuiJunction -Target $realWebUI | Out-Null
      Test-GateRefused 'junction-to-real-webui-profile-refused' $markedApp $webuiJunction 'ARDIA_DATA_DIR is or overlaps the real profile folder'
    } finally {
      Remove-Junction $webuiJunction
      Clear-OwnedProfile $realWebUI
    }

    try {
      New-OwnedProfile $realRnw
      Test-EarlyRefusal 'real-rnw-profile-refused' $markedApp $realRnw @() (Join-Path $realRnw 'Chromium')
    } finally {
      Clear-OwnedProfile $realRnw
    }

    $rnwJunction = Join-Path (New-ScratchDir 'gate-rnw-junction') 'profile'
    try {
      New-OwnedProfile $realRnw
      New-Item -ItemType Junction -Path $rnwJunction -Target $realRnw | Out-Null
      Test-EarlyRefusal 'junction-to-real-rnw-profile-refused' $markedApp $rnwJunction @() (Join-Path $realRnw 'Chromium')
    } finally {
      Remove-Junction $rnwJunction
      Clear-OwnedProfile $realRnw
    }

    try {
      New-OwnedProfile $realWebUI
      Test-GateRefused 'empty-type-on-real-webui-profile-refused' $markedApp '' 'no scratch ARDIA_DATA_DIR' @('--type=', "--user-data-dir=$(Join-Path $realWebUI 'Chromium')", "--remote-debugging-port=$gatePort", '--remote-allow-origins=*')
    } finally {
      Clear-OwnedProfile $realWebUI
    }

    try {
      New-OwnedProfile $realRnw
      $rnwUserData = Join-Path $realRnw 'User Data'
      New-Item -ItemType Directory -Path $rnwUserData -ErrorAction Stop | Out-Null
      Test-EarlyRefusal 'other-user-data-dir-to-rnw-refused' $markedApp (New-ScratchDir 'gate-other-rnw') @("--user-data-dir=$rnwUserData") (Join-Path $rnwUserData 'Local State')
    } finally {
      Clear-OwnedProfile $realRnw
    }

    try {
      New-OwnedProfile $realWebUI
      $otherScratch = New-ScratchDir 'gate-other-user-data'
      $otherChromium = Join-Path $otherScratch 'Chromium'
      Test-GateRefused 'other-user-data-dir-without-scratch-refused' $markedApp '' 'no scratch ARDIA_DATA_DIR' @("--user-data-dir=$otherChromium", "--remote-debugging-port=$gatePort", '--remote-allow-origins=*') '' 0 $otherChromium
    } finally {
      Clear-OwnedProfile $realWebUI
    }

    try {
      New-OwnedProfile $realWebUI
      Test-GateRefused 'load-extension-and-debug-switches-no-scratch-refused' $markedApp '' 'no scratch ARDIA_DATA_DIR' $hostileSwitches '' $extPort '' -CheckStrippedSwitches
    } finally {
      Clear-OwnedProfile $realWebUI
    }
  }

  Test-GateAllowed 'marked-scratch-test-instance-allowed' $markedApp (New-ScratchDir 'gate-allowed')
  Test-ExtensionAllowed 'load-extension-control-in-test-instance' $markedApp $extensionDir $extPort
  Test-SwitchPropagationControl 'switch-propagation-control-in-test-instance' $markedApp (New-ScratchDir 'gate-switch-control')
} catch {
  Check 'no-terminating-error' $false "$($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)"
} finally {
  if ($unmarkedApp) { Stop-FolderProcesses $unmarkedApp }
  if ($markedApp) { Stop-FolderProcesses $markedApp }
  foreach ($key in $savedEnv.Keys) {
    if ($null -eq $savedEnv[$key] -or $savedEnv[$key] -eq '') {
      Remove-Item "Env:$key" -ErrorAction SilentlyContinue
    } else {
      Set-Item "Env:$key" $savedEnv[$key]
    }
  }
  Clear-OwnedProfile $realWebUI
  Clear-OwnedProfile $realRnw
  Clear-OwnedRun $runs
}

$failed = @($results.Keys | Where-Object { -not $results[$_].ok })
$report = [ordered]@{
  label = $Label
  app = $App
  started = $started.ToUniversalTime().ToString('o')
  seconds = [Math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  passed = $results.Count - $failed.Count
  failed = $failed.Count
  checks = $results
  skipped = $skipped
}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Out "$Label-results.json") -Encoding utf8
$lines = @('### Windows WebUI test gate', '', "$($report.passed) of $($results.Count) checks passed in $($report.seconds) s.", '', '| Check | Result | ms | Detail |', '| --- | --- | --- | --- |')
foreach ($name in $results.Keys) {
  $row = $results[$name]
  $detail = ($row.detail -replace '\|', '\|' -replace '\r?\n', ' ')
  $lines += "| $name | $(if ($row.ok) { 'pass' } else { '**fail**' }) | $($row.ms) | $detail |"
}
foreach ($name in $skipped.Keys) { $lines += "| $name | skipped | 0 | $($skipped[$name] -replace '\|', '\|') |" }
$lines | Set-Content -LiteralPath (Join-Path $Out "$Label.md") -Encoding utf8
"DONE $Label, $($failed.Count) failed"
if ($failed.Count) { exit 1 }
exit 0
