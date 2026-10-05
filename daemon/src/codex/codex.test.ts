import { describe, expect, test } from "bun:test";
import { JsonRpcConnection } from "./rpc";
import { mapNotification, mapServerRequest } from "./mapper";
import { CodexBridge, DaemonError } from "./bridge";
import type { CodexTransport, CodexTransportFactory } from "./process";

/* ============ 3.1 分帧与分发 ============ */

describe("JsonRpcConnection", () => {
  test("分片到达也能正确分帧", async () => {
    const written: string[] = [];
    const conn = new JsonRpcConnection((l) => written.push(l), { callTimeoutMs: 500 });
    const notes: string[] = [];
    conn.notificationHandler = (n) => notes.push(n.method);

    const p = conn.call<{ ok: boolean }>("echo");
    // 分片喂入：半行 + 半行 + 两行一起
    conn.feed('{"id":1,"res');
    conn.feed('ult":{"ok":true}}\n{"method":"thread/started","params":{}}\n{"method":"x"}\n');
    await expect(p).resolves.toEqual({ ok: true });
    expect(notes).toEqual(["thread/started", "x"]);
  });

  test("服务端请求可回应", () => {
    const written: string[] = [];
    const conn = new JsonRpcConnection((l) => written.push(l));
    const reqs: Array<{ id: number | string; method: string }> = [];
    conn.serverRequestHandler = (r) => reqs.push(r);
    conn.feed('{"id":7,"method":"item/commandExecution/requestApproval","params":{"threadId":"t1"}}\n');
    expect(reqs).toHaveLength(1);
    conn.respondServer(7, { decision: "acceptForSession" });
    expect(JSON.parse(written[0])).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { decision: "acceptForSession" },
    });
  });

  test("非 JSON 行被忽略不炸", () => {
    const conn = new JsonRpcConnection({ write: () => {} });
    expect(() => conn.feed("not json\n")).not.toThrow();
  });
});

/* ============ 3.3 映射器（录制回放） ============ */

/** 摸底实录（approval.mjs / drive.mjs 输出）中的真实事件样例 */
const recorded = {
  statusActive: {
    method: "thread/status/changed",
    params: { threadId: "t1", status: { type: "active", activeFlags: [] } },
  },
  statusWaiting: {
    method: "thread/status/changed",
    params: { threadId: "t1", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
  },
  statusIdle: {
    method: "thread/status/changed",
    params: { threadId: "t1", status: { type: "idle" } },
  },
  delta: {
    method: "item/agentMessage/delta",
    params: { threadId: "t1", turnId: "x", itemId: "msg_1", delta: "PONG" },
  },
  agentMsgCompleted: {
    method: "item/completed",
    params: {
      threadId: "t1",
      item: { type: "agentMessage", id: "msg_1", text: "PONG", phase: "final_answer" },
    },
  },
  userMsgCompleted: {
    method: "item/completed",
    params: {
      threadId: "t1",
      item: {
        type: "userMessage",
        id: "um_1",
        content: [{ type: "text", text: "Reply with exactly: PONG", text_elements: [] }],
      },
    },
  },
  execStarted: {
    method: "item/started",
    params: {
      threadId: "t1",
      item: { type: "commandExecution", id: "exec-1", command: '"bash.exe" -c \'node --version\'' },
    },
  },
  execCompleted: {
    method: "item/completed",
    params: {
      threadId: "t1",
      item: {
        type: "commandExecution",
        id: "exec-1",
        command: '"bash.exe" -c \'node --version\'',
        exitCode: 0,
        aggregatedOutput: "v24.14.1",
      },
    },
  },
  fileChangeCompleted: {
    method: "item/completed",
    params: {
      threadId: "t1",
      item: {
        type: "fileChange",
        id: "fc-1",
        changes: [{ path: "src/pages/Login.tsx", added: 12, removed: 3 }],
      },
    },
  },
  queueChanged: { method: "thread/queue/changed", params: { threadId: "t1", queue: [{}, {}] } },
  turnCompletedOk: {
    method: "turn/completed",
    params: { threadId: "t1", turn: { id: "x", status: "completed", error: null } },
  },
  turnCompletedErr: {
    method: "turn/completed",
    params: { threadId: "t1", turn: { id: "x", status: "failed", error: { message: "boom" } } },
  },
  tokenUsage: {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "t1",
      turnId: "x",
      tokenUsage: {
        total: { totalTokens: 17290, inputTokens: 17284, cachedInputTokens: 13440, outputTokens: 6 },
      },
    },
  },
  noiseMcp: {
    method: "mcpServer/startupStatus/updated",
    params: { threadId: "t1", name: "node_repl", status: "starting" },
  },
  noiseSkills: { method: "skills/changed", params: {} },
};

describe("映射器 mapNotification", () => {
  test("waitingOnApproval → waiting_approval", () => {
    const f = mapNotification(recorded.statusWaiting);
    expect(f && f.kind === "threadStatus" && f.status).toBe("waiting_approval");
  });
  test("active → running；idle → idle", () => {
    expect(mapNotification(recorded.statusActive)?.kind === "threadStatus").toBe(true);
    const f = mapNotification(recorded.statusIdle);
    expect(f && f.kind === "threadStatus" && f.status).toBe("idle");
  });
  test("流式 delta", () => {
    const f = mapNotification(recorded.delta);
    expect(f).toMatchObject({ kind: "agentDelta", itemId: "msg_1", delta: "PONG" });
  });
  test("完整 agent 消息 / 用户消息", () => {
    expect(mapNotification(recorded.agentMsgCompleted)).toMatchObject({
      kind: "agentMessage",
      text: "PONG",
    });
    expect(mapNotification(recorded.userMsgCompleted)).toMatchObject({
      kind: "userMessage",
      text: "Reply with exactly: PONG",
    });
  });
  test("命令执行 started/completed", () => {
    expect(mapNotification(recorded.execStarted)).toMatchObject({
      kind: "toolStarted",
      toolKind: "exec",
    });
    expect(mapNotification(recorded.execCompleted)).toMatchObject({
      kind: "toolFinished",
      exitCode: 0,
      outputTail: "v24.14.1",
    });
  });
  test("文件改动 completed 带 diff 统计", () => {
    const f = mapNotification(recorded.fileChangeCompleted);
    expect(f).toMatchObject({ kind: "toolFinished", added: 12, removed: 3 });
  });
  test("排队数量", () => {
    const f = mapNotification(recorded.queueChanged);
    expect(f && f.kind === "queueChanged" && f.queued).toBe(2);
  });
  test("turn 完成成功/失败", () => {
    expect(mapNotification(recorded.turnCompletedOk)).toMatchObject({ kind: "turnCompleted", error: null });
    expect(mapNotification(recorded.turnCompletedErr)).toMatchObject({ kind: "turnCompleted", error: "boom" });
  });
  test("token 用量", () => {
    const f = mapNotification(recorded.tokenUsage);
    expect(f && f.kind === "tokenUsage" && f.totalTokens).toBe(17290);
  });
  test("噪音事件被丢弃", () => {
    expect(mapNotification(recorded.noiseMcp)).toBeNull();
    expect(mapNotification(recorded.noiseSkills)).toBeNull();
  });
});

describe("映射器 mapServerRequest（审批）", () => {
  test("命令审批请求（实测样例）", () => {
    const f = mapServerRequest({
      id: 0,
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "command",
        threadId: "t1",
        itemId: "exec-1",
        cwd: "F:\\x",
        command: '"bash.exe" -c \'node --version\'',
        availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["bash"] } }, "cancel"],
      },
    });
    expect(f).toMatchObject({
      kind: "approvalRequest",
      approvalKind: "command",
      command: '"bash.exe" -c \'node --version\'',
      cwd: "F:\\x",
    });
    if (f?.kind === "approvalRequest") expect(f.availableDecisions).toHaveLength(3);
  });
  test("非审批请求返回 null", () => {
    expect(mapServerRequest({ id: 1, method: "item/tool/call", params: {} })).toBeNull();
  });
});

/* ============ 3.4 桥接层：审批挂起 → 决定回包 ============ */

class FakeCodexServer implements CodexTransportFactory {
  written: string[] = [];
  private onData: ((c: string) => void) | null = null;

  create(onData: (c: string) => void): CodexTransport {
    this.onData = onData;
    return {
      write: (line) => {
        this.written.push(line);
        this.handle(line);
      },
      kill: () => {},
      onExit: () => {},
    };
  }

  private handle(line: string): void {
    const msg = JSON.parse(line);
    if (typeof msg.id === "number" && msg.method) {
      // 模拟 codex 响应
      const results: Record<string, unknown> = {
        initialize: { userAgent: "fake" },
        "thread/start": { thread: { id: "t1", environments: [{ cwd: "F:/x" }] } },
        "thread/list": { data: [] },
        "thread/resume": { thread: { id: "t1" } },
        "turn/start": { turn: { id: "turn1" } },
        "turn/interrupt": {},
        "thread/turns/list": { data: [] },
      };
      const result = results[msg.method] ?? {};
      const err =
        msg.method === "thread/resume" && msg.params?.threadId === "busy"
          ? { code: -32600, message: "thread busy already has an active writer" }
          : undefined;
      this.send(err ? { jsonrpc: "2.0", id: msg.id, error: err } : { jsonrpc: "2.0", id: msg.id, result });
    }
  }

  /** 模拟 codex 推送（通知或请求） */
  send(obj: unknown): void {
    this.onData?.(`${JSON.stringify(obj)}\n`);
  }
}

describe("CodexBridge", () => {
  test("审批：请求 → 事实流出 → respondApproval 回包", async () => {
    const fake = new FakeCodexServer();
    const bridge = new CodexBridge(fake);
    const facts: Array<{ kind: string; [k: string]: unknown }> = [];
    bridge.onFact((f) => facts.push(f as unknown as { kind: string }));
    await bridge.start();

    fake.send({
      jsonrpc: "2.0",
      id: 3,
      method: "item/commandExecution/requestApproval",
      params: { kind: "command", threadId: "t1", itemId: "exec-9", command: "npm install", cwd: "F:/x", availableDecisions: ["accept", "cancel"] },
    });
    const apv = facts.find((f) => f.kind === "approvalRequest");
    expect(apv).toBeDefined();
    expect(apv?.rpcId).toBe(3);

    bridge.respondApproval(3, "acceptForSession");
    const last = JSON.parse(fake.written[fake.written.length - 1]);
    expect(last).toEqual({ jsonrpc: "2.0", id: 3, result: { decision: "acceptForSession" } });
  });

  test("resume 单写者冲突 → SESSION_BUSY", async () => {
    const fake = new FakeCodexServer();
    const bridge = new CodexBridge(fake);
    await bridge.start();
    try {
      await bridge.threadResume("busy", "on-request");
      expect.unreachable();
    } catch (e) {
      expect(e instanceof DaemonError && e.code).toBe("SESSION_BUSY");
    }
  });

  test("threadStart 提取嵌套 id", async () => {
    const fake = new FakeCodexServer();
    const bridge = new CodexBridge(fake);
    await bridge.start();
    expect(await bridge.threadStart({ cwd: "F:/x", approvalPolicy: "untrusted" })).toBe("t1");
  });
});
