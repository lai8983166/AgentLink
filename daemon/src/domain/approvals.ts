import type { ApprovalDecision, ApprovalKind } from "@agentlink/shared";
import type { CodexBridge } from "../codex/bridge";
import type { SessionEventBus } from "../events/bus";
import type { AuditStore } from "./audit";
import { DaemonError } from "../codex/bridge";

/** 审批登记项（任务 4.3） */
export interface PendingApproval {
  rpcId: number | string;
  sessionId: string;
  approvalId: string;
  kind: ApprovalKind;
  command: string | null;
  cwd: string;
  reason: string | null;
  availableDecisions: Array<string | Record<string, unknown>>;
  createdAt: number;
  expired: boolean;
}

/** 四个规范决定：始终允许提交（codex 对未列出的 acceptForSession 也接受，实测） */
const CANONICAL = new Set<ApprovalDecision>(["accept", "acceptForSession", "decline", "cancel"]);

export class ApprovalService {
  private pending = new Map<string, PendingApproval>();
  private recentlyExpired = new Set<string>();
  private pendingChange: (sessionId: string, count: number) => void = () => {};
  private requestHooks = new Set<(a: PendingApproval) => void>();

  constructor(
    private readonly bridge: CodexBridge,
    private readonly bus: SessionEventBus,
    private readonly audit: AuditStore,
  ) {}

  onPendingChange(cb: (sessionId: string, count: number) => void): void {
    this.pendingChange = cb;
  }

  /** ntfy 等旁路订阅审批请求 */
  onRequest(cb: (a: PendingApproval) => void): () => void {
    this.requestHooks.add(cb);
    return () => this.requestHooks.delete(cb);
  }

  /** 桥接层收到审批请求时登记并广播 */
  register(f: {
    rpcId: number | string;
    threadId: string;
    approvalId: string;
    approvalKind: ApprovalKind;
    command: string | null;
    cwd: string;
    reason: string | null;
    availableDecisions: Array<string | Record<string, unknown>>;
  }): PendingApproval {
    const key = `${f.threadId}:${f.approvalId}`;
    const a: PendingApproval = {
      rpcId: f.rpcId,
      sessionId: f.threadId,
      approvalId: f.approvalId,
      kind: f.approvalKind,
      command: f.command,
      cwd: f.cwd,
      reason: f.reason,
      availableDecisions: f.availableDecisions,
      createdAt: Date.now(),
      expired: false,
    };
    this.pending.set(key, a);
    this.bus.publish(f.threadId, {
      type: "approval.request",
      approvalId: a.approvalId,
      kind: a.kind,
      command: a.command,
      cwd: a.cwd,
      reason: a.reason,
      availableDecisions: a.availableDecisions,
    });
    this.pendingChange(a.sessionId, this.countPending(a.sessionId));
    for (const h of this.requestHooks) h(a);
    return a;
  }

  get(sessionId: string, approvalId: string): PendingApproval | undefined {
    return this.pending.get(`${sessionId}:${approvalId}`);
  }

  /** 提交决定（任务 4.3 + 审计） */
  submit(sessionId: string, approvalId: string, decision: ApprovalDecision, project: string): void {
    const a = this.get(sessionId, approvalId);
    if (!a) {
      const expired = this.recentlyExpired.has(`${sessionId}:${approvalId}`);
      throw new DaemonError(
        expired ? "APPROVAL_EXPIRED" : "APPROVAL_NOT_FOUND",
        expired ? "审批已随轮次结束作废" : "审批请求不存在",
      );
    }
    if (!CANONICAL.has(decision)) throw new DaemonError("VALIDATION_ERROR", "非法决定");

    this.bridge.respondApproval(a.rpcId, decision);
    this.audit.append({
      at: Date.now(),
      sessionId,
      project,
      kind: a.kind,
      command: a.command,
      decision,
      source: "phone",
    });
    this.pending.delete(`${sessionId}:${approvalId}`);
    this.bus.publish(sessionId, { type: "approval.resolved", approvalId, decision });
    this.pendingChange(sessionId, this.countPending(sessionId));
  }

  /** 轮次结束/中断：作废该会话全部挂起审批（approval-flow spec「审批请求时效」） */
  expireSession(sessionId: string): void {
    for (const [key, a] of this.pending) {
      if (a.sessionId !== sessionId || a.expired) continue;
      a.expired = true;
      this.recentlyExpired.add(key);
      this.pending.delete(key);
      this.bus.publish(sessionId, {
        type: "approval.resolved",
        approvalId: a.approvalId,
        decision: "expired" as const,
      });
      // 向 codex 侧拒绝挂起请求，防泄漏（若 codex 已丢弃则忽略）
      this.bridge.rejectApproval(a.rpcId, "approval expired");
    }
    // 最近过期集合有界，防内存泄漏
    if (this.recentlyExpired.size > 200) {
      this.recentlyExpired = new Set([...this.recentlyExpired].slice(100));
    }
    this.pendingChange(sessionId, 0);
  }

  countPending(sessionId: string): number {
    let n = 0;
    for (const a of this.pending.values()) if (a.sessionId === sessionId && !a.expired) n++;
    return n;
  }

  /** 该会话第一个挂起审批的命令摘要（动作条展示用） */
  pendingCommandFor(sessionId: string): string | null {
    for (const a of this.pending.values()) {
      if (a.sessionId === sessionId && !a.expired) return a.command;
    }
    return null;
  }
}
