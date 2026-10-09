import { JsonRpcConnection, RpcError } from "./rpc";
import { mapNotification, mapServerRequest, type MappedFact } from "./mapper";
import {
  CodexMethod,
  type CodexApprovalDecision,
  type CodexApprovalPolicy,
  type CodexThreadInfo,
  type CodexThreadListResult,
  type CodexThreadTurnsResult,
} from "./protocol";
import type { CodexTransport, CodexTransportFactory } from "./process";

/** 域层错误：code 即 shared ApiErrorCode */
export class DaemonError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

/**
 * CodexBridge（任务 3.2/3.4）：子进程生命周期 + 协议操作 + 事件流出口。
 * - 崩溃自动重启（指数退避），重启后由上层（SessionRegistry）重建状态
 * - 事实订阅：映射后的 MappedFact 流
 */
export class CodexBridge {
  ready = false;
  private conn: JsonRpcConnection | null = null;
  private restartDelayMs = 500;
  private restarting = false;
  private stopped = false;
  private transport: CodexTransport | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private factListeners = new Set<(f: MappedFact) => void>();
  private exitListeners = new Set<() => void>();

  constructor(private readonly transportFactory: CodexTransportFactory) {}

  onFact(cb: (f: MappedFact) => void): () => void {
    this.factListeners.add(cb);
    return () => this.factListeners.delete(cb);
  }

  /** 重启后通知（SessionRegistry 触发状态重建） */
  onRestart(cb: () => void): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.spawnAndInitialize();
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.conn?.markClosed();
    this.transport?.kill();
  }

  private emitFact(f: MappedFact): void {
    for (const cb of this.factListeners) cb(f);
  }

  private async spawnAndInitialize(): Promise<void> {
    this.ready = false;
    // 传输与连接循环依赖：用可变引用解耦，连接先建、写出后接通
    let transport: CodexTransport | null = null;
    const conn = new JsonRpcConnection(
      (line) => {
        transport?.write(line);
      },
      { callTimeoutMs: 30000 },
    );
    this.conn = conn;

    conn.notificationHandler = (n) => {
      if (this.conn !== conn) return;
      const f = mapNotification(n);
      if (f) this.emitFact(f);
    };
    conn.serverRequestHandler = (r) => {
      if (this.conn !== conn) return;
      const f = mapServerRequest(r);
      if (f) this.emitFact(f);
    };
    conn.closeHandler = () => { if (this.conn === conn) this.handleExit(null); };

    const t = this.transportFactory.create((chunk) => conn.feed(chunk));
    transport = t;
    this.transport = t;
    t.onExit(() => { if (this.conn === conn) conn.markClosed(); });

    try { await conn.call(CodexMethod.initialize, {
      clientInfo: { name: "agentlink", title: "AgentLink", version: "0.1.0" },
    });
      if (!this.stopped && this.conn === conn) this.ready = true;
    } catch (e) {
      conn.markClosed(); t.kill(); throw e;
    }
  }

  private handleExit(code: number | null): void {
    this.ready = false;
    if (this.stopped) return;
    if (this.restarting) return;
    this.restarting = true;
    console.warn(`[bridge] codex app-server exited (code=${code}), restarting in ${this.restartDelayMs}ms`);
    for (const cb of this.exitListeners) cb();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped) return;
      this.restarting = false;
      this.restartDelayMs = Math.min(this.restartDelayMs * 2, 10000);
      this.spawnAndInitialize().then(() => {
        this.restartDelayMs = 500;
      }).catch((e) => console.warn("[bridge] restart initialize failed:", e.message));
    }, this.restartDelayMs);
  }

  private get rpc(): JsonRpcConnection {
    if (!this.conn) throw new DaemonError("INTERNAL", "bridge not started");
    return this.conn;
  }

  /* ============ 域操作（映射 shared 契约） ============ */

  async threadStart(opts: {
    cwd: string;
    approvalPolicy: CodexApprovalPolicy;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  }): Promise<string> {
    const res = await this.rpc.call<{ thread?: { id?: string }; id?: string }>(CodexMethod.threadStart, {
      cwd: opts.cwd,
      approvalPolicy: opts.approvalPolicy,
      sandbox: opts.sandbox ?? "workspace-write",
    });
    const id = res?.thread?.id ?? res?.id;
    if (!id) throw new DaemonError("INTERNAL", "thread/start 未返回 id");
    return id;
  }

  async threadList(): Promise<CodexThreadInfo[]> {
    const res = await this.rpc.call<CodexThreadListResult>(CodexMethod.threadList, {
      cursor: null,
      limit: 100,
    });
    return res?.data ?? [];
  }

  /** fork 既有会话（含 busy 会话）为归本方管理的新会话（兜底接力） */
  async threadFork(threadId: string, approvalPolicy: CodexApprovalPolicy): Promise<CodexThreadInfo> {
    const res = await this.rpc.call<{ thread?: CodexThreadInfo }>(CodexMethod.threadFork, {
      threadId,
      approvalPolicy,
    });
    if (!res?.thread) throw new DaemonError("INTERNAL", "thread/fork 未返回 thread");
    return res.thread;
  }

  async threadResume(
    threadId: string,
    approvalPolicy: CodexApprovalPolicy,
  ): Promise<CodexThreadInfo> {
    try {
      const res = await this.rpc.call<{ thread?: CodexThreadInfo }>(CodexMethod.threadResume, {
        threadId,
        approvalPolicy,
      });
      if (!res?.thread) throw new DaemonError("INTERNAL", "thread/resume 未返回 thread");
      return res.thread;
    } catch (e) {
      if (e instanceof RpcError && /active writer/i.test(e.message)) {
        throw new DaemonError("SESSION_BUSY", "会话正在电脑上使用中（被 IDE/Codex Desktop 占用）");
      }
      if (e instanceof RpcError && /not found|unknown thread/i.test(e.message)) {
        throw new DaemonError("SESSION_NOT_FOUND", "会话不存在");
      }
      throw e;
    }
  }

  async threadTurns(threadId: string): Promise<CodexThreadTurnsResult> {
    // desc：取最新轮次（长会话只拉最近 50 轮，旧行为 asc 会停在会话开头）
    const res = await this.rpc.call<CodexThreadTurnsResult>(CodexMethod.threadTurnsList, {
      threadId,
      cursor: null,
      limit: 50,
      sortDirection: "desc",
    });
    // desc 返回最新在前 → 反转成时间正序，供历史渲染
    if (res?.data) res.data = [...res.data].reverse();
    return res;
  }

  async turnStart(threadId: string, text: string, approvalPolicy: CodexApprovalPolicy): Promise<void> {
    await this.rpc.call(CodexMethod.turnStart, {
      threadId,
      input: [{ type: "text", text }],
      approvalPolicy,
    });
  }

  async turnInterrupt(threadId: string): Promise<void> {
    await this.rpc.call(CodexMethod.turnInterrupt, { threadId });
  }

  /** 回应审批（挂起的服务端请求） */
  respondApproval(rpcId: number | string, decision: CodexApprovalDecision): void {
    this.rpc.respondServer(rpcId, { decision });
  }

  rejectApproval(rpcId: number | string, message: string): void {
    this.rpc.rejectServer(rpcId, 32000, message);
  }
}
