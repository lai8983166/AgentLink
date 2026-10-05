import { describe, expect, test } from "bun:test";
import {
  ApiErrorBody,
  ClientMessage,
  CreateSessionRequest,
  HistoryItem,
  ListEvent,
  ServerMessage,
  SessionEvent,
} from "./index";

describe("错误 envelope（2.1）", () => {
  test("合法错误体通过", () => {
    const body = { error: { code: "SESSION_BUSY", message: "会话正在电脑上使用中" } };
    expect(ApiErrorBody.parse(body).error.code).toBe("SESSION_BUSY");
  });
  test("未知错误码被拒绝", () => {
    expect(() => ApiErrorBody.parse({ error: { code: "NOPE", message: "x" } })).toThrow();
  });
});

describe("REST 请求（2.1）", () => {
  test("建会话请求：默认策略 on-request", () => {
    const r = CreateSessionRequest.parse({
      projectPath: "F:/project/webapp",
      prompt: "修复登录白屏",
    });
    expect(r.approvalPolicy).toBe("on-request");
  });
  test("建会话请求：三档策略均合法", () => {
    for (const p of ["untrusted", "on-request", "never"] as const) {
      expect(
        CreateSessionRequest.parse({ projectPath: "x", prompt: "y", approvalPolicy: p }).approvalPolicy,
      ).toBe(p);
    }
  });
  test("空 prompt 被拒绝", () => {
    expect(() => CreateSessionRequest.parse({ projectPath: "x", prompt: "" })).toThrow();
  });
});

describe("事件契约（2.2）", () => {
  const base = { sessionId: "s1", seq: 1, at: 1791200000 };

  test("session.status 事件", () => {
    const e = SessionEvent.parse({
      ...base,
      type: "session.status",
      status: "waiting_approval",
      activity: "rm -rf node_modules",
    });
    expect(e.type).toBe("session.status");
  });

  test("approval.request 携带动态决定列表", () => {
    const e = SessionEvent.parse({
      ...base,
      type: "approval.request",
      approvalId: "a1",
      kind: "command",
      command: "npm install",
      cwd: "F:/x",
      reason: null,
      availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["bash"] } }],
    });
    if (e.type === "approval.request") {
      expect(e.availableDecisions).toHaveLength(2);
    }
  });

  test("非法状态值被拒绝", () => {
    expect(() =>
      SessionEvent.parse({ ...base, type: "session.status", status: "paused", activity: null }),
    ).toThrow();
  });

  test("历史条目 discriminated union", () => {
    expect(
      HistoryItem.parse({ type: "userMessage", id: "m1", text: "hi", at: 1 }).type,
    ).toBe("userMessage");
    expect(() =>
      HistoryItem.parse({ type: "userMessage", id: "m1", text: "hi", at: "1" }),
    ).toThrow();
  });

  test("列表级事件", () => {
    const e = ListEvent.parse({
      sessionId: "__all__",
      seq: 3,
      at: 1,
      type: "session.created",
      summary: {
        id: "s1",
        title: "t",
        cwd: "c",
        agent: "codex",
        status: "running",
        preview: "p",
        lastActivityAt: 1,
        approvalPolicy: "on-request",
        pendingApprovals: 0,
      },
    });
    expect(e.type).toBe("session.created");
  });
});

describe("WS 协议（2.3）", () => {
  test("subscribe 带 lastSeq", () => {
    const m = ClientMessage.parse({ type: "subscribe", sessionId: "s1", lastSeq: 42 });
    if (m.type === "subscribe") expect(m.lastSeq).toBe(42);
  });
  test("server event 包裹", () => {
    const m = ServerMessage.parse({
      type: "event",
      event: { sessionId: "s1", seq: 1, at: 1, type: "error", message: "boom" },
    });
    expect(m.type).toBe("event");
  });
  test("snapshot.required", () => {
    const m = ServerMessage.parse({ type: "snapshot.required", sessionId: "s1" });
    expect(m.type).toBe("snapshot.required");
  });
  test("未知客户端消息被拒绝", () => {
    expect(() => ClientMessage.parse({ type: "hack" })).toThrow();
  });
});
