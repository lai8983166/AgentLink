import type { ClientMessage, ListEvent, ServerMessage, SessionEvent } from "@agentlink/shared";

/**
 * WS 管道（任务 7.2）：单连接复用、按会话订阅、lastSeq 断线补发、
 * snapshot.required 时回调重建、指数退避重连、应用层心跳探测假死连接。
 * socket 可注入，便于测试。
 */
export type WsState = "idle" | "connecting" | "open" | "closed";

/** 心跳参数：20s 一跳，45s 无 pong 判假死（WiFi/移动网络闪断时 onclose 不触发） */
const PING_INTERVAL_MS = 20_000;
const PONG_STALE_MS = 45_000;

export interface FakeableSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
}

type SessionSink = (e: SessionEvent) => void;
type ListSink = (e: ListEvent) => void;

export class WsClient {
  state: WsState = "idle";
  onStateChange: (s: WsState) => void = () => {};
  /** 快照重建回调（越窗时由上层全量拉取） */
  onSnapshotRequired: (sessionId: string) => void = () => {};

  private socket: FakeableSocket | null = null;
  private sessionSinks = new Map<string, Set<SessionSink>>();
  private listSinks = new Set<ListSink>();
  private lastSeq = new Map<string, number>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private shouldConnect = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;

  constructor(
    private readonly url: () => string,
    private readonly socketFactory: (url: string) => FakeableSocket = (u) =>
      new WebSocket(u) as unknown as FakeableSocket,
  ) {}

  connect(): void {
    this.shouldConnect = true;
    this.open();
  }

  disconnect(): void {
    this.shouldConnect = false;
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
    this.setState("idle");
  }

  private open(): void {
    if (this.socket) return;
    this.setState("connecting");
    const socket = this.socketFactory(this.url());
    this.socket = socket;
    socket.onopen = () => {
      this.backoffMs = 1000;
      this.setState("open");
      this.startHeartbeat();
      // 重连后重新订阅全部（带 lastSeq 补发）
      for (const sessionId of this.sessionSinks.keys()) {
        this.sendSubscribe(sessionId);
      }
      if (this.listSinks.size > 0) this.rawSend({ type: "subscribeList" });
    };
    socket.onclose = () => {
      this.socket = null;
      this.stopHeartbeat();
      this.setState("closed");
      if (this.shouldConnect) {
        this.reconnectTimer = setTimeout(() => this.open(), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 15000);
      }
    };
    socket.onmessage = (ev) => this.handleMessage(ev.data);
  }

  private setState(s: WsState): void {
    this.state = s;
    this.onStateChange(s);
  }

  /** 心跳：周期 ping；超过 PONG_STALE_MS 无任何 pong → 判假死强制断开，
   *  走既有重连路径（lastSeq 补发 / 越窗 snapshot.required 全量重建） */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPongAt > PONG_STALE_MS) {
        this.socket?.close();
        return;
      }
      this.rawSend({ type: "ping" });
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** 立即检查连接活性（页面从后台恢复时调用，免去等下一跳） */
  probe(): void {
    if (this.state === "open" && Date.now() - this.lastPongAt > PONG_STALE_MS) {
      this.socket?.close();
    }
  }

  private rawSend(m: ClientMessage): void {
    try {
      this.socket?.send(JSON.stringify(m));
    } catch {
      /* 连接断开时的发送由重连补发兜底 */
    }
  }

  private sendSubscribe(sessionId: string): void {
    const seq = this.lastSeq.get(sessionId);
    this.rawSend({ type: "subscribe", sessionId, lastSeq: seq ?? null });
  }

  private handleMessage(data: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "event": {
        const e = msg.event;
        // 更新序号水位
        if (e.seq > (this.lastSeq.get(e.sessionId) ?? 0)) this.lastSeq.set(e.sessionId, e.seq);
        const sinks = this.sessionSinks.get(e.sessionId);
        if (sinks) for (const s of sinks) s(e);
        return;
      }
      case "listEvent": {
        for (const s of this.listSinks) s(msg.event);
        return;
      }
      case "snapshot.required": {
        // 水位失效：清空后回调全量重建，重建后再订阅会从服务端当前水位开始
        this.lastSeq.delete(msg.sessionId);
        this.onSnapshotRequired(msg.sessionId);
        return;
      }
      case "pong":
        this.lastPongAt = Date.now();
        return;
      default:
        return;
    }
  }

  /** 订阅会话事件；立即发送 subscribe（若已连接） */
  subscribe(sessionId: string, sink: SessionSink): () => void {
    let sinks = this.sessionSinks.get(sessionId);
    if (!sinks) {
      sinks = new Set();
      this.sessionSinks.set(sessionId, sinks);
    }
    sinks.add(sink);
    if (this.state === "open") this.sendSubscribe(sessionId);
    return () => {
      const s = this.sessionSinks.get(sessionId);
      if (!s) return;
      s.delete(sink);
      if (s.size === 0) {
        this.sessionSinks.delete(sessionId);
        this.rawSend({ type: "unsubscribe", sessionId });
      }
    };
  }

  subscribeList(sink: ListSink): () => void {
    const first = this.listSinks.size === 0;
    this.listSinks.add(sink);
    if (first && this.state === "open") this.rawSend({ type: "subscribeList" });
    return () => {
      this.listSinks.delete(sink);
      if (this.listSinks.size === 0) this.rawSend({ type: "unsubscribeList" });
    };
  }
}
