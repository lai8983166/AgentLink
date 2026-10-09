import type {
  ApprovalPolicy,
  HistoryItem,
  SessionDetail,
  SessionStatus,
  SessionSummary,
  TokenUsage,
  MessageReceipt,
} from "@agentlink/shared";
import { DaemonError, type CodexBridge } from "../codex/bridge";
import { historyItemFromCodexItem } from "../codex/mapper";
import type { MappedFact } from "../codex/mapper";
import type { CodexThreadInfo } from "../codex/protocol";
import type { SessionEventBus } from "../events/bus";
import type { ApprovalService } from "./approvals";
import type { FsService } from "./fs";
import { ControlStore } from "./control-store";
import { assertNoThreadWriter } from "../codex/writer-lock";
import { readResumeSettings, type ResumeSettings } from "../codex/resume-settings";

/** 会话注册表（任务 4.1/4.2）：状态机 + 事件发布 + 列表聚合 */

/** codex originator → 展示名（实测分布：Codex Desktop / codex_vscode / agentlink…） */
function originatorLabel(originator: unknown): string {
  const o = typeof originator === "string" ? originator : "";
  if (/desktop/i.test(o)) return "ChatGPT 桌面端";
  if (/vscode/i.test(o)) return "VS Code";
  if (/agentlink/i.test(o)) return "AgentLink";
  return o || "其他入口";
}

interface LiveSession {
  summary: SessionSummary;
  history: HistoryItem[];
  tokenUsage: TokenUsage | null;
  desiredPolicy: ApprovalPolicy | undefined;
  activity: string | null;
}

export class SessionRegistry {
  private sending = new Map<string, Promise<MessageReceipt>>();
  private resuming = new Map<string, Promise<SessionDetail>>();
  private loaded = new Set<string>();
  private draining = false;
  private pendingOperations = 0;

  restartReadiness(): { safe: boolean; activeSessionIds: string[]; pendingMessages: number } {
    const activeSessionIds = [...this.live].filter(([, s]) => s.summary.status === "running" || s.summary.status === "waiting_approval" || s.summary.status === "unknown").map(([id]) => id);
    return { safe: activeSessionIds.length === 0 && this.sending.size === 0 && this.pendingOperations === 0, activeSessionIds, pendingMessages: this.sending.size };
  }
  prepareRestart(): ReturnType<SessionRegistry["restartReadiness"]> {
    const readiness = this.restartReadiness();
    if (readiness.safe) this.draining = true;
    return readiness;
  }
  cancelRestart(): void { this.draining = false; }
  private ensureAccepting(): void {
    if (this.draining) throw new DaemonError("DAEMON_DRAINING", "后台正在安全重启，请稍后再发送指令");
  }
  private controlOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureAccepting();
    this.pendingOperations++;
    return Promise.resolve().then(operation).finally(() => { this.pendingOperations--; });
  }
  private live = new Map<string, LiveSession>();
  private rolloutIndex = new Map<string, SessionSummary>();
  private knownCodexThreads = new Set<string>();
  /** 谱系：源会话 → 最新后代 id */
  private descendantIndex = new Map<string, string>();
  /** 桌面会话管理器（观察/接管），由装配层注入（任务 3.1） */
  private desktop: {
    observe(id: string, mode?: "observe" | "takeover"): Promise<void>;
    takeover(id: string): Promise<void>;
    has(id: string): boolean;
    isTakenOver(id: string): boolean;
    overlay(): Map<string, { status: SessionStatus | null; mode: string; desktopGone: boolean; pendingApprovals?: number; statusUpdatedAt?: number }>;
    syncSummaries?(ids: string[]): Promise<void>;
    sendTurn(id: string, text: string, clientMessageId?: string): Promise<void>;
    interrupt(id: string): Promise<void>;
    /** 观察中会话的快照历史（完整直出，避免 diff 事件重复/截断） */
    historyFor(id: string): import("@agentlink/shared").HistoryItem[] | null;
    /** 桌面/VS Code 当前是否持有；检测不可用必须抛错，不能当作无人持有。 */
    ownerAlive?(id: string): Promise<boolean>;
    useLocal?(id: string): void;
    /** 摘要变化回调（属性，由 registry 覆写接线） */
    onSummaryChange: (id: string) => void;
  } | null = null;
  /** 账户限额监控（app-server 通知路径），装配层注入 */
  private limits: import("./limits").LimitsMonitor | null = null;

  setLimitsMonitor(m: import("./limits").LimitsMonitor): void {
    this.limits = m;
  }

  /** 注入桌面会话管理器并接线摘要联动 */
  setDesktopManager(m: NonNullable<SessionRegistry["desktop"]>): void {
    this.desktop = m;
    m.onSummaryChange = (id) => {
      if (this.live.has(id)) return;
      // 桌面会话摘要变化 → 用合并后的摘要广播列表事件
      const merged = this.mergeDesktopOverlay(id);
      if (merged) this.bus.publishList({ type: "session.updated", summary: { ...merged } });
    };
  }

  /** 合并桌面 overlay（观察状态/接管/owner 消失）到 rollout 摘要 */
  private mergeDesktopOverlay(id: string): SessionSummary | null {
    const base = this.rolloutIndex.get(id);
    if (!base || !this.desktop) return base ?? null;
    const ov = this.desktop.overlay().get(id);
    if (!ov) return { ...base, desktopGone: false };
    const takenOver = ov.mode === "takeover";
    return {
      ...base,
      desktopManaged: true,
      status: ov.status ?? base.status,
      statusUpdatedAt: ov.statusUpdatedAt ?? base.statusUpdatedAt,
      pendingApprovals: ov.pendingApprovals ?? base.pendingApprovals,
      activeElsewhere: !takenOver && (ov.status === "running" || ov.status === "waiting_approval"),
      desktopGone: ov.desktopGone,
    };
  }

  constructor(
    private readonly bridge: CodexBridge,
    private readonly bus: SessionEventBus,
    private readonly approvals: ApprovalService,
    private readonly fs: FsService,
    private readonly controls: ControlStore = new ControlStore(),
    private readonly assertNoWriter: (id: string) => Promise<void> = assertNoThreadWriter,
    private readonly resumeSettings: (id: string) => Promise<ResumeSettings> = readResumeSettings,
  ) {}

  async start(): Promise<void> {
    this.bridge.onFact((f) => this.consume(f));
    this.bridge.onRestart(() => {
      this.loaded.clear();
      // codex 重启：实时状态全丢，回读 rollout 重建
      for (const [id, s] of this.live) {
        if (s.summary.status === "running" || s.summary.status === "waiting_approval") {
          s.summary.status = "unknown";
          this.bus.publish(id, { type: "session.status", status: "unknown", activity: null });
          this.publishUpdated(s);
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
    await this.desktop?.syncSummaries?.([...this.rolloutIndex.values()].filter((s) => s.desktopManaged && !this.live.has(s.id)).map((s) => s.id));
    const out = new Map<string, SessionSummary>();
    for (const [id, s] of this.rolloutIndex) {
      out.set(id, this.mergeDesktopOverlay(id) ?? s);
    }
    for (const [id, s] of this.live) out.set(id, s.summary);
    // 谱系标注：源会话 → 最新后代
    for (const [id, s] of out) {
      const desc = this.descendantIndex.get(id);
      if (desc && !s.forkedToId && s.forkedFromId === null) s.forkedToId = desc;
    }
    const order: Record<SessionStatus, number> = {
      waiting_approval: 0,
      running: 1,
      done: 2,
      error: 3,
      idle: 4,
      unknown: 5,
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
      const env = t.environments?.[0] as Record<string, unknown> | undefined;
      const roots = (env?.runtimeWorkspaceRoots as string[] | undefined) ?? [];
      const cwd =
        (typeof env?.cwd === "string" && env.cwd) ||
        (typeof (t as { cwd?: unknown }).cwd === "string" && (t as { cwd?: string }).cwd) ||
        roots[0] ||
        "";
      // rollout 最近有写入 = 会话正被其他入口（VS Code/桌面）使用
      const updatedAtSec =
        (typeof t.updatedAt === "number" ? t.updatedAt : 0) ||
        (typeof t.recencyAt === "number" ? t.recencyAt : 0);
      const lastActivityAt = updatedAtSec > 0 ? updatedAtSec * 1000 : 0;
      const activeElsewhere = updatedAtSec > 0 && Date.now() / 1000 - updatedAtSec < 300;
      const activeVia = activeElsewhere ? originatorLabel(t.originator) : null;
      const desktopManaged = /desktop|vscode/i.test(String(t.originator ?? "")) || /desktop|vscode/i.test(String(t.source ?? ""));
      this.rolloutIndex.set(t.id, {
        id: t.id,
        title: ((t as { name?: string }).name || t.preview || "").slice(0, 40) || "既有会话",
        cwd,
        agent: "codex",
        status: desktopManaged ? "unknown" : "idle",
        statusUpdatedAt: 0,
        activeElsewhere,
        activeVia,
        desktopManaged,
        forkedFromId: typeof t.forkedFromId === "string" ? t.forkedFromId : null,
        forkedToId: null, // 后代关系在 list() 时统一计算
        desktopGone: false,
        preview: typeof t.preview === "string" ? t.preview.slice(0, 120) : "",
        lastActivityAt,
        approvalPolicy: "on-request",
        pendingApprovals: 0,
      });
    }
    // 谱系后代索引：forkedFromId → 最新的后代（rollout + live 一并考虑）
    this.descendantIndex = new Map();
    const all = new Map<string, SessionSummary>();
    for (const [id, s] of this.rolloutIndex) all.set(id, s);
    for (const [id, s] of this.live) all.set(id, s.summary);
    for (const [id, s] of all) {
      if (s.forkedFromId) {
        const prev = this.descendantIndex.get(s.forkedFromId);
        if (!prev || s.lastActivityAt >= (all.get(prev)?.lastActivityAt ?? 0)) {
          this.descendantIndex.set(s.forkedFromId, id);
        }
      }
    }
  }

  /* ============ 详情 ============ */

  async detail(id: string): Promise<{ session: SessionDetail; latestSeq: number; serverEpoch: string }> {
    const live = this.live.get(id);
    if (live) {
      return {
        session: { ...live.summary, history: [...live.history], tokenUsage: live.tokenUsage,
          approvals: this.approvals.snapshot(id), controlMode: "local" },
        latestSeq: this.bus.latestSeq(id),
        serverEpoch: this.bus.epoch,
      };
    }
    // 观察中的桌面会话：历史由快照直出（完整且与事件流无重复）
    const desktopHistory = this.desktop?.historyFor(id);
    if (desktopHistory) {
      const base = this.mergeDesktopOverlay(id) ?? this.rolloutIndex.get(id);
      if (base) {
        return {
          session: { ...base, history: desktopHistory, tokenUsage: null,
            approvals: this.approvals.snapshot(id), controlMode: this.desktop?.isTakenOver(id) ? "takeover" : "observe" },
          latestSeq: this.bus.latestSeq(id),
          serverEpoch: this.bus.epoch,
        };
      }
    }
    // rollout 会话：按需拉历史（desc：最新 50 轮）
    const latestSeq = this.bus.latestSeq(id);
    const serverEpoch = this.bus.epoch;
    const turns = await this.bridge.threadTurns(id).catch(() => null);
    // 请求等待期间桌面快照可能已经落位，必须优先返回实时权威历史。
    if (this.live.has(id) || this.desktop?.historyFor(id)) return this.detail(id);
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
        activeElsewhere: false,
        activeVia: null,
        forkedFromId: null,
        forkedToId: null,
        desktopGone: false,
        preview: "",
        lastActivityAt: 0,
        approvalPolicy: "on-request",
        pendingApprovals: 0,
      } satisfies SessionSummary);
    return { session: { ...base, history, tokenUsage: null, approvals: this.approvals.snapshot(id),
      controlMode: base.desktopManaged ? "observe" : "local" }, latestSeq, serverEpoch };
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

  create(opts: { projectPath: string; approvalPolicy: ApprovalPolicy; prompt: string }): Promise<string> {
    return this.controlOperation(() => this.createSession(opts));
  }

  private async createSession(opts: {
    projectPath: string;
    approvalPolicy: ApprovalPolicy;
    prompt: string;
  }): Promise<string> {
    this.ensureAccepting();
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
      statusUpdatedAt: Date.now(),
      activeElsewhere: false,
      activeVia: null,
      forkedFromId: null,
      forkedToId: null,
      desktopGone: false,
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
    this.loaded.add(id);
    await this.bridge.turnStart(id, opts.prompt, opts.approvalPolicy);
    return id;
  }

  resume(id: string, policy?: ApprovalPolicy): Promise<SessionDetail> {
    this.ensureAccepting();
    const pending = this.resuming.get(id);
    if (pending) return pending;
    const result = this.controlOperation(() => this.resumeSession(id, policy)).finally(() => this.resuming.delete(id));
    this.resuming.set(id, result);
    return result;
  }

  private async resumeSession(id: string, policy?: ApprovalPolicy): Promise<SessionDetail> {
    this.ensureAccepting();
    // 页面刷新或两个手机重复恢复，不能重置正在运行的任务。
    if (this.loaded.has(id) && this.live.has(id)) return (await this.detail(id)).session;
    const { session } = await this.detail(id);
    const desktopOrigin = !!this.rolloutIndex.get(id)?.desktopManaged || !!this.desktop?.has(id);
    if (desktopOrigin && !this.desktop?.ownerAlive) {
      throw new DaemonError("IPC_UNAVAILABLE", "无法确认电脑端已释放原会话，未恢复会话");
    }
    const settings = desktopOrigin ? await this.resumeSettings(id) : undefined;
    if (this.desktop?.ownerAlive && (await this.desktop.ownerAlive(id))) {
      throw new DaemonError("SESSION_BUSY", "原会话正在电脑端打开中，请使用接管此会话，或先在电脑端关闭该会话");
    }
    if (desktopOrigin) {
      await this.assertNoWriter(id);
      // OS 核验期间电脑端可能重新打开了会话，恢复前再次确认。
      if (await this.desktop!.ownerAlive!(id)) throw new DaemonError("SESSION_BUSY", "电脑端已重新打开原会话，请使用接管此会话");
    }
    // 明确继承原会话的 sandbox，避免 app-server 默默使用 daemon 默认权限。
    const thread = await this.bridge.threadResume(id, policy ?? settings?.approvalPolicy, settings);
    const desired = policy ?? thread.approvalPolicy;
    // summary 只留摘要字段：detail 的 history/tokenUsage 不能混入，
    // 否则列表接口与列表推送会被撑到 MB 级（外网下首页 15s 轮询灾难）
    const { history, tokenUsage, approvals: _approvals, controlMode: _mode, ...summaryBase } = session;
    this.desktop?.useLocal?.(id);
    this.approvals.expireSession(id);
    this.live.set(id, {
      summary: { ...summaryBase, status: "idle", statusUpdatedAt: Date.now(), approvalPolicy: desired ?? session.approvalPolicy,
        desktopManaged: false, desktopGone: false, activeElsewhere: false, activeVia: null, pendingApprovals: 0 },
      history,
      tokenUsage: tokenUsage ?? null,
      desiredPolicy: desired,
      activity: null,
    });
    this.loaded.add(id);
    this.publishStatus(id, this.live.get(id)!);
    this.bus.publish(id, { type: "history.sync" });
    return (await this.detail(id)).session;
  }

  sendMessage(id: string, text: string, clientMessageId: string = crypto.randomUUID()): Promise<MessageReceipt> {
    this.ensureAccepting();
    const key = `${id}:${clientMessageId}`;
    const previous = this.controls.delivery(id, clientMessageId);
    if (previous && previous.text !== text) throw new DaemonError("VALIDATION_ERROR", "同一消息 ID 不能用于不同内容");
    const pending = this.sending.get(key);
    if (pending) return pending;
    if (previous?.state === "accepted") return Promise.resolve(previous);
    if (previous?.state === "uncertain" || previous?.state === "sending") throw new DaemonError("MESSAGE_UNCERTAIN", "这条指令的接收结果待确认，请先核对原会话，避免重复执行");
    const result = Promise.resolve().then(async () => {
      this.controls.saveDelivery(id, text, { clientMessageId, state: "sending", updatedAt: Date.now(), error: null });
      try {
        await this.dispatchMessage(id, text, clientMessageId);
        const receipt: MessageReceipt = { clientMessageId, state: "accepted", updatedAt: Date.now(), error: null };
        this.controls.saveDelivery(id, text, receipt);
        return receipt;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const state = /timeout|closed|断开|ECONNRESET|EPIPE/i.test(error) ? "uncertain" : "failed";
        this.controls.saveDelivery(id, text, { clientMessageId, state, updatedAt: Date.now(), error });
        throw e;
      }
    }).finally(() => { this.sending.delete(key); });
    this.sending.set(key, result);
    return result;
  }

  messageReceipt(id: string, clientMessageId: string): MessageReceipt | null {
    const delivery = this.controls.delivery(id, clientMessageId);
    if (!delivery) return null;
    const { text: _, ...receipt } = delivery;
    return receipt;
  }

  private async dispatchMessage(id: string, text: string, clientMessageId: string): Promise<void> {
    // 桌面接管态：委托 IPC follower（任务 3.3，含 clientUserMessageId 幂等）
    if (!this.live.has(id) && this.desktop?.isTakenOver(id)) {
      // rollout 摘要里的默认审批策略不代表桌面的实际权限，不能用于覆盖原会话。
      await this.desktop.sendTurn(id, text, clientMessageId);
      const base = this.rolloutIndex.get(id);
      if (base) base.lastActivityAt = Date.now();
      return;
    }
    this.ensureLive(id);
    const s = this.live.get(id)!;
    await this.bridge.turnStart(id, text, s.desiredPolicy);
    s.summary.lastActivityAt = Date.now();
  }

  async interrupt(id: string): Promise<void> {
    if (!this.live.has(id) && this.desktop?.has(id)) {
      if (this.desktop.isTakenOver(id)) {
        await this.desktop.interrupt(id);
        this.approvals.expireSession(id);
        return;
      }
      throw new DaemonError("SESSION_BUSY", "会话正在电脑上使用中，先接管再中断");
    }
    this.ensureLive(id);
    await this.bridge.turnInterrupt(id);
    this.approvals.expireSession(id);
  }

  /* ============ 桌面会话：观察 / 接管 / 兜底 fork（任务 3.1/3.2） ============ */

  /** 观察桌面持有的会话（busy 会话实时流）；IPC 不可用抛出对应错误 */
  async observe(id: string, mode: "observe" | "takeover" = "observe"): Promise<void> {
    if (this.live.has(id)) return;
    if (!this.desktop) throw new DaemonError("INTERNAL", "桌面 IPC 未启用");
    await this.desktop.observe(id, mode);
  }

  async takeover(id: string): Promise<void> {
    if (this.live.has(id)) return;
    if (!this.desktop) throw new DaemonError("INTERNAL", "桌面 IPC 未启用");
    await this.desktop.takeover(id);
    const merged = this.mergeDesktopOverlay(id);
    if (merged) this.bus.publishList({ type: "session.updated", summary: { ...merged } });
  }

  /** 兜底接力（owner 发现失败 / 管道不可用）：fork 出归本方管理的新会话 */
  fork(id: string, policy?: ApprovalPolicy): Promise<string> {
    return this.controlOperation(() => this.forkSession(id, policy));
  }

  private async forkSession(id: string, policy?: ApprovalPolicy): Promise<string> {
    this.ensureAccepting();
    const p = policy ?? this.rolloutIndex.get(id)?.approvalPolicy ?? "on-request";
    const thread = await this.bridge.threadFork(id, p);
    const forkId = thread.id;
    const envs = thread.environments ?? [];
    const cwd = envs[0]?.cwd ?? this.rolloutIndex.get(id)?.cwd ?? "";
    this.live.set(forkId, {
      summary: {
        id: forkId,
        title: `接力 · ${this.rolloutIndex.get(id)?.title ?? "会话"}`.slice(0, 60),
        cwd,
        agent: "codex",
        status: "idle",
        statusUpdatedAt: Date.now(),
        activeElsewhere: false,
        activeVia: null,
        forkedFromId: id,
        forkedToId: null,
        desktopGone: false,
        preview: "",
        lastActivityAt: Date.now(),
        approvalPolicy: p,
        pendingApprovals: 0,
      },
      history: [],
      tokenUsage: null,
      desiredPolicy: p,
      activity: null,
    });
    this.loaded.add(forkId);
    await this.refreshRollouts();
    this.bus.publishList({
      type: "session.created",
      summary: { ...this.live.get(forkId)!.summary },
    });
    return forkId;
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
        // resume 的通知不能抢先建立空历史，也不能把继承权限改成 on-request。
        if (this.resuming.has(f.threadId)) return;
        this.loaded.add(f.threadId);
        if (!this.live.has(f.threadId) && f.cwd) {
          const summary: SessionSummary = {
            id: f.threadId,
            title: "新会话",
            cwd: f.cwd,
            agent: "codex",
            status: "running",
            activeElsewhere: false,
            activeVia: null,
            forkedFromId: null,
            forkedToId: null,
            desktopGone: false,
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
      case "patchUpdated": {
        // 文件改动 patch 到达（diff 全屏的数据源）；更新历史并重发 tool.finished 供客户端补内容
        const s = this.live.get(f.threadId);
        if (s && f.patch) {
          const h = s.history.find((x) => x.type === "toolCall" && x.id === f.itemId);
          if (h && h.type === "toolCall" && !h.outputTail) {
            h.outputTail = f.patch.length > 8000 ? `${f.patch.slice(0, 8000)}…` : f.patch;
            this.bus.publish(f.threadId, {
              type: "tool.finished",
              itemId: f.itemId,
              kind: h.kind,
              target: h.target,
              exitCode: h.exitCode,
              durationMs: h.durationMs,
              diffStat: h.diffStat,
              outputTail: h.outputTail,
            });
          }
        }
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
        if (f.rateLimits && this.limits) this.limits.ingest(f.rateLimits.primary, f.rateLimits.secondary);
        this.bus.publish(f.threadId, { type: "usage.updated", tokenUsage: usage, rateLimits: null });
        return;
      }
      case "accountRateLimits": {
        if (this.limits) this.limits.ingest(f.rateLimits.primary, f.rateLimits.secondary);
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
    s.summary.statusUpdatedAt = Math.max(Date.now(), (s.summary.statusUpdatedAt ?? 0) + 1);
    this.bus.publishList({ type: "session.updated", summary: { ...s.summary } });
  }
}
