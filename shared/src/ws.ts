import { z } from "zod";
import { ListEvent, SessionEvent } from "./events";

/**
 * WS 协议（design.md D5：单连接 + 订阅消息切换会话）。
 * 连接建立即认证（查询参数 token）；客户端发订阅指令，服务端推事件。
 */

/** 客户端 → 服务端 */
export const ClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    sessionId: z.string(),
    /** 断线重连时携带最后已收序号，服务端补发其后事件 */
    lastSeq: z.number().int().nonnegative().nullable().optional(),
  }),
  z.object({ type: z.literal("unsubscribe"), sessionId: z.string() }),
  /** 订阅会话列表级事件（首页） */
  z.object({ type: z.literal("subscribeList") }),
  z.object({ type: z.literal("unsubscribeList") }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** 服务端 → 客户端 */
export const ServerMessage = z.discriminatedUnion("type", [
  /** 订阅成功；此后先补发历史事件（若有），再实时推送 */
  z.object({
    type: z.literal("subscribed"),
    sessionId: z.string(),
    /** 订阅基准：客户端应从此序号之后接收 */
    fromSeq: z.number().int(),
  }),
  /** lastSeq 早于保留窗口：客户端需 REST 全量拉取重建 */
  z.object({
    type: z.literal("snapshot.required"),
    sessionId: z.string(),
  }),
  z.object({ type: z.literal("event"), event: SessionEvent }),
  z.object({ type: z.literal("listEvent"), event: ListEvent }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
