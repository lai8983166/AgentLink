import { randomUUID } from "node:crypto";
import type { IpcClient } from "./client";
import { BROADCAST_FOLLOWING, IpcMethod, type ConversationState } from "./protocol";
import {
  diffDesktopState,
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

  /** 发现拥有者；失败抛 IPC_OWNER_NOT_FOUND（触发 fork 兜底） */
  async discover(): Promise<string> {
    const res = (await this.client.callFull(IpcMethod.threadOwnerDiscovery, {
      hostId: "local",
      conversationId: this.conversationId,
    })) as { resultType?: string; handledByClientId?: string; error?: { message?: string } };
    if (res.error || res.resultType !== "success" || !res.handledByClientId) {
      this.ownerMisses++;
      if (this.ownerMisses >= OWNER_LOST_THRESHOLD && !this.ownerLost) {
        this.ownerLost = true;
        this.onOwnerLost();
      }
      throw new Error(`IPC_OWNER_NOT_FOUND: ${res.error?.message ?? res.resultType ?? "no owner"}`);
    }
    this.ownerMisses = 0;
    this.ownerLost = false;
    this.ownerClientId = res.handledByClientId;
    return res.handledByClientId;
  }

  /** 开始跟随：发现 + 订阅 + 续订循环 */
  async start(): Promise<void> {
    await this.discover();
    this.sendFollowing(true);
    this.followTimer = setInterval(() => {
      if (this.stopped) return;
      this.keepAlive().catch((e) => this.log(`[follower:${this.conversationId.slice(0, 8)}] keepalive:`, e.message));
    }, FOLLOW_INTERVAL_MS);
  }

  private async keepAlive(): Promise<void> {
    // 拥有者可能变化（桌面重开会话）：重新发现，变化则换目标
    const owner = await this.discover();
    if (owner !== this.ownerClientId) {
      this.log(`[follower] owner 变化 ${this.ownerClientId} → ${owner}`);
      this.ownerClientId = owner;
      this.lastState = null; // 换 owner 后重建快照基准
    }
    this.sendFollowing(true);
  }

  stop(): void {
    this.stopped = true;
    if (this.followTimer) clearInterval(this.followTimer);
    this.followTimer = null;
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
    this.sendFollowing(true);
  }

  /** 桌面推送的状态变化（snapshot 或增量）→ 事实流 */
  async handleStateChange(change: { type?: string; conversationState?: ConversationState; revision?: number }): Promise<void> {
    const revision = change.revision ?? change.conversationState?.revision ?? null;
    if (change.type === "snapshot" && change.conversationState) {
      const next = normalizeSnapshot(change.conversationState);
      if (!revisionOk(this.lastState?.revision ?? null, next.revision)) {
        this.log(`[follower] snapshot revision 回退，忽略`);
        return;
      }
      this.captureTemplate(change.conversationState);
      this.emitFacts(diffDesktopState(this.lastState, next));
      this.lastState = next;
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
      this.emitFacts(diffDesktopState(this.lastState, next));
      this.lastState = next;
      return;
    }
    // 无法解析的增量：重订阅换取权威快照
    await this.resubscribe();
  }

  private emitFacts(facts: DesktopFact[]): void {
    if (facts.length) this.onFacts(facts);
  }

  /* ============ 委托操作（接管态） ============ */

  /** 最近一次快照的轮次模板（start-turn 用上一轮完整 params 为基底，实测必需） */
  private turnTemplate: Record<string, unknown> | null = null;

  /** 从快照提取模板（normalizeSnapshot 之外保留原始 params） */
  captureTemplate(cs: ConversationState): void {
    const entities = cs.turnHistory?.history?.entitiesByKey ?? {};
    const last = Object.values(entities).pop();
    if (last?.params && typeof last.params === "object") {
      this.turnTemplate = structuredClone(last.params);
    }
  }

  /** 构造 start-turn 请求（任务 3.4）：上一轮参数为模板 + 显式策略 + 幂等消息 ID */
  buildTurnRequest(input: { text: string; clientUserMessageId?: string; approvalPolicy?: string }): {
    conversationId: string;
    turnStart: { request: Record<string, unknown>; context: { inheritThreadSettings: boolean } };
  } {
    // 模板基底：克隆上一轮 params（模型/设置等），去掉会话专属附加上下文
    const request: Record<string, unknown> = this.turnTemplate
      ? { ...structuredClone(this.turnTemplate) }
      : {};
    delete request.additionalContext;
    request.input = [{ type: "text", text: input.text, text_elements: [] }];
    request.clientUserMessageId = input.clientUserMessageId ?? randomUUID();
    if (input.approvalPolicy) request.approvalPolicy = input.approvalPolicy;
    return {
      conversationId: this.conversationId,
      turnStart: { request, context: { inheritThreadSettings: false } },
    };
  }

  async startTurn(input: { text: string; clientUserMessageId?: string; approvalPolicy?: string }): Promise<void> {
    if (!this.ownerClientId) throw new Error("IPC_OWNER_NOT_FOUND: 未发现拥有者");
    await this.client.call(IpcMethod.threadFollowerStartTurn, this.buildTurnRequest(input), this.ownerClientId);
  }

  async interruptTurn(expectedTurnId?: string): Promise<void> {
    if (!this.ownerClientId) throw new Error("IPC_OWNER_NOT_FOUND: 未发现拥有者");
    await this.client.call(
      IpcMethod.threadFollowerInterruptTurn,
      { conversationId: this.conversationId, mode: "user-stop", expectedTurnId },
      this.ownerClientId,
    );
  }

  async decideApproval(requestId: string, decision: string): Promise<void> {
    if (!this.ownerClientId) throw new Error("IPC_OWNER_NOT_FOUND: 未发现拥有者");
    await this.client.call(
      IpcMethod.threadFollowerCommandApprovalDecision,
      { conversationId: this.conversationId, requestId, decision },
      this.ownerClientId,
    );
  }
}
