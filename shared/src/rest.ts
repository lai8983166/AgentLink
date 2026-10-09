import { z } from "zod";
import {
  ApprovalDecision,
  ApprovalKind,
  ApprovalPolicy,
  AuditEntry,
  FsEntry,
  RateLimit,
  SessionDetail,
  SessionSummary,
} from "./domain";

/* ============ 请求 ============ */

export const CreateSessionRequest = z.object({
  projectPath: z.string().min(1),
  approvalPolicy: ApprovalPolicy.default("on-request"),
  prompt: z.string().min(1),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const SendMessageRequest = z.object({
  text: z.string().min(1),
  clientMessageId: z.string().min(1).max(128).optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const ApprovalDecisionRequest = z.object({
  decision: ApprovalDecision,
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;

export const PatchSessionRequest = z.object({
  approvalPolicy: ApprovalPolicy,
});
export type PatchSessionRequest = z.infer<typeof PatchSessionRequest>;

/* ============ 响应 ============ */

export const StatusResponse = z.object({
  daemonVersion: z.string(),
  /** 当前客户端可达模式（由接入层判定） */
  mode: z.enum(["lan", "relay", "local"]),
  latencyMs: z.number().nullable(),
  rateLimits: RateLimit.nullable(),
  pendingApprovals: z.number().int(),
});
export type StatusResponse = z.infer<typeof StatusResponse>;

export const SessionListResponse = z.object({
  sessions: z.array(SessionSummary),
});
export type SessionListResponse = z.infer<typeof SessionListResponse>;

export const SessionDetailResponse = z.object({
  session: SessionDetail,
  /** 服务端当前保留的最新事件序号（快照重建基准） */
  latestSeq: z.number().int(),
  serverEpoch: z.string().optional(),
});
export type SessionDetailResponse = z.infer<typeof SessionDetailResponse>;

export const CreateSessionResponse = z.object({
  id: z.string(),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

export const ApprovalRequestDetail = z.object({
  approvalId: z.string(),
  sessionId: z.string(),
  kind: ApprovalKind,
  command: z.string().nullable(),
  cwd: z.string(),
  reason: z.string().nullable(),
  availableDecisions: z.array(z.string()),
});
export type ApprovalRequestDetail = z.infer<typeof ApprovalRequestDetail>;

export const AuditListResponse = z.object({
  entries: z.array(AuditEntry),
  nextCursor: z.number().nullable(),
});
export type AuditListResponse = z.infer<typeof AuditListResponse>;

export const FsListResponse = z.object({
  path: z.string(),
  entries: z.array(FsEntry),
});
export type FsListResponse = z.infer<typeof FsListResponse>;

/* ============ 端点常量（/api/v1，design.md D5） ============ */

export const API = {
  status: "/api/v1/status",
  sessions: "/api/v1/sessions",
  session: (id: string) => `/api/v1/sessions/${id}`,
  resume: (id: string) => `/api/v1/sessions/${id}/resume`,
  message: (id: string) => `/api/v1/sessions/${id}/message`,
  interrupt: (id: string) => `/api/v1/sessions/${id}/interrupt`,
  approval: (id: string, aid: string) =>
    `/api/v1/sessions/${id}/approvals/${aid}`,
  fs: "/api/v1/fs",
  audit: "/api/v1/audit",
  health: "/api/v1/health",
  ws: "/api/v1/ws",
} as const;
