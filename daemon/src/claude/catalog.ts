import { readdir, lstat, open, realpath } from "node:fs/promises";
import { join, resolve, sep, basename } from "node:path";
import { createHash } from "node:crypto";
import type { SessionSummary, SessionDetailResponse, HistoryItem } from "@agentlink/shared";
import { DaemonError } from "../codex/bridge";
import { toolKind, toolLabel } from "./history";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = Record<string, any>;
type Entry = { path: string; stamp: string; summary: SessionSummary };
const text = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text).join("\n") : "";
function rows(value: string, id: string): Row[] {
  const result: Row[] = [];
  for (const line of value.split("\n")) {
    try {
      const row = JSON.parse(line);
      if (row && !row.isSidechain && (!row.sessionId || row.sessionId === id)) result.push(row);
    } catch { /* 尾部正在写入或边界处的不完整行留给下一次读取。 */ }
  }
  return result;
}
function metadata(data: Row[], id: string): SessionSummary {
  let cwd = "", title = "", customTitle = "", preview = "", lastActivityAt = 0;
  for (const row of data) {
    if (["user", "assistant", "system"].includes(row.type) && typeof row.cwd === "string") cwd = row.cwd;
    if (row.type === "custom-title" && typeof row.customTitle === "string") customTitle = row.customTitle;
    if ((row.type === "user" || row.type === "assistant") && !row.isMeta) {
      const value = text(row.message?.content);
      if (value && !/^\s*<(?:command-name|local-command|system-reminder)/.test(value)) {
        if (!title && row.type === "user") title = value;
        preview = value;
      }
      const at = Date.parse(row.timestamp);
      if (Number.isFinite(at)) lastActivityAt = Math.max(lastActivityAt, at);
    }
    if (row.type === "system" && row.subtype === "turn_duration") {
      const at = Date.parse(row.timestamp); if (Number.isFinite(at)) lastActivityAt = Math.max(lastActivityAt, at);
    }
  }
  return { id: "claude:" + id, agent: "claude", title: (customTitle || title || basename(cwd.replace(/\\/g, "/")) || "Claude 历史会话").slice(0, 120), cwd,
    status: "unknown", statusUpdatedAt: 0, activeElsewhere: false, activeVia: "Claude Code 历史", desktopGone: false,
    forkedFromId: null, forkedToId: null, preview: preview.slice(0, 120), lastActivityAt, approvalPolicy: "on-request", pendingApprovals: 0,
    terminal: { connected: false, inputBlocked: false, canInterrupt: false, permissionMode: null, originalSessionId: id,
      reason: "原终端尚未连接 AgentLink；请在电脑打开原会话并加载插件后控制" } };
}
function history(data: Row[]): HistoryItem[] {
  const items = new Map<string, HistoryItem>();
  for (const row of data) {
    if (!['user', 'assistant'].includes(row.type) || row.isMeta) continue;
    const at = Date.parse(row.timestamp) || 0, value = text(row.message?.content);
    const id = row.uuid || createHash("sha256").update(JSON.stringify([row.type, row.timestamp, value])).digest("hex").slice(0, 24);
    if (value && !/^\s*<(?:command-name|local-command|system-reminder)/.test(value)) items.set(id, {
      type: row.type === "user" ? "userMessage" : "agentMessage", id, text: value, at,
    });
    if (!Array.isArray(row.message?.content)) continue;
    for (const block of row.message.content) {
      if (block.type === "tool_use" && typeof block.id === "string") items.set(block.id, {
        type: "toolCall", id: block.id, kind: toolKind(block.name ?? "Tool"), target: block.name ?? "Tool", cmd: toolLabel(block.input, block.name ?? "Tool"),
        exitCode: null, durationMs: null, diffStat: null, outputTail: null, at,
      });
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const previous = items.get(block.tool_use_id);
        items.set(block.tool_use_id, { type: "toolCall", id: block.tool_use_id, kind: "tool", target: "工具结果", cmd: null, durationMs: null, diffStat: null, at,
          ...(previous?.type === "toolCall" ? previous : {}), exitCode: block.is_error ? 1 : 0, outputTail: text(block.content).slice(-8000) });
      }
    }
  }
  return [...items.values()].slice(-500);
}

/** 只读默认 Claude 配置目录的主会话 JSONL；不加载原生进程，不读取 api-request 参数。 */
export class ClaudeCatalog {
  private entries = new Map<string, Entry>();
  private scanning: Promise<SessionSummary[]> | null = null;
  private scannedAt = 0;
  private details = new Map<string, { stamp: string; history: HistoryItem[] }>();
  constructor(private root: string | false, private position: (id: string) => { latestSeq: number; serverEpoch: string } = () => ({ latestSeq: 0, serverEpoch: "claude-history" })) {}
  list(): Promise<SessionSummary[]> {
    if (!this.root) return Promise.resolve([]);
    if (this.scanning) return this.scanning;
    if (Date.now() - this.scannedAt < 5000) return Promise.resolve([...this.entries.values()].map(e => e.summary));
    this.scanning = this.scan().then(value => { this.scannedAt = Date.now(); return value; }).finally(() => { this.scanning = null; });
    return this.scanning;
  }
  private async read(path: string, bytes: number, tail = false): Promise<string> {
    const canonicalRoot = await realpath(this.root as string), canonicalFile = await realpath(path);
    if (!resolve(canonicalFile).toLowerCase().startsWith((resolve(canonicalRoot) + sep).toLowerCase())) throw new Error("Claude history path outside config directory");
    const file = await open(canonicalFile, "r");
    try {
      const stat = await file.stat(), start = tail ? Math.max(0, stat.size - bytes) : 0;
      const buffer = Buffer.alloc(Math.min(bytes, stat.size)), result = await file.read(buffer, 0, buffer.length, start);
      let value = buffer.subarray(0, result.bytesRead).toString("utf8");
      if (start > 0) value = value.slice(value.indexOf("\n") + 1);
      return value;
    } finally { await file.close(); }
  }
  private async scan(): Promise<SessionSummary[]> {
    let projects;
    try { projects = await readdir(this.root as string, { withFileTypes: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") { this.entries.clear(); this.details.clear(); return []; } throw e; }
    const files: Array<{ path: string; id: string }> = [];
    for (const dir of projects) {
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      for (const file of await readdir(join(this.root as string, dir.name), { withFileTypes: true })) {
        const id = file.name.replace(/\.jsonl$/, "");
        if (file.isFile() && file.name.endsWith(".jsonl") && UUID.test(id)) files.push({ path: join(this.root as string, dir.name, file.name), id });
      }
    }
    const next = new Map<string, Entry>(); let cursor = 0;
    const worker = async () => {
      while (cursor < files.length) {
        const { path, id } = files[cursor++]!;
        try {
          const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const stamp = stat.size + ":" + stat.mtimeMs, old = this.entries.get(id);
          if (old?.path === path && old.stamp === stamp) { next.set(id, old); continue; }
          const head = await this.read(path, 128 * 1024);
          const tail = stat.size > 128 * 1024 ? await this.read(path, 128 * 1024, true) : "";
          next.set(id, { path, stamp, summary: metadata(rows(head + "\n" + tail, id), id) });
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
    this.entries = next;
    return [...next.values()].map(e => e.summary);
  }
  async detail(id: string): Promise<SessionDetailResponse> {
    const raw = id.replace(/^claude:/, "");
    if (!UUID.test(raw)) throw new DaemonError("SESSION_NOT_FOUND", "会话不存在");
    await this.list();
    const entry = this.entries.get(raw); if (!entry) throw new DaemonError("SESSION_NOT_FOUND", "未找到本机 Claude 历史会话");
    let saved = this.details.get(raw);
    if (!saved || saved.stamp !== entry.stamp) {
      const value = await this.read(entry.path, 4 * 1024 * 1024, true);
      saved = { stamp: entry.stamp, history: history(rows(value, raw)) };
      this.details.delete(raw); this.details.set(raw, saved);
      while (this.details.size > 4) this.details.delete(this.details.keys().next().value!);
    }
    return { session: { ...entry.summary, history: saved.history, approvals: [], controlMode: "observe", tokenUsage: null }, ...this.position(id) };
  }
}
