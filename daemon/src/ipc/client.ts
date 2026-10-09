import { randomUUID } from "node:crypto";
import net from "node:net";
import { CODEX_PIPE, IPC_VERSIONS, type IpcBroadcast, type IpcResponse } from "./protocol";

/**
 * codex-ipc 命名管道客户端（任务 1.1/1.2）：
 * 4 字节小端长度前缀分帧、request/response 匹配、broadcast 分发、
 * client-discovery 自动回应、断线指数退避重连。socket 可注入测试。
 */

export type IpcState = "idle" | "connecting" | "open" | "closed";

export interface PipeLikeSocket {
  write(data: Buffer): boolean;
  destroy(): void;
  on(event: "data", cb: (d: Buffer) => void): unknown;
  on(event: "connect" | "error" | "close", cb: () => void): unknown;
}

export type PipeSocketFactory = () => PipeLikeSocket;

export function createRealPipeSocket(): PipeLikeSocket {
  return net.connect(CODEX_PIPE) as unknown as PipeLikeSocket;
}

interface Pending {
  resolve: (r: IpcResponse) => void;
  method: string;
  timer: Timer;
}

export class IpcClient {
  state: IpcState = "idle";
  clientId = "initializing-client";
  peerInfo: Record<string, unknown> | null = null;
  onStateChange: (s: IpcState) => void = () => {};
  broadcastHandler: (b: IpcBroadcast) => void = () => {};

  private socket: PipeLikeSocket | null = null;
  private buf = Buffer.alloc(0);
  private pending = new Map<string, Pending>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 500;
  private shouldConnect = false;
  private readyWaiters = new Set<{ resolve: () => void; reject: (e: Error) => void }>();

  constructor(
    private readonly socketFactory: PipeSocketFactory = createRealPipeSocket,
    private readonly opts: { callTimeoutMs?: number; log?: (...a: unknown[]) => void } = {},
  ) {}

  connect(): void {
    this.shouldConnect = true;
    this.open();
  }

  disconnect(): void {
    this.shouldConnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.handleClose();
    this.setState("idle");
  }

  private get log(): (...a: unknown[]) => void {
    return this.opts.log ?? (() => {});
  }

  private setState(s: IpcState): void {
    this.state = s;
    this.onStateChange(s);
  }

  private open(): void {
    if (this.socket) return;
    this.setState("connecting");
    let socket: PipeLikeSocket;
    try {
      socket = this.socketFactory();
    } catch (e) {
      this.log("[ipc] pipe 工厂异常:", e);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    socket.on("error", () => this.handleClose(socket));
    socket.on("close", () => this.handleClose(socket));
    socket.on("data", (d) => { if (this.socket === socket) this.feed(d); });
    socket.on("connect", () => {
      if (this.socket !== socket) return;
      // 每次连接（含重连）都重新握手
      this.initialize()
        .then((info) => {
          if (this.socket !== socket) return;
          this.peerInfo = (info ?? {}) as Record<string, unknown>;
          this.setState("open");
          this.backoffMs = 500;
          for (const waiter of this.readyWaiters) waiter.resolve();
          this.readyWaiters.clear();
          this.log("[ipc] 已连接桌面 IPC，对端:", JSON.stringify(info).slice(0, 120));
          this.onConnected?.();
        })
        .catch((e) => {
          if (this.socket !== socket) return;
          this.log("[ipc] initialize 失败:", e.message);
          this.handleClose(socket);
        });
    });
  }

  /** 连接建立后的钩子（Follower 重订阅等） */
  onConnected: () => void = () => {};

  private handleClose(socket = this.socket): void {
    if (!socket || this.socket !== socket) return;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.peerInfo = null;
    this.clientId = "initializing-client";
    socket.destroy();
    for (const waiter of this.readyWaiters) waiter.reject(new Error("IPC_UNAVAILABLE: 桌面连接已断开"));
    this.readyWaiters.clear();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ type: "response", requestId: "", error: { message: `ipc closed: ${p.method}` } });
    }
    this.pending.clear();
    this.setState("closed");
    if (this.shouldConnect) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 10000);
  }

  private feed(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32LE(0);
      if (len > 64 * 1024 * 1024) {
        this.log("[ipc] 拒绝过大的数据帧");
        this.handleClose();
        return;
      }
      if (this.buf.length < 4 + len) return;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(body.toString("utf-8"));
      } catch {
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.type === "response") {
      const p = this.pending.get(msg.requestId as string);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.requestId as string);
        p.resolve(msg as IpcResponse);
      }
      return;
    }
    if (msg.type === "client-discovery-request") {
      // 自动回应：本客户端不处理任何桌面委托
      this.sendRaw({
        type: "client-discovery-response",
        requestId: msg.requestId,
        response: { canHandle: false },
      });
      return;
    }
    if (msg.type === "broadcast") {
      this.broadcastHandler(msg as unknown as IpcBroadcast);
    }
  }

  private sendRaw(obj: unknown): void {
    if (!this.socket) throw new Error("IPC_UNAVAILABLE: 桌面连接已断开");
    const data = Buffer.from(JSON.stringify(obj));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(data.length);
    this.socket.write(Buffer.concat([head, data]));
  }

  /** 定向 broadcast（follower 订阅/续订用） */
  sendBroadcast(method: string, params: unknown, targetClientIds: string[]): void {
    if (this.state !== "open") return;
    this.sendRaw({
      type: "broadcast",
      sourceClientId: this.clientId,
      targetClientIds,
      method,
      version: 1,
      params,
    });
  }

  call<T = unknown>(method: string, params?: unknown, targetClientId?: string): Promise<T> {
    return this.callFull(method, params, targetClientId).then((r) => {
      if (r.error) {
        // 桌面 IPC 的 error 可能是字符串或 {message}
        const msg = typeof r.error === "string" ? r.error : ((r.error as { message?: string }).message ?? JSON.stringify(r.error));
        throw new Error(`ipc error ${method}: ${msg}`);
      }
      // 顶层 resultType=error 的响应也按错误处理（steer 探测实测形态）
      const rt = (r as { resultType?: string }).resultType;
      if (rt === "error") {
        const e = (r as { error?: unknown }).error;
        const msg = typeof e === "string" ? e : JSON.stringify(e ?? rt);
        throw new Error(`ipc error ${method}: ${msg}`);
      }
      return r.result as T;
    });
  }

  /** 返回完整响应对象（owner-discovery 等把字段放顶层的场景） */
  callFull(method: string, params?: unknown, targetClientId?: string): Promise<IpcResponse> {
    if (method !== "initialize" && this.state !== "open") {
      if (!this.shouldConnect || !this.socket) return Promise.reject(new Error("IPC_UNAVAILABLE: 桌面连接未就绪"));
      return new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve: () => { clearTimeout(timer); resolve(); },
          reject: (e: Error) => { clearTimeout(timer); reject(e); },
        };
        const timer = setTimeout(() => {
          this.readyWaiters.delete(waiter);
          reject(new Error("IPC_UNAVAILABLE: 桌面握手超时"));
        }, this.opts.callTimeoutMs ?? 8000);
        this.readyWaiters.add(waiter);
      }).then(() => this.callFull(method, params, targetClientId));
    }
    if (!this.socket) return Promise.reject(new Error("IPC_UNAVAILABLE: 桌面连接已断开"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`ipc timeout: ${method}`));
      }, this.opts.callTimeoutMs ?? 8000);
      this.pending.set(requestId, {
        method,
        timer,
        resolve: (r) => {
          if (r.error) {
            // call() 语义在 then 里抛；这里把错误响应也交给 resolve 以便 callFull 消费方自行判断
          }
          resolve(r);
        },
      });
      try { this.sendRaw({
        type: "request",
        requestId,
        sourceClientId: this.clientId,
        version: IPC_VERSIONS[method] ?? 0,
        method,
        params,
        targetClientId,
        timeoutMs: this.opts.callTimeoutMs ?? 8000,
      }); } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e);
      }
    });
  }

  /** 握手：取 clientId 与对端信息（任务 1.2） */
  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.call<{ clientId?: string } & Record<string, unknown>>(
      "initialize",
      { clientType: "agentlink-daemon" },
    );
    if (!result?.clientId) throw new Error("IPC_INCOMPATIBLE: 桌面握手缺少 clientId");
    this.clientId = result.clientId;
    return result;
  }
}
