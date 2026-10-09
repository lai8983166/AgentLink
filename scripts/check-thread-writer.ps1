param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$')][string]$ThreadId,
  [Parameter(Mandatory=$true)][string]$CodexHome
)
$ErrorActionPreference = 'Stop'
# Read-only probe: no shutdown, lock removal, or write to Codex files.
$directory = Join-Path $CodexHome 'thread-writer-locks'
if (!(Test-Path -LiteralPath $directory -PathType Container)) { throw 'Writer lock directory unavailable' }
$path = Join-Path $directory ($ThreadId + '.lock')
if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
  '{"ownerPids":[]}'
  exit 0
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentLinkThreadWriter {
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
[PSCustomObject]@{ ownerPids = @([AgentLinkThreadWriter]::Owners($path)) } | ConvertTo-Json -Compress
