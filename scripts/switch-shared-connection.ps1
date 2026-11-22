param([switch]$CheckOnly, [string]$SettingsDirectory)
$ErrorActionPreference = 'Stop'
$dataDir = Join-Path $env:USERPROFILE '.agentlink'
if (!$SettingsDirectory) {
  $configs = @(Get-ChildItem -LiteralPath $dataDir -Directory -Filter 'shared-switch-backup*' |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'shared-launch.json') })
  if ($configs.Count -ne 1) { throw 'Specify the prepared configuration using -SettingsDirectory.' }
  $SettingsDirectory = $configs[0].FullName
}
$shared = Get-Content -LiteralPath (Join-Path $SettingsDirectory 'shared-launch.json') -Raw | ConvertFrom-Json
$launch = Get-Content -LiteralPath (Join-Path $SettingsDirectory 'launch.json') -Raw | ConvertFrom-Json
$endpoint = [uri]$shared.AppServerUrl
$relay = [int]$shared.DesktopRelayPort
$port = [int]$shared.ProductionPort
if ($endpoint.Scheme -ne 'ws' -or $endpoint.Host -ne '127.0.0.1' -or $endpoint.AbsolutePath -ne '/' -or
    $endpoint.UserInfo -or $endpoint.Query -or $endpoint.Fragment -or $endpoint.Port -lt 1024 -or
    $relay -lt 1024 -or $relay -gt 65535 -or $relay -in @($endpoint.Port,$port) -or $endpoint.Port -eq $port) {
  throw 'Invalid loopback endpoint or conflicting ports.'
}
foreach ($file in @($shared.CodexExecutable,$launch.DesktopLauncher,$shared.AppServerTokenFile,$shared.DesktopRelayKeyFile)) {
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Prepared executable or credential file is missing.' }
}
$token = (Get-Content -LiteralPath $shared.AppServerTokenFile -Raw).Trim()
$key = (Get-Content -LiteralPath $shared.DesktopRelayKeyFile -Raw).Trim()
if ($token -cnotmatch '^[A-Za-z0-9_-]{32,}$' -or $key -cnotmatch '^[A-Za-z0-9_-]{32,}$' -or $token -ceq $key) {
  throw 'Invalid or duplicate prepared credentials.'
}
$config = Get-Content -LiteralPath (Join-Path $dataDir 'config.toml') -Raw
if ([int]([regex]::Match($config,'(?m)^port\s*=\s*(\d+)').Groups[1].Value) -ne $port) { throw 'Production port changed.' }
$auth = @{ Authorization = 'Bearer ' + [regex]::Match($config,'(?m)^token\s*=\s*"([^"]+)"').Groups[1].Value }
$statusUrl = "http://127.0.0.1:$port/api/v1/status"
function Listener($number) {
  Get-NetTCPConnection -State Listen -LocalPort $number -ErrorAction SilentlyContinue
}
$production = Listener $port
if (!$production) { throw 'Start the existing AgentLink service first.' }
$server = Listener $endpoint.Port
if ($server) {
  $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $server.OwningProcess)
  if ($server.LocalAddress -ne '127.0.0.1' -or $owner.ExecutablePath -ne $shared.CodexExecutable -or
      !$owner.CommandLine.Contains($shared.AppServerTokenFile)) { throw 'Unexpected shared server port owner.' }
}
$existingRelay = Listener $relay
if ($existingRelay -and (!$server -or $existingRelay.LocalAddress -ne '127.0.0.1' -or
    $existingRelay.OwningProcess -ne $production.OwningProcess)) { throw 'Unexpected relay port owner.' }
$restart = Join-Path $PSScriptRoot 'restart-daemon.ps1'
$desktop = Join-Path $PSScriptRoot 'open-shared-desktop.ps1'
if ($CheckOnly) {
  if (!$existingRelay) { & $restart | Out-Null }
  Write-Output 'Preflight passed.'
  return
}
if (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) { throw 'Fully quit Codex desktop, including its tray icon, then rerun.' }
if (!$server) {
  $serverProcess = Start-Process -FilePath $shared.CodexExecutable -ArgumentList @('app-server','--listen',$endpoint.AbsoluteUri,
    '--ws-auth','capability-token','--ws-token-file',('"{0}"' -f $shared.AppServerTokenFile)) -WindowStyle Hidden -PassThru
  for ($i=0; $i -lt 30; $i++) {
    if ($serverProcess.HasExited) { throw 'Shared Codex server exited during startup.' }
    if ((Listener $endpoint.Port).OwningProcess -eq $serverProcess.Id) { break }
    Start-Sleep -Milliseconds 250
  }
  if ($i -eq 30) { throw 'Shared Codex server did not start listening.' }
}
if (!$existingRelay) {
  $env:AGENTLINK_SHARED_APP_SERVER_URL = $endpoint.AbsoluteUri
  $env:AGENTLINK_SHARED_APP_SERVER_TOKEN_FILE = $shared.AppServerTokenFile
  $env:AGENTLINK_SHARED_DESKTOP_PORT = [string]$relay
  $env:AGENTLINK_SHARED_DESKTOP_KEY_FILE = $shared.DesktopRelayKeyFile
  & $restart -Execute | Out-Null
}
for ($i=0; $i -lt 30; $i++) {
  try {
    $status = Invoke-RestMethod -Uri $statusUrl -Headers $auth -TimeoutSec 3
    $currentRelay = Listener $relay
    if ($status.connections.appServer -eq 'ready' -and $currentRelay -and
        $currentRelay.OwningProcess -eq (Listener $port).OwningProcess) { break }
  } catch { }
  Start-Sleep -Milliseconds 500
}
if ($i -eq 30) { throw 'Production AgentLink did not report a ready shared connection. Check restart.err.log.' }
$env:CODEX_APP_SERVER_FORCE_CLI = '0'
& $desktop -RelayPort $relay -RelayKeyFile $shared.DesktopRelayKeyFile -Launcher $launch.DesktopLauncher
Write-Output 'Production AgentLink ready. Desktop launch requested.'
