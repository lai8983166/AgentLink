import { Database } from "bun:sqlite";
import { dirname, basename } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CLAUDE_PREFIX, ClaudeExchange, type ClaudeEvent, type ClaudeCommand, type HistoryItem, type MessageReceipt,
  type PendingApprovalSnapshot, type SessionDetail, type SessionDetailResponse, type SessionStatus, type ApprovalDecision } from "@agentlink/shared";
import { DaemonError } from "../codex/bridge";
import type { SessionEventBus } from "../events/bus";
import type { FsService } from "../domain/fs";
import type { AuditStore } from "../domain/audit";
import { mergeClaudeHistory, toolKind, toolLabel } from "./history";

type Command = ClaudeCommand & { instanceId: string; state: "pending" | "queued" | "accepted" | "failed" | "uncertain"; error: string | null; updatedAt: number };
type Approval = PendingApprovalSnapshot & { state: "pending" | "submitted" | "closed"; decision?: "allow" | "deny"; instanceId: string };
type State = { session: SessionDetail; instanceId: string; retired: string[]; cursor: number; lastSeen: number; commands: Command[]; approvals: Approval[] };
type Waiter = { resolve: (value: { state: string; decision?: string }) => void; timer: ReturnType<typeof setTimeout> };
const DISCONNECTED = "Claude 终端未连接；请保持终端运行并加载 AgentLink 插件";
const BLOCKED = "终端按 Esc 停止后，Claude 暂不接受插件消息；请先在电脑终端输入一条消息";

/** 原终端拥有执行进程。手机关闭、释放连接、daemon 重启均不向该进程发停止信号。 */
export class ClaudeSessions {
  private db: Database;
  private states = new Map<string, State>();
  private waiters = new Map<string, Waiter>();
  private timer: ReturnType<typeof setInterval>;
  private draining = false;
  constructor(path: string, private bus: SessionEventBus, private fs: FsService, private audit: AuditStore, private now = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS claude_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)");
    for (const row of this.db.query("SELECT state FROM claude_sessions").all() as { state: string }[]) {
      const s = JSON.parse(row.state) as State;
      s.lastSeen = 0;
      s.session.status = "unknown";
      if (s.session.terminal) Object.assign(s.session.terminal, { connected: false, canInterrupt: false, reason: DISCONNECTED });
      // A previous permission HTTP callback cannot survive a daemon restart.
      for (const a of s.approvals) a.state = "closed";
      s.session.approvals = [];
      s.session.pendingApprovals = 0;
      this.states.set(s.session.id, s);
    }
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref?.();
  }
  owns(id: string): boolean { return id.startsWith(CLAUDE_PREFIX); }
  private get(id: string): State {
    const s = this.states.get(id);
    if (!s) throw new DaemonError("SESSION_NOT_FOUND", "未找到 Claude 终端会话");
    return s;
  }
  private save(s: State): void {
    this.db.run("INSERT INTO claude_sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state", [s.session.id, JSON.stringify(s)]);
  }
  private deferred: Array<() => void> | null = null;
  private publish(id: string, event: Parameters<SessionEventBus["publish"]>[1]): void {
    const send = () => { this.bus.publish(id, event); };
    if (this.deferred) this.deferred.push(send); else send();
  }
  private listEvent(s: State): void {
    const { history, tokenUsage, approvals, controlMode, ...summary } = s.session;
    const send = () => { this.bus.publishList({ type: "session.updated", summary: structuredClone(summary) }); };
    if (this.deferred) this.deferred.push(send); else send();
  }
  private status(s: State, status: SessionStatus, activity: string | null = null): void {
    if (s.session.status === status) return;
    s.session.status = status;
    s.session.statusUpdatedAt = this.now();
    this.publish(s.session.id, { type: "session.status", status, activity });
  }
  private syncApprovals(s: State): void {
    s.session.approvals = s.approvals.filter(a => a.state === "pending").map(({ state, decision, instanceId, ...a }) => a);
    s.session.pendingApprovals = s.session.approvals.length;
  }
  private endApproval(s: State, a: Approval, decision: "expired" | "resolved_elsewhere" | ApprovalDecision): void {
    if (a.state === "closed") return;
    a.state = "closed";
    const w = this.waiters.get(a.approvalId);
    if (w) { clearTimeout(w.timer); this.waiters.delete(a.approvalId); w.resolve({ state: "closed" }); }
    this.syncApprovals(s);
    this.publish(s.session.id, { type: "approval.resolved", approvalId: a.approvalId, decision });
  }
  sweep(): void {
    for (const s of this.states.values()) {
      if (!s.session.terminal?.connected || this.now() - s.lastSeen < 6000) continue;
      Object.assign(s.session.terminal, { connected: false, canInterrupt: false, reason: DISCONNECTED });
      this.status(s, "unknown");
      for (const a of s.approvals) this.endApproval(s, a, "expired");
      this.save(s); this.listEvent(s);
    }
  }
  list() { this.sweep(); return [...this.states.values()].map(s => {
    const { history, tokenUsage, approvals, controlMode, ...summary } = s.session;
    return summary;
  }); }
  detail(id: string): SessionDetailResponse {
    this.sweep(); const s = this.get(id);
    return { session: structuredClone(s.session), latestSeq: this.bus.latestSeq(id), serverEpoch: this.bus.epoch };
  }
  private connected(s: State): void {
    this.sweep();
    if (this.draining) throw new DaemonError("SESSION_BUSY", "后台正在安全重启，请稍后发送");
    if (!s.session.terminal?.connected) throw new DaemonError("SESSION_BUSY", DISCONNECTED);
  }
  sendMessage(id: string, text: string, clientMessageId: string = randomUUID()): MessageReceipt {
    const s = this.get(id);
    const old = s.commands.find(c => c.id === clientMessageId);
    if (old) {
      if (old.kind !== "send" || old.text !== text) throw new DaemonError("VALIDATION_ERROR", "同一消息 ID 不能用于不同内容");
      return this.receipt(old);
    }
    this.connected(s);
    if (s.session.terminal?.inputBlocked) throw new DaemonError("SESSION_BUSY", BLOCKED);
    if (s.commands.filter(c => ["pending", "queued"].includes(c.state)).length >= 32) throw new DaemonError("SESSION_BUSY", "排队消息过多，请等待终端处理");
    if (text.length > 100000) throw new DaemonError("VALIDATION_ERROR", "消息过长");
    const c: Command = { id: clientMessageId, kind: "send", text, state: "pending", instanceId: s.instanceId, error: null, updatedAt: this.now() };
    s.commands.push(c); this.save(s); this.queueEvent(s);
    return this.receipt(c);
  }
  private receipt(c: Command): MessageReceipt {
    return { clientMessageId: c.id, state: c.state === "pending" ? "queued" : c.state, updatedAt: c.updatedAt, error: c.error };
  }
  messageReceipt(id: string, messageId: string): MessageReceipt | null {
    const c = this.get(id).commands.find(c => c.id === messageId && c.kind === "send");
    return c ? this.receipt(c) : null;
  }
  async interrupt(id: string): Promise<void> {
    const s = this.get(id); this.connected(s);
    if (!s.session.terminal?.canInterrupt) throw new DaemonError("SESSION_BUSY", "尚未识别当前 Claude 轮次，无法安全停止");
    const c: Command = { id: randomUUID(), kind: "interrupt", turnId: this.activeTurn(s), instanceId: s.instanceId, state: "pending", updatedAt: this.now(), error: null };
    s.commands.push(c); this.save(s);
    const deadline = this.now() + 4000;
    while (c.state === "pending" && this.now() < deadline) await new Promise(r => setTimeout(r, 30));
    if (c.state !== "accepted") {
      if (c.state === "pending") { c.state = "uncertain"; c.error = "停止结果待确认"; this.save(s); }
      throw new DaemonError("SESSION_BUSY", c.error ?? "停止失败，请刷新核对");
    }
  }
  private activeTurns = new Map<string, string>();
  private activeTurn(s: State): string | undefined { return this.activeTurns.get(s.session.id); }
  restartReadiness() {
    const activeSessionIds = [...this.states.values()].filter(s => s.session.terminal?.connected &&
      (["running", "waiting_approval", "unknown"].includes(s.session.status) || s.commands.some(c => c.state === "pending" || c.state === "queued"))).map(s => s.session.id);
    return { safe: activeSessionIds.length === 0, activeSessionIds };
  }
  setDraining(value: boolean): void { this.draining = value; }
  private queueEvent(s: State): void {
    this.publish(s.session.id, { type: "session.queue", queued: s.commands.filter(c => c.kind === "send" && ["pending", "queued"].includes(c.state)).length });
  }
  private append(s: State, item: HistoryItem): void {
    const i = s.session.history.findIndex(h => h.id === item.id);
    if (i >= 0) s.session.history[i] = item; else s.session.history.push(item);
    s.session.history = s.session.history.slice(-500);
  }
  exchange(raw: unknown) {
    const p = ClaudeExchange.parse(raw);
    this.fs.resolveAllowed(p.cwd);
    const id = CLAUDE_PREFIX + p.sessionId;
    let s = this.states.get(id);
    if (s && s.instanceId !== p.instanceId) {
      if (s.retired.includes(p.instanceId) || this.now() - s.lastSeen < 6000) throw new DaemonError("SESSION_BUSY", "原终端实例仍在线，拒绝竞争连接");
      s.retired = [...s.retired, s.instanceId].slice(-32);
      s.instanceId = p.instanceId; s.cursor = 0;
      for (const c of s.commands) if (c.state === "pending" || c.state === "queued") { c.state = "uncertain"; c.error = "Claude 插件实例已更换，请核对原会话"; }
      for (const a of s.approvals) this.endApproval(s, a, "expired");
    }
    this.deferred = [];
    try {
    if (!s) {
      s = { instanceId: p.instanceId, retired: [], cursor: 0, lastSeen: this.now(), commands: [], approvals: [], session: {
        id, agent: "claude", title: basename(p.cwd.replace(/\\/g, "/")) || "Claude 终端", cwd: p.cwd, status: "unknown",
        activeElsewhere: false, activeVia: "Claude Code 终端", desktopGone: false, forkedFromId: null, forkedToId: null,
        preview: "", lastActivityAt: this.now(), approvalPolicy: "on-request", pendingApprovals: 0,
        history: [], tokenUsage: null, approvals: [], controlMode: "local",
      } };
      this.states.set(id, s);
      this.listEvent(s);
    }
    s.lastSeen = this.now();
    s.session.terminal = { connected: true, inputBlocked: p.inputBlocked, canInterrupt: !!p.turnId,
      reason: p.inputBlocked ? BLOCKED : p.status === "unknown" ? "原终端已连接，等待轮次状态；可发送消息" : null,
      permissionMode: p.permissionMode, originalSessionId: p.sessionId };
    if (p.turnId) this.activeTurns.set(id, p.turnId); else this.activeTurns.delete(id);
    for (const event of p.events) {
      if (event.seq <= s.cursor) continue;
      this.consume(s, event);
      s.cursor = event.seq;
    }
    this.status(s, p.status);
    this.syncApprovals(s);
    this.save(s); this.listEvent(s);
    const events = this.deferred;
    this.deferred = null;
    for (const send of events) send();
    return { ack: s.cursor, commands: s.commands.filter(c => c.instanceId === s!.instanceId && c.state === "pending").map(({ id, kind, text, turnId }) => ({ id, kind, text, turnId })) };
    } finally { this.deferred = null; }
  }
  private consume(s: State, e: ClaudeEvent): void {
    const d = e.data, id = s.session.id, at = this.now();
    const str = (key: string) => typeof d[key] === "string" ? d[key] as string : "";
    const user = (text: string, itemId: string, clientMessageId?: string) => {
      if (!text) return;
      this.append(s, { type: "userMessage", id: itemId, text, at, ...(clientMessageId ? { clientMessageId } : {}) });
      this.publish(id, { type: "user.message", itemId, text, ...(clientMessageId ? { clientMessageId } : {}) });
      s.session.preview = text.slice(0, 120); s.session.lastActivityAt = at;
    };
    switch (e.type) {
      case "user": user(str("text"), str("itemId") || `${s.instanceId}:u:${e.seq}`); break;
      case "started": this.status(s, "running"); break;
      case "text": {
        const itemId = str("itemId"); if (!itemId) break;
        const old = s.session.history.find(h => h.id === itemId && h.type === "agentMessage");
        const text = (old?.type === "agentMessage" ? old.text : "") + str("text");
        this.append(s, { type: "agentMessage", id: itemId, text: text.slice(-200000), at });
        this.publish(id, { type: "agent.message", itemId, text: text.slice(-200000) });
        s.session.lastActivityAt = at;
        break;
      }
      case "completed":
        if (!d.agentId) {
          this.status(s, d.isAborted ? "idle" : "done");
          s.session.preview = str("answer").slice(0, 120); s.session.lastActivityAt = at;
          for (const a of s.approvals) this.endApproval(s, a, "expired");
        }
        break;
      case "interrupted": this.status(s, "idle"); for (const a of s.approvals) this.endApproval(s, a, "expired"); break;
      case "failed": this.status(s, "error"); this.publish(id, { type: "error", message: str("message") || "Claude 本轮执行出错" }); break;
      case "snapshot":
        s.session.history = mergeClaudeHistory(d.messages, s.session.history, at);
        this.publish(id, { type: "history.sync" });
        break;
      case "command": {
        const c = s.commands.find(c => c.id === d.commandId && c.instanceId === s.instanceId);
        if (!c) break;
        if (d.state === "started" || d.state === "interrupted") {
          c.state = "accepted";
          if (c.kind === "send") user(c.text ?? "", c.id, c.id);
        } else if (d.state === "rejected") { c.state = "failed"; c.error = str("reason") || "Claude 拒绝了此指令"; }
        else if (d.state === "queued") c.state = "queued";
        c.updatedAt = at; this.queueEvent(s);
        break;
      }
      case "tool": {
        const name = str("name"), itemId = str("itemId"); if (!itemId) break;
        const kind = toolKind(name), cmd = toolLabel(d.input, name);
        this.append(s, { type: "toolCall", id: itemId, kind, target: name, cmd, at, exitCode: null, durationMs: null, diffStat: null, outputTail: null });
        this.publish(id, { type: "tool.started", itemId, kind, target: name, cmd }); break;
      }
      case "toolEnd": {
        const item = s.session.history.find(h => h.type === "toolCall" && h.id === d.itemId);
        if (item?.type === "toolCall") {
          item.exitCode = d.isError ? 1 : 0; item.outputTail = str("output").slice(-8000);
          this.publish(id, { type: "tool.finished", itemId: item.id, kind: item.kind, target: item.target, exitCode: item.exitCode,
            durationMs: null, diffStat: null, outputTail: item.outputTail });
        } break;
      }
      case "approval": {
        if (s.approvals.some(a => a.approvalId === d.approvalId)) break;
        const name = str("name");
        const a: Approval = { approvalId: str("approvalId"), kind: toolKind(name) === "exec" ? "command" : toolKind(name) === "fileChange" ? "fileChange" : "tool",
          command: toolLabel(d.input, name), cwd: s.session.cwd, reason: `${name} 请求授权`, availableDecisions: ["accept", "decline"], state: "pending", instanceId: s.instanceId };
        s.approvals.push(a); this.syncApprovals(s); this.status(s, "waiting_approval");
        this.publish(id, { type: "approval.request", ...this.approvalSnapshot(a) }); break;
      }
      case "approvalEnd": {
        const a = s.approvals.find(a => a.approvalId === d.approvalId);
        if (a) this.endApproval(s, a, a.decision === "allow" ? "accept" : a.decision === "deny" ? "decline" : "resolved_elsewhere");
        break;
      }
      case "gap": this.publish(id, { type: "error", message: "Claude 离线期间事件过多，已重新核对历史" }); break;
    }
  }
  private approvalSnapshot({ state, instanceId, decision, ...a }: Approval): PendingApprovalSnapshot { return a; }
  async waitApproval(rawId: string, instanceId: string, approvalId: string, signal?: AbortSignal): Promise<{ state: string; decision?: string }> {
    const s = this.get(CLAUDE_PREFIX + rawId);
    if (s.instanceId !== instanceId) return { state: "closed" };
    const a = s.approvals.find(a => a.approvalId === approvalId);
    if (!a || a.state === "closed") return { state: "closed" };
    if (a.decision) return { state: "decided", decision: a.decision };
    if (this.waiters.has(approvalId)) throw new DaemonError("SESSION_BUSY", "审批已在等待决定");
    return new Promise(resolve => {
      const finish = (value: { state: string; decision?: string }) => {
        clearTimeout(w.timer); this.waiters.delete(approvalId); signal?.removeEventListener("abort", canceled); resolve(value);
      };
      const canceled = () => finish({ state: "closed" });
      const w = { resolve: finish, timer: setTimeout(() => finish({ state: "pending" }), 20000) };
      this.waiters.set(approvalId, w);
      signal?.addEventListener("abort", canceled, { once: true });
      if (signal?.aborted) canceled();
    });
  }
  decide(id: string, approvalId: string, decision: ApprovalDecision): void {
    const s = this.get(id); this.connected(s);
    const a = s.approvals.find(a => a.approvalId === approvalId && a.instanceId === s.instanceId);
    if (!a || a.state !== "pending" || !this.waiters.has(approvalId)) throw new DaemonError("APPROVAL_EXPIRED", "此审批已在终端处理或连接已失效");
    if (decision !== "accept" && decision !== "decline") throw new DaemonError("VALIDATION_ERROR", "Claude 此请求只支持一次性批准或拒绝");
    a.decision = decision === "accept" ? "allow" : "deny"; a.state = "submitted";
    this.syncApprovals(s); this.save(s);
    this.audit.append({ at: this.now(), sessionId: id, project: s.session.cwd, kind: a.kind, command: a.command, decision, source: "claude-mobile-submitted" });
    this.waiters.get(approvalId)!.resolve({ state: "decided", decision: a.decision });
    this.publish(id, { type: "approval.resolved", approvalId, decision }); this.listEvent(s);
  }
  close(): void {
    clearInterval(this.timer);
    for (const w of [...this.waiters.values()]) w.resolve({ state: "closed" });
    this.db.close();
  }
}
