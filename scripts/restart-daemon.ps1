param([switch]$Execute)
$ErrorActionPreference = 'Stop'
# 默认只核验；任何核验失败均拒绝结束进程。没有 force 选项。
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$configFile = Join-Path $env:USERPROFILE '.agentlink\config.toml'
$config = Get-Content -LiteralPath $configFile -Raw
$port = [int]([regex]::Match($config, '(?m)^port\s*=\s*(\d+)').Groups[1].Value)
$token = [regex]::Match($config, '(?m)^token\s*=\s*"([^"]+)"').Groups[1].Value
if (!$port -or !$token) { throw '配置无效，拒绝重启' }
$headers = @{ Authorization = 'Bearer ' + $token }
$baseUrl = 'http://127.0.0.1:' + $port + '/api/v1/admin'
$listener = @(Get-NetTCPConnection -LocalPort $port -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
if ($listener.Count -ne 1) { throw '无法唯一确定后台进程，拒绝重启' }
$processes = @(Get-CimInstance Win32_Process)
$root = $processes | Where-Object { $_.ProcessId -eq $listener[0] }
if (!$root -or $root.Name -ne 'bun.exe' -or $root.CommandLine -notmatch 'run\s+daemon/src/index\.ts') { throw '端口持有者不是预期的 AgentLink 后台，拒绝重启' }
$bun = $root.ExecutablePath
if (!$bun -or !(Test-Path -LiteralPath $bun -PathType Leaf)) { throw '无法定位 Bun 可执行文件，拒绝重启' }
$targets = @($root)
do {
  $before = $targets.Count
  $ids = @($targets | ForEach-Object { $_.ProcessId })
  $targets += @($processes | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids })
} while ($targets.Count -gt $before)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentLinkWriterLocks {
 [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME started; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProcessInfo {
  public UniqueProcess process;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string appName;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string serviceName;
  public uint type; public uint status; public uint sessionId;
  [MarshalAs(UnmanagedType.Bool)] public bool restartable;
 }
 [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, string key);
 [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint count, string[] files, uint appCount, UniqueProcess[] apps, uint svcCount, string[] services);
 [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In,Out] ProcessInfo[] list, ref uint reason);
 [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
 public static uint[] Owners(string path) {
  uint handle; int rc=RmStartSession(out handle,0,Guid.NewGuid().ToString("N")); if(rc!=0) throw new Exception("Start "+rc);
  try {
   rc=RmRegisterResources(handle,1,new[]{path},0,null,0,null); if(rc!=0) throw new Exception("Register "+rc);
   uint needed,count=0,reason=0; rc=RmGetList(handle,out needed,ref count,null,ref reason);
   if(rc==0) return new uint[0]; if(rc!=234) throw new Exception("List "+rc);
   count=needed; var info=new ProcessInfo[count]; rc=RmGetList(handle,out needed,ref count,info,ref reason); if(rc!=0) throw new Exception("List2 "+rc);
   var result=new uint[count]; for(int i=0;i<count;i++)result[i]=info[i].process.pid; return result;
  } finally { RmEndSession(handle); }
 }
}
'@
$prepared = $false
try {
  $readiness = Invoke-RestMethod -Uri ($baseUrl + '/restart-readiness') -Headers $headers -TimeoutSec 10
  if (!$readiness.safe) { throw '后台仍持有活动任务或正在发送指令，拒绝重启' }
  if ($Execute) {
    $readiness = Invoke-RestMethod -Uri ($baseUrl + '/prepare-restart') -Method Post -Headers $headers -TimeoutSec 10
    if (!$readiness.safe) { throw '准备期间出现活动任务，拒绝重启' }
    $prepared = $true
  }
  $ids = @($targets | ForEach-Object { $_.ProcessId })
  $lockDirectory = Join-Path $env:USERPROFILE '.codex\thread-writer-locks'
  if (!(Test-Path -LiteralPath $lockDirectory -PathType Container)) { throw '无法核验会话写入锁，拒绝重启' }
  $locks = @(Get-ChildItem -LiteralPath $lockDirectory -Filter '*.lock' | Where-Object { $_.Name -ne '.coordination.lock' } | ForEach-Object {
    $owners = @([AgentLinkWriterLocks]::Owners($_.FullName))
    if (@($owners | Where-Object { $_ -in $ids }).Count -gt 0) { throw ('后台仍持有会话写入锁，拒绝重启: ' + $_.BaseName) }
    [PSCustomObject]@{ threadId = $_.BaseName; ownerPids = $owners }
  })
  foreach ($target in $targets) {
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $target.ProcessId)
    if ($current -and ($current.CreationDate -ne $target.CreationDate -or $current.ParentProcessId -ne $target.ParentProcessId)) { throw '进程身份发生变化，拒绝重启' }
  }
  if ($Execute) {
    foreach ($target in $targets) { Stop-Process -Id $target.ProcessId -ErrorAction SilentlyContinue }
    Start-Process -FilePath $bun -ArgumentList 'run daemon/src/index.ts' -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:USERPROFILE '.agentlink\restart.out.log') -RedirectStandardError (Join-Path $env:USERPROFILE '.agentlink\restart.err.log')
    $prepared = $false
  }
  [PSCustomObject]@{ safe = $true; executed = [bool]$Execute; daemonPid = $root.ProcessId; locks = $locks } | ConvertTo-Json -Depth 5
} finally {
  if ($prepared) { Invoke-RestMethod -Uri ($baseUrl + '/cancel-restart') -Method Post -Headers $headers -TimeoutSec 10 | Out-Null }
}
