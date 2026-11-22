param(
  [Parameter(Mandatory)][ValidateRange(1024,65535)][int]$RelayPort,
  [Parameter(Mandatory)][string]$RelayKeyFile,
  [string]$Launcher = (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\chatgpt-desktop.exe'),
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$key = (Get-Content -Raw -LiteralPath $RelayKeyFile).Trim()
if ($key -notmatch '^[A-Za-z0-9_-]{32,}$') { throw 'Invalid desktop relay key' }
$url = "ws://127.0.0.1:$RelayPort/$key"
$socket = [Net.WebSockets.ClientWebSocket]::new()
$timeout = [Threading.CancellationTokenSource]::new(5000)
try {
  $socket.ConnectAsync([uri]$url, $timeout.Token).GetAwaiter().GetResult() | Out-Null
} catch {
  throw 'Cannot connect to the AgentLink desktop relay'
} finally {
  $socket.Dispose()
  $timeout.Dispose()
}
if ($CheckOnly) { return }
if (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) {
  throw 'Exit the running desktop app before launching it with the shared connection'
}
$previous = $env:CODEX_APP_SERVER_WS_URL
try {
  $env:CODEX_APP_SERVER_WS_URL = $url
  Start-Process -FilePath $Launcher
} finally {
  $env:CODEX_APP_SERVER_WS_URL = $previous
}
