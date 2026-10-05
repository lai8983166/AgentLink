/**
 * codex app-server 协议适配层 —— 协议版本锁定 0.160.0。
 * 升级 codex 时只需核对本文件与 design/spike/schema/ 的差异。
 * 来源：design/codex-appserver-notes.md（2026-10-05 实测）。
 */

/** 客户端 → app-server 方法（v0 用到的子集） */
export const CodexMethod = {
  initialize: "initialize",
  threadStart: "thread/start",
  threadList: "thread/list",
  threadResume: "thread/resume",
  threadRead: "thread/read",
  threadTurnsList: "thread/turns/list",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
} as const;
export type CodexMethod = (typeof CodexMethod)[keyof typeof CodexMethod];

/** AskForApproval（v0 用字符串三档；granular 对象为 codex 高级形态） */
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";

/** 审批决定（codex 侧原始形态：字符串或对象） */
export type CodexApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: Record<string, unknown> };

export const CODEX_NOISE_METHODS = new Set([
  "mcpServer/startupStatus/updated",
  "mcpServer/event/stream/notification",
  "skills/changed",
  "remoteControl/status/changed",
  "account/updated",
  "app/list/updated",
  "warning",
  "deprecationNotice",
  "configWarning",
  "thread/environment/connected",
  "thread/environment/disconnected",
]);

/* ============ 通知载荷（宽松类型：防御性读取） ============ */

export interface CodexNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface CodexServerRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** thread/status/changed.params.status */
export interface CodexThreadStatus {
  type: "active" | "idle" | string;
  activeFlags?: string[];
}

/** item.* 载荷基形 */
export interface CodexItem {
  type: string;
  id: string;
  [k: string]: unknown;
}

/** item/commandExecution/requestApproval.params（实测样例见 approval.mjs 输出） */
export interface CodexApprovalParams {
  kind?: "command" | "fileChange" | string;
  threadId?: string;
  approvalId?: string | null;
  command?: string | null;
  cwd?: string;
  reason?: string | null;
  availableDecisions?: Array<string | Record<string, unknown>>;
  [k: string]: unknown;
}

/* ============ 结果形态 ============ */

export interface CodexThreadInfo {
  id: string;
  sessionId?: string;
  preview?: string;
  environments?: Array<{ environmentId?: string; cwd?: string }>;
  [k: string]: unknown;
}

export interface CodexThreadListResult {
  data?: CodexThreadInfo[];
  nextCursor?: string | null;
}

export interface CodexTurnItem {
  id: string;
  type: string;
  items?: CodexItem[];
  [k: string]: unknown;
}

export interface CodexThreadTurnsResult {
  data?: CodexTurnItem[];
  nextCursor?: string | null;
}
