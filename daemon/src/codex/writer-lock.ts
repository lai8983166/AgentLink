import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonError } from "./bridge";

/** IPC only finds Desktop/VS Code owners. Also check OS handles for CLI writers. */
export async function assertNoThreadWriter(threadId: string, codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")): Promise<void> {
  if (process.platform !== "win32" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(threadId)) {
    throw new DaemonError("IPC_UNAVAILABLE", "无法核验原会话写入锁，未恢复会话");
  }
  let proc;
  try { proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-File",
    resolve(import.meta.dir, "../../../scripts/check-thread-writer.ps1"), "-ThreadId", threadId, "-CodexHome", codexHome,
  ], { stdout: "pipe", stderr: "pipe", windowsHide: true }); }
  catch { throw new DaemonError("IPC_UNAVAILABLE", "无法启动原会话写入锁核验，未恢复会话"); }
  const timer = setTimeout(() => proc.kill(), 5000);
  try {
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error("probe failed");
    const result = JSON.parse(stdout) as { ownerPids?: unknown };
    if (!Array.isArray(result.ownerPids) || !result.ownerPids.every((pid) => Number.isInteger(pid) && pid > 0)) throw new Error("invalid probe");
    if (result.ownerPids.length) throw new DaemonError("SESSION_BUSY", "原会话仍被其他入口持有，请先在那边关闭会话，或通过电脑端接管");
  } catch (e) {
    if (e instanceof DaemonError) throw e;
    throw new DaemonError("IPC_UNAVAILABLE", "无法确认原会话写入锁已释放，未恢复会话，请稍后重试");
  } finally { clearTimeout(timer); }
}
