import { z } from "zod";

/** 会话状态机（session-management spec） */
export const SessionStatus = z.enum([
  "running",
  "waiting_approval",
  "done",
  "error",
  "idle",
  "unknown",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** 审批策略三档（映射 codex AskForApproval） */
export const ApprovalPolicy = z.enum(["untrusted", "on-request", "never"]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

/** 审批决定（映射 codex CommandExecutionApprovalDecision 的 v0 子集） */
export const ApprovalDecision = z.enum([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/** 工具调用种类（工具卡片） */
export const ToolKind = z.enum(["exec", "fileChange"]);
export type ToolKind = z.infer<typeof ToolKind>;

/** 审批请求种类 */
export const ApprovalKind = z.enum(["command", "fileChange"]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

/** diff 统计 */
export const DiffStat = z.object({ added: z.number(), removed: z.number() });
export type DiffStat = z.infer<typeof DiffStat>;

/** token 用量（来自 thread/tokenUsage/updated） */
export const TokenUsage = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/** 限额窗口（来自 account/rateLimits/updated / rollout token_usage_record.rate_limits） */
export const RateLimitWindow = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number(),
  resetsAt: z.number(),
});
export type RateLimitWindow = z.infer<typeof RateLimitWindow>;

/** 账户限额：primary=5 小时窗，secondary=周窗 */
export const RateLimits = z.object({
  primary: RateLimitWindow,
  secondary: RateLimitWindow.nullable(),
  /** 数据测量时刻（epoch ms；快照值与桌面实时衰减显示存在小时级漂移，标注以示诚实） */
  measuredAt: z.number().nullable().default(null),
});
export const RateLimit = RateLimits;
export type RateLimit = z.infer<typeof RateLimit>;

/** 会话卡片（首页列表条目） */
export const SessionSummary = z.object({
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  agent: z.literal("codex"),
  status: SessionStatus,
  /** 权威状态的更新时间；用于防止旧列表响应覆盖较新的实时推送。 */
  statusUpdatedAt: z.number().optional(),
  /** 会话正被其他入口（VS Code/ChatGPT 桌面端）使用：rollout 最近有写入 */
  activeElsewhere: z.boolean().default(false),
  /** 占用方显示名（"ChatGPT 桌面端" / "VS Code" 等），仅 activeElsewhere 时非空 */
  activeVia: z.string().nullable().default(null),
  /** 桌面/IDE 来源的原会话始终经 IPC 控制，不能用独立 app-server 恢复抢写权。 */
  desktopManaged: z.boolean().optional(),
  /** 本会话 fork 自哪个会话（接力谱系） */
  forkedFromId: z.string().nullable().default(null),
  /** 本会话存在更近的接力后代（点击旧会话时提示"最新进展在 →"） */
  forkedToId: z.string().nullable().default(null),
  /** 桌面端持有者不可达；不代表可用独立进程恢复原会话。 */
  desktopGone: z.boolean().default(false),
  preview: z.string(),
  lastActivityAt: z.number(),
  approvalPolicy: ApprovalPolicy,
  /** 挂起的审批数（>0 时首页横幅） */
  pendingApprovals: z.number(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/** 历史条目（会话详情快照） */
export const HistoryItem = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("userMessage"),
    id: z.string(),
    text: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal("agentMessage"),
    id: z.string(),
    text: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal("toolCall"),
    id: z.string(),
    kind: ToolKind,
    target: z.string(),
    cmd: z.string().nullable(),
    exitCode: z.number().nullable(),
    durationMs: z.number().nullable(),
    diffStat: DiffStat.nullable(),
    outputTail: z.string().nullable(),
    at: z.number(),
  }),
  z.object({
    type: z.literal("approval"),
    id: z.string(),
    kind: ApprovalKind,
    command: z.string().nullable(),
    cwd: z.string(),
    decision: ApprovalDecision,
    at: z.number(),
  }),
]);
export type HistoryItem = z.infer<typeof HistoryItem>;

/** 会话详情 = 摘要 + 历史 */
export const SessionDetail = SessionSummary.extend({
  history: z.array(HistoryItem),
  tokenUsage: TokenUsage.nullable(),
});
export type SessionDetail = z.infer<typeof SessionDetail>;

/** 审计记录（approval-flow spec） */
export const AuditEntry = z.object({
  id: z.number(),
  at: z.number(),
  sessionId: z.string(),
  project: z.string(),
  kind: ApprovalKind,
  command: z.string().nullable(),
  decision: ApprovalDecision,
  source: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** 文件系统浏览条目（白名单内） */
export const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["dir", "file"]),
});
export type FsEntry = z.infer<typeof FsEntry>;
