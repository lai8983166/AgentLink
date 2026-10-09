import type { SessionStatus } from "@agentlink/shared";
import { IpcClient } from "./client";
import { IpcMethod } from "./protocol";
import { recentLimits } from "./rollout-limits";
import { IpcFollowerSession, type FollowerMode } from "./follower";
import type { DesktopFact } from "./mapper";
import { desktopStatusFact } from "./mapper";
import type { SessionEventBus } from "../events/bus";
import type { ApprovalService } from "../domain/approvals";
import { savePeerInfo } from "./peer-info";

/**
 * 桌面会话管理器（任务 3.1/3.3/4.1/4.2）：
 * 持有 IPC 客户端与会话级 Follower；把差分事实接到事件总线与审批域；
 * 提供接管态的消息/中断/审批委托与幂等。
 */
export interface DesktopOverlayEntry {
  status: SessionStatus | null;
  mode: FollowerMode;
  desktopGone: boolean;
  pendingApprovals?: number;
}

export class DesktopSessionManager {
  private client: IpcClient | null = null;
  private sessions = new Map<string, IpcFollowerSession>();
  /** 消息幂等：conversationId → 最近的 {id, text, at} */
  private lastSend = new Map<string, { id: string; text: string; at: number }>();

  /** registry 注入：桌面会话摘要变化时重发合并后的列表事件 */
  onSummaryChange: (conversationId: string) => void = () => {};
  /** 账户限额监控（rollout 尾读路径），装配层注入；未注入则不轮询 */
  limitsMonitor: import("../domain/limits").LimitsMonitor | null = null;

  constructor(
    private readonly bus: SessionEventBus,
    private readonly approvals: ApprovalService,
    private readonly opts: {
      log?: (...a: unknown[]) => void;
      clientFactory?: () => IpcClient;
    } = {},
  ) {}

  private get log(): (...a: unknown[]) => void {
    return this.opts.log ?? console.log;
  }

  private ensureClient(): IpcClient {
    if (this.client) return this.client;
    const client = this.opts.clientFactory
      ? this.opts.clientFactory()
      : new IpcClient(undefined, { log: this.log });
    client.broadcastHandler = (b) => {
      const conv = b.params?.conversationId;
      const change = b.params?.change as
        | { type?: string; conversationState?: never; revision?: number }
        | undefined;
      if (!conv) return;
      const follower = this.sessions.get(conv);
      if (!follower) return;
      // 交由 follower 处理（快照/增量/revision）
      follower.handleStateChange(change ?? {}).catch((e) =>
        this.log(`[desktop] state change 处理失败:`, e.message),
      );
    };
    client.onConnected = () => {
      // 管道重连：已建立的会话重新发现与订阅（重置基准快照）
      for (const [, f] of this.sessions) {
        f.restart().catch((e) => this.log(`[desktop] 重订阅失败:`, e.message));
      }
    };
    client.onStateChange = (s) => {
      if (s === "open" && client.peerInfo) savePeerInfo(client.peerInfo);
    };
    client.connect();
    this.client = client;
    return client;
  }

  /** 观察桌面持有的会话（任务 3.1/5.1 的后端） */
  async observe(conversationId: string, mode: FollowerMode = "observe"): Promise<void> {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      await existing.start();
      await existing.discover();
      if (mode === "takeover") existing.mode = "takeover";
      return;
    }
    const client = this.ensureClient();
    const follower = new IpcFollowerSession(client, conversationId, { log: this.log });
    follower.mode = mode;
    follower.onFacts = (facts) => this.applyFacts(conversationId, facts);
    follower.onOwnerLost = () => {
      this.approvals.expireSession(conversationId);
      this.bus.publish(conversationId, {
        type: "session.status",
        status: "idle",
        activity: null,
      });
      this.onSummaryChange?.(conversationId);
    };
    this.sessions.set(conversationId, follower);
    try {
      await follower.start();
    } catch (e) {
      follower.stop();
      this.sessions.delete(conversationId);
      throw e;
    }
    this.startLimitsPolling(conversationId);
  }

  /** 桌面会话的账户限额：IPC 快照不含 rate_limits，从 rollout 文件尾读（60s）。
   *  账户级额度跨会话共享 → 同时扫全局最近活跃的 rollout 合并取最新。 */
  private limitsTimers = new Map<string, ReturnType<typeof setInterval>>();
  private startLimitsPolling(conversationId: string): void {
    if (!this.limitsMonitor || this.limitsTimers.has(conversationId)) return;
    const poll = () => {
      const rl = recentLimits(conversationId);
      if (rl) this.limitsMonitor?.ingest(rl.primary, rl.secondary, rl.measuredAt);
    };
    poll();
    this.limitsTimers.set(conversationId, setInterval(poll, 60_000));
  }
  private stopLimitsPolling(conversationId: string): void {
    const t = this.limitsTimers.get(conversationId);
    if (t) clearInterval(t);
    this.limitsTimers.delete(conversationId);
  }

  async takeover(conversationId: string): Promise<void> {
    await this.observe(conversationId, "takeover");
    const f = this.sessions.get(conversationId);
    if (f) f.mode = "takeover";
  }

  has(conversationId: string): boolean {
    return this.sessions.has(conversationId);
  }

  /** 桌面/VS Code 当前是否持有该会话（IPC owner 发现）。
   *  只有明确的 no-client-found 才返回 false；管道异常/超时抛错，禁止抢写权。
   *  与 5 分钟时间戳启发式相比这是权威信号，可防止误抢闲置桌面会话的写权。 */
  async ownerAlive(conversationId: string): Promise<boolean> {
    if (this.client && this.client.state !== "open") {
      throw new Error("IPC_UNAVAILABLE: 桌面连接未就绪，无法确认会话占用状态，请稍后重试");
    }
    try {
      const client = this.ensureClient();
      const res = (await client.callFull(IpcMethod.threadOwnerDiscovery, {
        hostId: "local",
        conversationId,
      })) as { resultType?: string; handledByClientId?: string; error?: unknown };
      if (!res.error && res.resultType === "success" && res.handledByClientId) return true;
      if (res.resultType === "error" && res.error === "no-client-found") return false;
      throw new Error("桌面没有返回有效的拥有者检测结果");
    } catch (e) {
      throw new Error(`IPC_UNAVAILABLE: 无法确认会话占用状态，请稍后重试（${e instanceof Error ? e.message : String(e)}）`);
    }
  }

  isTakenOver(conversationId: string): boolean {
    return this.sessions.get(conversationId)?.mode === "takeover";
  }

  /** 路由用：观察中的会话状态覆盖（列表徽章同步） */
  overlay(): Map<string, DesktopOverlayEntry> {
    const out = new Map<string, DesktopOverlayEntry>();
    for (const [id, f] of this.sessions) {
      out.set(id, {
        status: f.lastState ? desktopStatusFact(f.lastState).status : null,
        mode: f.mode,
        desktopGone: f.ownerLost,
        pendingApprovals: f.lastState?.requests.length ?? 0,
      });
    }
    return out;
  }

  stop(conversationId: string): void {
    this.sessions.get(conversationId)?.stop();
    this.sessions.delete(conversationId);
    this.stopLimitsPolling(conversationId);
  }

  /** 接管态发消息（任务 3.3）：clientUserMessageId 幂等（60s 内同文本重试复用）。
   *  失败（额度用尽/桌面拒绝等）→ error 事件让手机立刻看到原因，而不是静默恢复输入框 */
  async sendTurn(conversationId: string, text: string): Promise<void> {
    const f = this.sessions.get(conversationId);
    if (!f || f.mode !== "takeover") throw new Error("IPC_NOT_TAKEN_OVER: 会话未接管");
    const prev = this.lastSend.get(conversationId);
    const now = Date.now();
    const reuse = prev && now - prev.at < 60_000 && prev.text === text ? prev.id : undefined;
    const id = reuse ?? crypto.randomUUID();
    this.lastSend.set(conversationId, { id, text, at: now });
    try {
      await f.startTurn({ text, clientUserMessageId: id });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.bus.publish(conversationId, { type: "error", message: `指令发送失败：${msg}` });
      throw e;
    }
  }

  async interrupt(conversationId: string): Promise<void> {
    const f = this.sessions.get(conversationId);
    if (!f) throw new Error("IPC_NOT_TAKEN_OVER: 会话未接管");
    await f.interruptTurn();
  }

  /** 审批决定委托（任务 4.2） */
  async decide(conversationId: string, requestId: string, decision: string): Promise<void> {
    const f = this.sessions.get(conversationId);
    if (!f) throw new Error("IPC_NOT_TAKEN_OVER: 会话未接管");
    await f.decideApproval(requestId, decision);
  }

  /** 观察中会话的历史：由最新快照直出（完整、无 diff 事件重复） */
  historyFor(conversationId: string): import("@agentlink/shared").HistoryItem[] | null {
    const f = this.sessions.get(conversationId);
    const state = f?.lastState;
    if (!state) return null;
    const out: import("@agentlink/shared").HistoryItem[] = [];
    for (const turn of state.turns) {
      for (const item of turn.items) {
        if (item.type === "userMessage") {
          out.push({ type: "userMessage", id: item.key, text: item.text, at: 0 });
        } else if (item.type === "agentMessage") {
          out.push({ type: "agentMessage", id: item.key, text: item.text, at: 0 });
        } else if (item.type === "commandExecution") {
          out.push({
            type: "toolCall",
            id: item.key,
            kind: "exec",
            target: item.command?.split(/\s+/)[0] ?? "命令",
            cmd: item.command,
            exitCode: item.exitCode,
            durationMs: null,
            diffStat: null,
            outputTail: item.outputTail,
            at: 0,
          });
        } else if (item.type === "fileChange") {
          out.push({
            type: "toolCall",
            id: item.key,
            kind: "fileChange",
            target: item.outputTail?.match(/@@ (.*?)（/)?.[1]?.split(/[\\/]/).pop() ?? "文件改动",
            cmd: null,
            exitCode: null,
            durationMs: null,
            diffStat: item.added != null && item.removed != null ? { added: item.added, removed: item.removed } : null,
            outputTail: item.outputTail,
            at: 0,
          });
        }
      }
    }
    return out;
  }

  /* ============ 事实 → 内部事件 / 审批（任务 4.1） ============ */

  private applyFacts(conversationId: string, facts: DesktopFact[]): void {
    for (const f of facts) {
      switch (f.kind) {
        case "session.status":
          this.bus.publish(conversationId, {
            type: "session.status",
            status: f.status,
            activity: f.activity,
          });
          this.onSummaryChange?.(conversationId);
          break;
        case "user.message":
          this.bus.publish(conversationId, { type: "user.message", itemId: f.itemId, text: f.text });
          break;
        case "agent.message":
          this.bus.publish(conversationId, { type: "agent.message", itemId: f.itemId, text: f.text });
          break;
        case "agent.delta":
          this.bus.publish(conversationId, { type: "agent.delta", itemId: f.itemId, delta: f.delta });
          break;
        case "history.sync":
          // 基准快照落位（首跟/重订阅/换 owner）：客户端重拉 detail 拿权威历史
          this.bus.publish(conversationId, { type: "history.sync" });
          break;
        case "tool.started":
          this.bus.publish(conversationId, {
            type: "tool.started",
            itemId: f.itemId,
            kind: f.toolKind,
            target: f.target,
            cmd: f.cmd,
          });
          break;
        case "tool.finished":
          this.bus.publish(conversationId, {
            type: "tool.finished",
            itemId: f.itemId,
            kind: f.toolKind,
            target: f.target,
            exitCode: f.exitCode,
            durationMs: null,
            diffStat: f.added != null && f.removed != null ? { added: f.added, removed: f.removed } : null,
            outputTail: f.outputTail,
          });
          break;
        case "approval.request":
          this.approvals.registerDesktop({
            sessionId: conversationId,
            requestId: f.requestId,
            kind: f.approvalKind,
            command: f.command,
            cwd: f.cwd,
            reason: f.reason,
            availableDecisions: f.availableDecisions,
          });
          break;
        case "approval.resolved":
          this.approvals.resolveDesktop(conversationId, f.requestId);
          break;
      }
    }
  }
}
