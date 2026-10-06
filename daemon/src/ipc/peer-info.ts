import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 对端版本记录（任务 1.2）：桌面 IPC 握手信息落盘，供升级后比对 */
export function peerInfoPath(): string {
  return join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".agentlink", "desktop-ipc.json");
}

export function savePeerInfo(info: Record<string, unknown>): void {
  const dir = join(peerInfoPath(), "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    peerInfoPath(),
    JSON.stringify({ at: Date.now(), peer: info }, null, 2),
    "utf-8",
  );
}

export function readPeerInfo(): { at: number; peer: Record<string, unknown> } | null {
  try {
    if (!existsSync(peerInfoPath())) return null;
    return JSON.parse(readFileSync(peerInfoPath(), "utf-8"));
  } catch {
    return null;
  }
}
