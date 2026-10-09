import { randomUUID } from "node:crypto";
import type { IpcClient } from "./client";
import { BROADCAST_FOLLOWING, IpcMethod, type ConversationState } from "./protocol";
import {
  diffDesktopState,
  desktopStatusFact,
  normalizeSnapshot,
  revisionOk,
  type DesktopFact,
  type DesktopState,
} from "./mapper";

/**
 * 单个桌面会话的跟随器（任务 2.1/2.3）：
 * 发现拥有者 → following 周期续订（10s）→ 快照/增量差分出事实 →
 * revision 校验（乱序/跳跃 → 重订阅重建）→ 拥有者消失探测 → 委托操作。
 */
const FOLLOW_INTERVAL_MS = 10_000;
const OWNER_LOST_THRESHOLD = 3;

export type FollowerMode = "observe" | "takeover";

export class IpcFollowerSession {
  mode: FollowerMode = "observe";
  ownerClientId: string | null = null;
  lastState: DesktopState | null = null;
  lastStateAt = 0;
  ownerLost = false;

  /** 差分事实出口（由 DesktopSessionManager 接到事件总线/审批域） */
  onFacts: (facts: DesktopFact[]) => void = () => {};
  onOwnerLost: () => void = () => {};

  private followTimer: ReturnType<typeof setInterval> | null = null;
  private ownerMisses = 0;
  private stopped = false;

  constructor(
    private readonly client: IpcClient,
    public readonly conversationId: string,
    private readonly opts: { log?: (...a: unknown[]) => void } = {},
  ) {}

  private get log(): (...a: unknown[]) => void {
    return this.opts.log ?? (() => {});
  }

  /** 发现当前拥有者；失败时清除旧地址，不能继续向失效的客户端发送。 */
  async discover(): Promise<string> {
    const res = (await this.client.callFull(IpcMethod.threadOwnerDiscovery, {
      hostId: "local",
      conversationId: this.conversationId,
    })) as { resultType?: string; handledByClientId?: string; error?: { message?: string } };
    if (res.error || res.resultType !== "success" || !res.handledByClientId) {
      this.ownerClientId = null;
      this.ownerMisses++;
      if (this.ownerMisses >= OWNER_LOST_THRESHOLD && !this.ownerLost) {
        this.ownerLost = true;
        this.onOwnerLost();
      }
      throw new Error("IPC_OWNER_NOT_FOUND: 电脑端当前未持有这个会话，请在 Codex 中打开原会话后重试");
    }
    this.ownerMisses = 0;
    this.ownerLost = false;
    if (this.ownerClientId !== res.handledByClientId) {
      this.lastState = null;
      this.lastStateAt = 0;
      this.suppressNextDiff = true;
    }
    this.ownerClientId = res.handledByClientId;
    return res.handledByClientId;
  }

  /** 开始跟随：发现 + 订阅 + 续订循环（幂等：重入复用同一次启动，防 onConnected 竞态重置基准） */
  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.stopped = false;
    this.startPromise = this.doStart().catch((e) => {
      this.startPromise = null;
      throw e;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    await this.discover();
    this.suppressNextDiff = true; // 首个快照只作基准（历史经 detail 快照直出），不回流全量事件
    this.sendFollowing(true);
    this.followTimer = setInterval(() => {
      if (this.stopped) return;
      this.keepAlive().catch((e) => this.log(`[follower:${this.conversationId.slice(0, 8)}] keepalive:`, e.message));
    }, FOLLOW_INTERVAL_MS);
    this.established = true;
  }

  /** 管道重连后的重新跟随（重置基准，仅对已建立的会话生效；初次启动中的竞态由 start 幂等吸收） */
  async restart(): Promise<void> {
    if (!this.established) return;
    this.established = false;
    if (this.followTimer) clearInterval(this.followTimer);
    this.followTimer = null;
    this.startPromise = null;
    this.lastState = null;
    this.lastStateAt = 0;
    await this.start();
  }

  /** 首个快照（或重订阅后首个快照）不产生差分事件 */
  private suppressNextDiff = false;
  private startPromise: Promise<void> | null = null;
  private established = false;

  private async keepAlive(): Promise<void> {
    // 拥有者可能变化（桌面重开会话）：重新发现，变化则换目标
    await this.discover();
    this.sendFollowing(true);
  }

  stop(): void {
    this.stopped = true;
    if (this.followTimer) clearInterval(this.followTimer);
    this.followTimer = null;
    this.startPromise = null;
    this.sendFollowing(false);
  }

  private sendFollowing(following: boolean): void {
    if (!this.ownerClientId) return;
    this.client.sendBroadcast(
      BROADCAST_FOLLOWING,
      { hostId: "local", conversationId: this.conversationId, following },
      [this.ownerClientId],
    );
  }

  /** 重建：取消跟随再重新跟随（revision 跳跃/未知增量时调用） */
  async resubscribe(): Promise<void> {
    this.sendFollowing(false);
    await this.discover().catch(() => {});
    this.suppressNextDiff = true;
    this.sendFollowing(true);
  }

  /** 桌面推送的状态变化（snapshot 或增量）→ 事实流 */
  async handleStateChange(change: { type?: string; conversationState?: ConversationState; revision?: number }): Promise<void> {
    if (process.env.AGENTLINK_DEBUG) {
      console.log(`[follower-dbg] conv=${this.conversationId.slice(0, 8)} suppress=${this.suppressNextDiff} change=${change.type} rev=${change.conversationState?.revision}`);
    }
    if (change.type === "snapshot" && change.conversationState) {
      const next = normalizeSnapshot(change.conversationState);
      if (!revisionOk(this.lastState?.revision ?? null, next.revision)) {
        this.log(`[follower] snapshot revision 回退，忽略`);
        return;
      }
      if (this.suppressNextDiff) {
        this.takeBaseline(next);
        return;
      }
      const facts = diffDesktopState(this.lastState, next);
      this.lastState = next;
      this.lastStateAt = Date.now();
      this.emitFacts(facts);
      return;
    }
    // 非 snapshot 增量：能拿到完整 conversationState 就走差分，否则重订阅换快照
    if (change.conversationState) {
      const next = normalizeSnapshot(change.conversationState);
      if (this.lastState && !revisionOk(this.lastState.revision, next.revision)) {
        this.log(`[follower] 增量 revision 跳跃（${this.lastState.revision} → ${next.revision}），重建快照`);
        this.lastState = null;
        await this.resubscribe();
        return;
      }
      if (this.suppressNextDiff) {
        // 重订阅/换 owner 后首个到达的是增量（也带全量状态）：同样只作基准，避免整史回流
        this.takeBaseline(next);
        return;
      }
      const facts = diffDesktopState(this.lastState, next);
      this.lastState = next;
      this.lastStateAt = Date.now();
      this.emitFacts(facts);
      return;
    }
    // 无法解析的增量：重订阅换取权威快照
    await this.resubscribe();
  }

  /** 基准落位：只发历史重建信号 + 一条状态（供列表/横幅同步），历史由 detail 快照直出。
   *  history.sync 让已在线的客户端重拉 detail——重订阅/换 owner 前的增量丢失由此收敛。 */
  private takeBaseline(next: DesktopState): void {
    this.suppressNextDiff = false;
    this.lastState = next;
    this.lastStateAt = Date.now();
    this.onFacts([
      { kind: "history.sync" },
      // 首帧也同步当前审批，但不重放完整消息/工具历史。
      ...diffDesktopState(null, next).filter((f) => f.kind === "approval.request"),
      desktopStatusFact(next),
    ]);
  }

  private emitFacts(facts: DesktopFact[]): void {
    if (facts.length) this.onFacts(facts);
  }

  /* ============ 委托操作（接管态） ============ */

  /** 构造 start-turn 请求：由桌面继承当前设置，不复制历史轮次的权限/模型参数。 */
  buildTurnRequest(input: { text: string; clientUserMessageId?: string; approvalPolicy?: string }): {
    conversationId: string;
    turnStart: { request: Record<string, unknown>; context: { inheritThreadSettings: boolean } };
  } {
    const request: Record<string, unknown> = {
      threadId: this.conversationId,
      input: [{ type: "text", text: input.text, text_elements: [] }],
      clientUserMessageId: input.clientUserMessageId ?? randomUUID(),
    };
    if (input.approvalPolicy) request.approvalPolicy = input.approvalPolicy;
    return {
      conversationId: this.conversationId,
      turnStart: { request, context: { inheritThreadSettings: true } },
    };
  }

  async startTurn(input: { text: string; clientUserMessageId?: string; approvalPolicy?: string }): Promise<void> {
    // 重试必须复用同一消息 ID；只重试路由明确拒绝的 no-client-found。
    const params = this.buildTurnRequest(input);
    await this.delegate(IpcMethod.threadFollowerStartTurn, params);
  }

  private async delegate(method: string, params: unknown): Promise<void> {
    await this.discover();
    this.sendFollowing(true);
    try {
      await this.client.call(method, params, this.ownerClientId!);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes("no-client-found")) throw e;
      // 桌面窗口可能在发现和发送之间切换/重开，只重新发现并重试一次。
      this.ownerClientId = null;
      const owner = await this.discover();
      this.sendFollowing(true);
      try {
        await this.client.call(method, params, owner);
      } catch (retryError) {
        if (!(retryError instanceof Error) || !retryError.message.includes("no-client-found")) throw retryError;
        this.ownerClientId = null;
        this.ownerLost = true;
        this.onOwnerLost();
        throw new Error("IPC_OWNER_NOT_FOUND: 电脑端无法接收这个会话的指令，请在 Codex 中重新打开原会话后重试");
      }
    }
  }

  async interruptTurn(expectedTurnId?: string): Promise<void> {
    await this.delegate(
      IpcMethod.threadFollowerInterruptTurn,
      { conversationId: this.conversationId, mode: "user-stop", expectedTurnId },
    );
  }

  async decideApproval(requestId: string, decision: string): Promise<void> {
    await this.delegate(
      IpcMethod.threadFollowerCommandApprovalDecision,
      { conversationId: this.conversationId, requestId, decision },
    );
  }
}
