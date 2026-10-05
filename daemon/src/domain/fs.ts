import { readdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { FsEntry } from "@agentlink/shared";
import { DaemonError } from "../codex/bridge";

/** 白名单目录浏览（任务 4.5）：只允许列出 allowedRoots 内的目录 */
export class FsService {
  constructor(private readonly allowedRoots: string[]) {}

  /** 规范化并校验路径：在白名单内返回绝对路径，否则抛 PATH_NOT_ALLOWED */
  resolveAllowed(p: string): string {
    const abs = resolve(p);
    const norm = abs.toLowerCase();
    for (const root of this.allowedRoots) {
      const r = resolve(root).toLowerCase();
      if (norm === r || norm.startsWith(`${r}${sep}`) || norm.startsWith(`${r}/`)) return abs;
    }
    throw new DaemonError("PATH_NOT_ALLOWED", `路径不在白名单内: ${abs}`);
  }

  async list(p: string): Promise<{ path: string; entries: FsEntry[] }> {
    const abs = p ? this.resolveAllowed(p) : this.defaultRoot();
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      throw new DaemonError("PATH_NOT_ALLOWED", `目录不可读: ${abs}`);
    }
    const entries: FsEntry[] = [];
    for (const d of dirents) {
      if (d.name.startsWith(".") || d.name === "node_modules") continue;
      entries.push({ name: d.name, path: resolve(abs, d.name), kind: d.isDirectory() ? "dir" : "file" });
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    return { path: abs, entries };
  }

  /** 判断路径是否可创建会话（白名单内且存在） */
  async isProjectAllowed(p: string): Promise<string> {
    const abs = this.resolveAllowed(p);
    try {
      const s = await stat(abs);
      if (!s.isDirectory()) throw new DaemonError("PATH_NOT_ALLOWED", "projectPath 必须是目录");
    } catch (e) {
      if (e instanceof DaemonError) throw e;
      throw new DaemonError("PATH_NOT_ALLOWED", `目录不存在: ${abs}`);
    }
    return abs;
  }

  private defaultRoot(): string {
    const first = this.allowedRoots[0];
    if (!first) throw new DaemonError("PATH_NOT_ALLOWED", "未配置白名单根目录");
    return resolve(first);
  }
}
