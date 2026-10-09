import { z } from "zod";

/** 统一错误码（daemon REST/WS 共用） */
export const ApiErrorCode = z.enum([
  "UNAUTHORIZED", // 缺失/无效 token
  "SESSION_BUSY", // 会话被 IDE 等其他写入者占用（单写者）
  "SESSION_NOT_FOUND",
  "APPROVAL_EXPIRED", // 审批随轮次结束已作废
  "APPROVAL_NOT_FOUND",
  "APPROVAL_ALREADY_DECIDED",
  "IPC_UNAVAILABLE",
  "IPC_OWNER_NOT_FOUND",
  "IPC_INCOMPATIBLE",
  "MESSAGE_UNCERTAIN",
  "PATH_NOT_ALLOWED", // 路径不在白名单
  "SNAPSHOT_REQUIRED", // lastSeq 早于事件保留窗口，需全量拉取
  "VALIDATION_ERROR",
  "INTERNAL",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/** REST 错误 envelope：{ error: { code, message } } */
export const ApiErrorBody = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
