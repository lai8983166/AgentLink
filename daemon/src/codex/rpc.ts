import type { CodexNotification, CodexServerRequest } from "./protocol";

/**
 * JSON-RPC over stdio 连接（任务 3.1）。
 * 按行分帧、请求-响应 id 匹配、通知/服务端请求分发。
 * 与传输解耦：注入 read/write 流即可用假流测试。
 */

export interface JsonRpcConnectionOptions {
  callTimeoutMs?: number;
}

interface Pending {
  resolve: (v: { result?: unknown; error?: { code: number; message: string } }) => void;
  method: string;
  timer: Timer;
}

export class JsonRpcConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private closed = false;

  notificationHandler?: (n: CodexNotification) => void;
  serverRequestHandler?: (r: CodexServerRequest) => void;
  closeHandler?: () => void;

  constructor(
    private readonly write: (line: string) => void,
    private readonly opts: JsonRpcConnectionOptions = {},
  ) {}

  /** 从子进程 stdout 喂入数据（可分片） */
  feed(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.handleLine(line);
    }
  }

  markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ error: { code: -32000, message: `connection closed: ${p.method}` } });
    }
    this.pending.clear();
    this.closeHandler?.();
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非 JSON 行（codex 偶发 stderr 串扰等）忽略
    }
    if (typeof msg.id === "number" || typeof msg.id === "string") {
      if (msg.method) {
        // 服务端请求（带 id，需要回应）
        this.serverRequestHandler?.({
          id: msg.id as number | string,
          method: msg.method as string,
          params: msg.params as Record<string, unknown> | undefined,
        });
      } else {
        // 响应
        const id = typeof msg.id === "string" ? Number(msg.id) : (msg.id as number);
        const p = this.pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.resolve({
            result: msg.result,
            error: msg.error as { code: number; message: string } | undefined,
          });
        }
      }
    } else if (msg.method) {
      this.notificationHandler?.({
        method: msg.method as string,
        params: msg.params as Record<string, unknown> | undefined,
      });
    }
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`json-rpc timeout: ${method}`));
      }, this.opts.callTimeoutMs ?? 30000);
      this.pending.set(id, {
        method,
        timer,
        resolve: (v) => {
          if (v.error) reject(new RpcError(method, v.error.code, v.error.message));
          else resolve(v.result as T);
        },
      });
      this.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** 回应服务端请求（审批决定等） */
  respondServer(requestId: number | string, result: unknown): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, result }));
  }

  rejectServer(requestId: number | string, code: number, message: string): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, error: { code, message } }));
  }
}

/** codex JSON-RPC 错误（-32600 已占用等） */
export class RpcError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}
