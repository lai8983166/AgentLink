import { z } from "zod";
import {
  ApprovalDecision,
  ApprovalKind,
  DiffStat,
  RateLimits,
  SessionStatus,
  SessionSummary,
  TokenUsage,
  ToolKind,
} from "./domain";

/**
 * 内部事件契约（design.md D4：codex 事件 → 内部事件映射）。
 * 每个会话事件带单调递增 seq；列表级事件挂在保留字 sessionId="__all__"。
 */
export const LIST_SCOPE = "__all__";

const EventBase = z.object({
  serverEpoch: z.string().optional(),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  at: z.number(),
});

/** 会话级事件（event-stream spec「事件类型契约」） */
export const SessionEvent = z.discriminatedUnion("type", [
  EventBase.extend({
    type: z.literal("session.status"),
    status: SessionStatus,
    /** 当前动作摘要（动作条）：执行中的命令 / 等待审批提示 */
    activity: z.string().nullable(),
  }),
  EventBase.extend({
    type: z.literal("agent.delta"),
    itemId: z.string(),
    delta: z.string(),
  }),
  EventBase.extend({
    type: z.literal("user.message"),
    itemId: z.string(),
    clientMessageId: z.string().optional(),
    /** 桌面顺序中已有的后继条目；迟到消息应插在它前面。 */
    beforeItemId: z.string().optional(),
    text: z.string(),
  }),
  EventBase.extend({
    type: z.literal("agent.message"),
    itemId: z.string(),
    text: z.string(),
  }),
  EventBase.extend({
    type: z.literal("tool.started"),
    itemId: z.string(),
    kind: ToolKind,
    target: z.string(),
    cmd: z.string().nullable(),
  }),
  EventBase.extend({
    type: z.literal("tool.finished"),
    itemId: z.string(),
    kind: ToolKind,
    target: z.string(),
    exitCode: z.number().nullable(),
    durationMs: z.number().nullable(),
    diffStat: DiffStat.nullable(),
    outputTail: z.string().nullable(),
  }),
  EventBase.extend({
    type: z.literal("approval.request"),
    approvalId: z.string(),
    kind: ApprovalKind,
    command: z.string().nullable(),
    cwd: z.string(),
    reason: z.string().nullable(),
    /** codex 下发的可用决定（动态按钮）：字符串或高级决定对象（如 acceptWithExecpolicyAmendment） */
    availableDecisions: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])),
  }),
  EventBase.extend({
    type: z.literal("approval.resolved"),
    approvalId: z.string(),
    /** "expired" = 随轮次作废；"resolved_elsewhere" = 已在电脑端被处理（决定未知） */
    decision: z.union([ApprovalDecision, z.literal("expired"), z.literal("resolved_elsewhere")]),
  }),
  EventBase.extend({
    type: z.literal("session.queue"),
    queued: z.number().int(),
  }),
  EventBase.extend({
    type: z.literal("usage.updated"),
    tokenUsage: TokenUsage.nullable(),
    rateLimits: RateLimits.nullable(),
  }),
  EventBase.extend({
    type: z.literal("error"),
    message: z.string(),
  }),
  EventBase.extend({
    type: z.literal("history.sync"),
    /** 权威历史已重建（基准快照落位）：客户端应重拉 detail 替换本地历史，避免增量丢失后停在部分文本 */
  }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

/** 列表级轻量事件（event-stream spec「会话列表级事件」） */
export const ListEvent = z.discriminatedUnion("type", [
  EventBase.extend({
    type: z.literal("session.created"),
    summary: SessionSummary,
  }),
  EventBase.extend({
    type: z.literal("session.updated"),
    summary: SessionSummary,
  }),
  EventBase.extend({
    type: z.literal("session.deleted"),
    summary: SessionSummary,
  }),
  /** 账户限额变化（额度用尽告警由客户端/ntfy 按此触发） */
  EventBase.extend({
    type: z.literal("account.limits"),
    limits: RateLimits,
  }),
]);
export type ListEvent = z.infer<typeof ListEvent>;

export type AnyEvent = SessionEvent | ListEvent;
