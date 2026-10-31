import { z } from "zod";
import { SessionStatus } from "./domain";

/** 本机插件协议，与公网手机 API 的配对凭据分离。 */
export const ClaudeExchange = z.object({
  protocol: z.literal(1),
  sessionId: z.string().uuid(),
  instanceId: z.string().min(1).max(100),
  cwd: z.string().min(1).max(4000),
  version: z.string().max(100),
  status: SessionStatus,
  turnId: z.string().max(200).nullable(),
  inputBlocked: z.boolean(),
  permissionMode: z.string().max(100).nullable(),
  events: z.array(z.object({
    seq: z.number().int().positive(),
    type: z.enum(["connected", "user", "started", "text", "completed", "interrupted", "failed", "tool", "toolEnd", "approval", "approvalEnd", "command", "snapshot", "gap"]),
    data: z.record(z.unknown()),
  })).max(512),
});
export type ClaudeExchange = z.infer<typeof ClaudeExchange>;
export type ClaudeEvent = ClaudeExchange["events"][number];
export type ClaudeCommand = { id: string; kind: "send" | "interrupt"; text?: string; turnId?: string };
export const CLAUDE_PREFIX = "claude:";
export const ClaudeApprovalWait = z.object({ sessionId: z.string().uuid(), instanceId: z.string().max(100), approvalId: z.string().max(200) });
