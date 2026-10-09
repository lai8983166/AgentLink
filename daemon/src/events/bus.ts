import { LIST_SCOPE, type ListEvent, type SessionEvent } from "@agentlink/shared";

/**
 * 会话事件总线（design.md D3）：每会话内存环形缓冲 + 单调序号 + 订阅广播。
 * 列表级事件挂在独立序号空间（LIST_SCOPE）。
 */
const BUFFER_CAP = 500;

/** Omit 在联合类型上需要分布式的才不丢字段 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

type Listener = (e: SessionEvent | ListEvent) => void;

interface Subscription {
  sessionId: string;
  listener: Listener;
}

export class SessionEventBus {
  readonly epoch = crypto.randomUUID();
  private buffers = new Map<string, SessionEvent[]>();
  private listBuffer: ListEvent[] = [];
  private counters = new Map<string, number>();
  private subs: Subscription[] = [];
  private listSubs: Listener[] = [];
  private taps = new Set<Listener>();

  /** 发布会话事件：自动分配序号、入缓冲、广播 */
  publish(
    sessionId: string,
    ev: DistributiveOmit<SessionEvent, "sessionId" | "seq" | "at">,
  ): SessionEvent {
    const seq = this.nextSeq(sessionId);
    const full = { ...ev, sessionId, seq, at: Date.now(), serverEpoch: this.epoch } as SessionEvent;
    const buf = this.buffers.get(sessionId) ?? [];
    buf.push(full);
    if (buf.length > BUFFER_CAP) buf.splice(0, buf.length - BUFFER_CAP);
    this.buffers.set(sessionId, buf);
    for (const s of this.subs) if (s.sessionId === sessionId) s.listener(full);
    for (const t of this.taps) t(full);
    return full;
  }

  /** 发布列表级事件 */
  publishList(ev: DistributiveOmit<ListEvent, "sessionId" | "seq" | "at">): ListEvent {
    const seq = this.nextSeq(LIST_SCOPE);
    const full = { ...ev, sessionId: LIST_SCOPE, seq, at: Date.now(), serverEpoch: this.epoch } as ListEvent;
    this.listBuffer.push(full);
    if (this.listBuffer.length > BUFFER_CAP) this.listBuffer.splice(0, this.listBuffer.length - BUFFER_CAP);
    for (const l of this.listSubs) l(full);
    for (const t of this.taps) t(full);
    return full;
  }

  /** 全局旁路（ntfy 等）：所有事件实时经过，不回放历史 */
  tap(cb: Listener): () => void {
    this.taps.add(cb);
    return () => this.taps.delete(cb);
  }

  latestSeq(sessionId: string): number {
    const buf = this.buffers.get(sessionId);
    return buf && buf.length ? (buf[buf.length - 1]?.seq ?? 0) : 0;
  }

  /** 订阅；lastSeq 非 null 时先补发，早于保留窗口返回 snapshot.required */
  subscribe(
    sessionId: string,
    lastSeq: number | null | undefined,
    listener: Listener,
  ): { ok: true; replay: SessionEvent[] } | { ok: false; reason: "snapshot" } {
    const counter = this.counters.get(sessionId) ?? 0;
    const buf = this.buffers.get(sessionId) ?? [];
    // 当前缓冲里最早的序号；空缓冲时 counter+1 表示"无可补"
    const earliest = buf.length ? (buf[0]?.seq ?? counter + 1) : counter + 1;
    if (lastSeq != null && (lastSeq < earliest - 1 || lastSeq > counter)) {
      return { ok: false, reason: "snapshot" };
    }
    this.subs.push({ sessionId, listener });
    const replay = lastSeq != null ? buf.filter((e) => e.seq > lastSeq) : [];
    return { ok: true, replay };
  }

  unsubscribe(sessionId: string, listener: Listener): void {
    this.subs = this.subs.filter((s) => !(s.sessionId === sessionId && s.listener === listener));
  }

  subscribeList(listener: Listener): void {
    this.listSubs.push(listener);
  }

  unsubscribeList(listener: Listener): void {
    this.listSubs = this.listSubs.filter((l) => l !== listener);
  }

  private nextSeq(scope: string): number {
    const n = (this.counters.get(scope) ?? 0) + 1;
    this.counters.set(scope, n);
    return n;
  }
}
