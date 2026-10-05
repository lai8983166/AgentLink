import type {
  ApprovalPolicy,
  HistoryItem,
  SessionDetail,
  SessionStatus,
  SessionSummary,
  TokenUsage,
} from "@agentlink/shared";
import { DaemonError, type CodexBridge } from "../codex/bridge";
import { historyItemFromCodexItem } from "../codex/mapper";
import type { MappedFact } from "../codex/mapper";
import type { CodexThreadInfo } from "../codex/protocol";
import type { SessionEventBus } from "../events/bus";
import type { ApprovalService } from "./approvals";
import type { FsService } from "./fs";

/** 会话注册表（任务 4.1/4.2）：状态机 + 事件发布 + 列表聚合 */

interface LiveSession {
  summary: SessionSummary;
  history: HistoryItem[];
  tokenUsage: TokenUsage | null;
  desiredPolicy: ApprovalPolicy;
  activity: string | null;
}

export class SessionRegistry {
  private live = new Map<string, LiveSession>();
  private rolloutIndex = new Map<string, SessionSummary>();
  private knownCodexThreads = new Set<string>();

  constructor(
    private readonly bridge: CodexBridge,
    private readonly bus: SessionEventBus,
    private readonly approvals: ApprovalService,
    private readonly fs: FsService,
  ) {}

  async start(): Promise<void> {
    this.bridge.onFact((f) => this.consume(f));
    this.bridge.onRestart(() => {
      // codex 重启：实时状态全丢，回读 rollout 重建
      for (const [id, s] of this.live) {
        if (s.summary.status === "running" || s.summary.status === "waiting_approval") {
          s.summary.status = "idle";
          this.bus.publish(id, { type: "session.status", status: "idle", activity: null });
        }
      }
      this.refreshRollouts().catch(() => {});
    });
    this.approvals.onPendingChange((sessionId, count) => {
      const s = this.live.get(sessionId);
      if (s && s.summary.pendingApprovals !== count) {
        s.summary.pendingApprovals = count;
        this.publishUpdated(s);
      }
    });
    await this.refreshRollouts();
  }

  /* ============ 列表 ============ */

  /** 全量列表：实时会话 + rollout 既有会话（live 优先） */
  async list(): Promise<SessionSummary[]> {
    await this.refreshRollouts();
    const out = new Map<string, SessionSummary>();
    for (const [id, s] of this.rolloutIndex) out.set(id, s);
    for (const [id, s] of this.live) out.set(id, s.summary);
    const order: Record<SessionStatus, number> = {
      waiting_approval: 0,
      running: 1,
      done: 2,
      error: 3,
      idle: 4,
    };
    return [...out.values()].sort(
      (a, b) =>
        order[a.status] - order[b.status] || b.lastActivityAt - a.lastActivityAt,
    );
  }

  private async refreshRollouts(): Promise<void> {
    let threads: CodexThreadInfo[] = [];
    try {
      threads = await this.bridge.threadList();
    } catch {
      return; // codex 未就绪时静默，等重启钩子再试
    }
    for (const t of threads) {
      this.knownCodexThreads.add(t.id);
      if (this.live.has(t.id)) continue;
      this.rolloutIndex.set(t.id, {
        id: t.id,
        title: (t.preview ?? "").slice(0, 40) || "既有会话",
        cwd: t.environments?.[0]?.cwd ?? "",
        agent: "codex",
        status: "idle",
        preview: t.preview ?? "",
        lastActivityAt: 0,
        approvalPolicy: "on-request",
        pendingApprovals: 0,
      });
    }
  }

  /* ============ 详情 ============ */

  async detail(id: string): Promise<{ session: SessionDetail; latestSeq: number }> {
    const live = this.live.get(id);
    if (live) {
      return {
        session: { ...live.summary, history: [...live.history], tokenUsage: live.tokenUsage },
        latestSeq: this.bus.latestSeq(id),
      };
    }
    // rollout 会话：按需拉历史
    const turns = await this.bridge.threadTurns(id).catch(() => null);
    if (!turns && !this.knownCodexThreads.has(id)) {
      throw new DaemonError("SESSION_NOT_FOUND", "会话不存在");
    }
    const history = this.historyFromTurns(turns);
    const base =
      this.rolloutIndex.get(id) ??
      ({
        id,
        title: "既有会话",
        cwd: "",
        agent: "codex",
        status: "idle",
        preview: "",
        lastActivityAt: 0,
        approvalPolicy: "on-request",
        pendingApprovals: 0,
      } satisfies SessionSummary);
    return { session: { ...base, history, tokenUsage: null }, latestSeq: 0 };
  }

  private historyFromTurns(turns: { data?: Array<{ items?: Array<Record<string, unknown>> }> } | null): HistoryItem[] {
    if (!turns?.data) return [];
    const out: HistoryItem[] = [];
    for (const turn of turns.data) {
      for (const item of turn.items ?? []) {
        const h = historyItemFromCodexItem(item as { type: string; id: string });
        if (h) out.push(h);
      }
    }
    return out;
  }

  /* ============ 操作 ============ */

  async create(opts: {
    projectPath: string;
    approvalPolicy: ApprovalPolicy;
    prompt: string;
  }): Promise<string> {
    const abs = await this.fs.isProjectAllowed(opts.projectPath);
    const id = await this.bridge.threadStart({
      cwd: abs,
      approvalPolicy: opts.approvalPolicy,
    });
    const summary: SessionSummary = {
      id,
      title: opts.prompt.slice(0, 40),
      cwd: abs,
      agent: "codex",
      status: "running",
      preview: opts.prompt,
      lastActivityAt: Date.now(),
      approvalPolicy: opts.approvalPolicy,
      pendingApprovals: 0,
    };
    this.live.set(id, {
      summary,
      history: [],
      tokenUsage: null,
      desiredPolicy: opts.approvalPolicy,
      activity: null,
    });
    this.bus.publishList({ type: "session.created", summary });
    await this.bridge.turnStart(id, opts.prompt, opts.approvalPolicy);
    return id;
  }

  async resume(id: string, policy?: ApprovalPolicy): Promise<SessionDetail> {
    const desired = policy ?? this.live.get(id)?.desiredPolicy ?? "on-request";
    // 单写者冲突在这里抛 SESSION_BUSY（bridge 映射）
    await this.bridge.threadResume(id, desired);
    const { session } = await this.detail(id);
    this.live.set(id, {
      summary: { ...session, status: "idle", approvalPolicy: desired, pendingApprovals: 0 },
      history: session.history,
      tokenUsage: null,
      desiredPolicy: desired,
      activity: null,
    });
    return session;
  }

  async sendMessage(id: string, text: string): Promise<void> {
    this.ensureLive(id);
    const s = this.live.get(id)!;
    s.desiredPolicy = s.desiredPolicy ?? s.summary.approvalPolicy;
    await this.bridge.turnStart(id, text, s.desiredPolicy);
    s.summary.lastActivityAt = Date.now();
  }

  async interrupt(id: string): Promise<void> {
    this.ensureLive(id);
    await this.bridge.turnInterrupt(id);
    this.approvals.expireSession(id);
  }

  setPolicy(id: string, policy: ApprovalPolicy): void {
    const s = this.live.get(id);
    if (!s) throw new DaemonError("SESSION_NOT_FOUND", "会话不在实时管理中，需先恢复");
    s.desiredPolicy = policy;
    s.summary.approvalPolicy = policy;
    this.publishUpdated(s);
  }

  private ensureLive(id: string): void {
    if (!this.live.has(id)) {
      throw new DaemonError("SESSION_NOT_FOUND", "会话不在实时管理中，需先恢复");
    }
  }

  /* ============ 状态机：消费 MappedFact ============ */

  consume(f: MappedFact): void {
    switch (f.kind) {
      case "threadStarted": {
        if (!this.live.has(f.threadId) && f.cwd) {
          const summary: SessionSummary = {
            id: f.threadId,
            title: "新会话",
            cwd: f.cwd,
            agent: "codex",
            status: "running",
            preview: "",
            lastActivityAt: Date.now(),
            approvalPolicy: "on-request",
            pendingApprovals: 0,
          };
          this.live.set(f.threadId, {
            summary,
            history: [],
            tokenUsage: null,
            desiredPolicy: "on-request",
            activity: null,
          });
          this.bus.publish(f.threadId, {
            type: "session.status",
            status: "running",
            activity: null,
          });
          this.publishUpdated(this.live.get(f.threadId)!);
        }
        return;
      }
      case "threadName": {
        const s = this.live.get(f.threadId);
        if (s && f.name) {
          s.summary.title = f.name.slice(0, 60);
          this.publishUpdated(s);
        }
        return;
      }
      case "threadStatus": {
        const s = this.live.get(f.threadId);
        if (!s) return;
        let next: SessionStatus = s.summary.status;
        if (f.status === "waiting_approval") next = "waiting_approval";
        else if (f.status === "running") next = "running";
        else if (f.status === "idle") {
          // 终态保留：done/error 不被后续 idle 覆盖
          if (s.summary.status !== "done" && s.summary.status !== "error") next = "idle";
        }
        if (next !== s.summary.status) {
          s.summary.status = next;
          s.summary.lastActivityAt = Date.now();
          this.publishStatus(f.threadId, s);
        }
        return;
      }
      case "userMessage": {
        const s = this.live.get(f.threadId);
        if (s) {
          s.history.push({ type: "userMessage", id: f.itemId, text: f.text, at: f.at });
          s.summary.lastActivityAt = Date.now();
          this.publishUpdated(s);
        }
        return;
      }
      case "agentDelta": {
        this.bus.publish(f.threadId, { type: "agent.delta", itemId: f.itemId, delta: f.delta });
        return;
      }
      case "agentMessage": {
        const s = this.live.get(f.threadId);
        if (s) {
          s.history.push({ type: "agentMessage", id: f.itemId, text: f.text, at: Date.now() });
          s.summary.lastActivityAt = Date.now();
        }
        this.bus.publish(f.threadId, { type: "agent.message", itemId: f.itemId, text: f.text });
        return;
      }
      case "toolStarted": {
        const s = this.live.get(f.threadId);
        if (s) {
          s.history.push({
            type: "toolCall",
            id: f.itemId,
            kind: f.toolKind,
            target: f.target,
            cmd: f.cmd,
            exitCode: null,
            durationMs: null,
            diffStat: null,
            outputTail: null,
            at: Date.now(),
          });
          s.activity = f.cmd ?? f.target;
          s.summary.lastActivityAt = Date.now();
          this.publishStatus(f.threadId, s);
        }
        this.bus.publish(f.threadId, {
          type: "tool.started",
          itemId: f.itemId,
          kind: f.toolKind,
          target: f.target,
          cmd: f.cmd,
        });
        return;
      }
      case "toolFinished": {
        const s = this.live.get(f.threadId);
        if (s) {
          let h = s.history.find((x) => x.type === "toolCall" && x.id === f.itemId);
          if (!h) {
            // upsert：错过 started 时也补建条目
            h = {
              type: "toolCall",
              id: f.itemId,
              kind: f.toolKind,
              target: f.target,
              cmd: null,
              exitCode: null,
              durationMs: null,
              diffStat: null,
              outputTail: null,
              at: Date.now(),
            };
            s.history.push(h);
          }
          if (h.type === "toolCall") {
            h.exitCode = f.exitCode;
            h.durationMs = f.durationMs;
            if (f.added != null && f.removed != null) h.diffStat = { added: f.added, removed: f.removed };
            h.outputTail = f.outputTail;
          }
        }
        this.bus.publish(f.threadId, {
          type: "tool.finished",
          itemId: f.itemId,
          kind: f.toolKind,
          target: f.target,
          exitCode: f.exitCode,
          durationMs: f.durationMs,
          diffStat: f.added != null && f.removed != null ? { added: f.added, removed: f.removed } : null,
          outputTail: f.outputTail,
        });
        return;
      }
      case "queueChanged": {
        this.bus.publish(f.threadId, { type: "session.queue", queued: f.queued });
        return;
      }
      case "turnCompleted": {
        const s = this.live.get(f.threadId);
        this.approvals.expireSession(f.threadId);
        if (s) {
          s.activity = null;
          if (f.error) s.summary.status = "error";
          else if (s.summary.status !== "waiting_approval") s.summary.status = "done";
          s.summary.lastActivityAt = Date.now();
          this.publishStatus(f.threadId, s);
        }
        return;
      }
      case "tokenUsage": {
        const s = this.live.get(f.threadId);
        const usage: TokenUsage = {
          totalTokens: f.totalTokens,
          inputTokens: f.inputTokens,
          cachedInputTokens: f.cachedInputTokens,
          outputTokens: f.outputTokens,
        };
        if (s) s.tokenUsage = usage;
        this.bus.publish(f.threadId, { type: "usage.updated", tokenUsage: usage, rateLimits: null });
        return;
      }
      case "approvalRequest": {
        this.approvals.register({
          rpcId: f.rpcId,
          threadId: f.threadId,
          approvalId: f.approvalId,
          approvalKind: f.approvalKind,
          command: f.command,
          cwd: f.cwd,
          reason: f.reason,
          availableDecisions: f.availableDecisions,
        });
        return;
      }
    }
  }

  private publishStatus(sessionId: string, s: LiveSession): void {
    const activity =
      s.summary.status === "waiting_approval"
        ? (this.approvalsPendingCommand(sessionId) ?? "等待批准")
        : s.activity;
    this.bus.publish(sessionId, {
      type: "session.status",
      status: s.summary.status,
      activity: s.summary.status === "done" || s.summary.status === "idle" ? null : activity,
    });
    this.publishUpdated(s);
  }

  private approvalsPendingCommand(sessionId: string): string | null {
    return this.approvals.pendingCommandFor(sessionId);
  }

  private publishUpdated(s: LiveSession): void {
    this.bus.publishList({ type: "session.updated", summary: { ...s.summary } });
  }
}
