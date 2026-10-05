import type { ClientMessage, ListEvent, ServerMessage, SessionEvent } from "@agentlink/shared";
import { ClientMessage as ClientMessageSchema } from "@agentlink/shared";
import type { SessionEventBus } from "../events/bus";

/**
 * 单条 WS 连接的订阅处理（任务 5.2 核心逻辑，与传输解耦可测）。
 */
export class WsConnectionHandler {
  private sessionListener = (e: SessionEvent | ListEvent) => this.send({ type: "event", event: e as SessionEvent });
  private listListener = (e: SessionEvent | ListEvent) => this.send({ type: "listEvent", event: e as ListEvent });
  private subscribedSessions = new Set<string>();
  private listSubscribed = false;

  constructor(
    private readonly bus: SessionEventBus,
    private readonly send: (m: ServerMessage) => void,
  ) {}

  /** 处理客户端消息；返回 false 表示协议错误（连接应关闭） */
  handle(raw: unknown): boolean {
    const parsed = ClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.send({ type: "error", code: "VALIDATION_ERROR", message: "非法客户端消息" });
      return true; // 单条坏消息不断连
    }
    const m: ClientMessage = parsed.data;
    switch (m.type) {
      case "ping":
        this.send({ type: "pong" });
        return true;
      case "subscribe": {
        const result = this.bus.subscribe(m.sessionId, m.lastSeq ?? null, this.sessionListener);
        if (!result.ok) {
          this.send({ type: "snapshot.required", sessionId: m.sessionId });
          return true;
        }
        this.subscribedSessions.add(m.sessionId);
        this.send({
          type: "subscribed",
          sessionId: m.sessionId,
          fromSeq: (m.lastSeq ?? 0) + 1,
        });
        for (const e of result.replay) this.send({ type: "event", event: e });
        return true;
      }
      case "unsubscribe": {
        this.bus.unsubscribe(m.sessionId, this.sessionListener);
        this.subscribedSessions.delete(m.sessionId);
        return true;
      }
      case "subscribeList": {
        if (!this.listSubscribed) {
          this.bus.subscribeList(this.listListener);
          this.listSubscribed = true;
        }
        return true;
      }
      case "unsubscribeList": {
        this.bus.unsubscribeList(this.listListener);
        this.listSubscribed = false;
        return true;
      }
    }
  }

  close(): void {
    for (const s of this.subscribedSessions) this.bus.unsubscribe(s, this.sessionListener);
    this.subscribedSessions.clear();
    if (this.listSubscribed) this.bus.unsubscribeList(this.listListener);
  }
}
