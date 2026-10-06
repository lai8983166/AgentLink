import { describe, expect, test } from "bun:test";
import { diffDesktopState, normalizeSnapshot, revisionOk, type DesktopState } from "./mapper";
import type { ConversationState } from "./protocol";

/** 验证文档同构的快照样例（结构取自 desktop-takeover-verification.md / 探测脚本输出形态） */
function snapshot(over: Partial<ConversationState> = {}): ConversationState {
  return {
    id: "c1",
    forkedFromId: null,
    title: "回复 READY",
    revision: 1,
    latestThreadSettings: { approvalPolicy: "untrusted" },
    turnHistory: {
      history: {
        entitiesByKey: {
          t1: {
            turnId: "t1",
            status: "completed",
            items: [
              { type: "userMessage", content: [{ type: "text", text: "回复 READY" }] },
              { type: "agentMessage", text: "READY", status: "completed" },
            ],
          },
        },
      },
    },
    requests: [],
    ...over,
  };
}

function turn(turnId: string, status: string, items: unknown[]) {
  return [turnId, { turnId, status, items }];
}

describe("快照规范化（2.2）", () => {
  test("userMessage/reasoning 被忽略，agentMessage 保留", () => {
    const s = normalizeSnapshot(snapshot());
    expect(s.turns[0]?.items.map((i) => i.type)).toEqual(["agentMessage"]);
  });

  test("未知 item 类型降级占位卡片", () => {
    const s = normalizeSnapshot(
      snapshot({
        turnHistory: { history: { entitiesByKey: { [turn("t1", "completed", [{ type: "mcpToolCall", id: "x1" }])[0]!]: turn("t1", "completed", [{ type: "mcpToolCall", id: "x1" }])[1]! } } },
      }),
    );
    expect(s.turns[0]?.items[0]?.type).toBe("unknown");
  });

  test("requests 含审批时识别 command/fileChange", () => {
    const s = normalizeSnapshot(
      snapshot({
        requests: [
          { id: "r1", kind: "command", command: "npm install", cwd: "F:/x", availableDecisions: ["accept"] },
          { id: "r2", kind: "fileChangeRequest", changes: [], cwd: "F:/x" },
        ],
      }),
    );
    expect(s.requests.map((r) => r.kind)).toEqual(["command", "fileChange"]);
  });
});

describe("差分映射（2.2）", () => {
  test("首次快照：agent.message + 状态 done", () => {
    const facts = diffDesktopState(null, normalizeSnapshot(snapshot()));
    expect(facts.some((f) => f.kind === "agent.message" && f.text === "READY")).toBe(true);
    expect(facts[facts.length - 1]).toMatchObject({ kind: "session.status", status: "done" });
  });

  test("新增轮次 + 文本增长合成 delta", () => {
    const s1 = normalizeSnapshot(snapshot({ revision: 1 }));
    const s2 = normalizeSnapshot(
      snapshot({
        revision: 2,
        turnHistory: {
          history: {
            entitiesByKey: {
              t1: {
                turnId: "t1",
                status: "completed",
                items: [
                  { type: "userMessage", content: [] },
                  { type: "agentMessage", text: "READY", status: "completed" },
                ],
              },
              t2: {
                turnId: "t2",
                status: "inProgress",
                items: [{ type: "agentMessage", text: "正在", status: "inProgress" }],
              },
            },
          },
        },
      }),
    );
    const facts = diffDesktopState(s1, s2);
    expect(facts.some((f) => f.kind === "agent.message" && f.text === "正在")).toBe(true);
    expect(facts[facts.length - 1]).toMatchObject({ kind: "session.status", status: "running" });
  });

  test("命令执行 started → finished", () => {
    const s1 = normalizeSnapshot(
      snapshot({
        turnHistory: { history: { entitiesByKey: { [turn("t1", "inProgress", [{ type: "commandExecution", command: "pnpm build", status: "inProgress" }])[0]!]: turn("t1", "inProgress", [{ type: "commandExecution", command: "pnpm build", status: "inProgress" }])[1]! } } },
      }),
    );
    const s2 = normalizeSnapshot(
      snapshot({
        revision: 2,
        turnHistory: { history: { entitiesByKey: { [turn("t1", "completed", [{ type: "commandExecution", command: "pnpm build", status: "completed", exitCode: 0, aggregatedOutput: "done" }])[0]!]: turn("t1", "completed", [{ type: "commandExecution", command: "pnpm build", status: "completed", exitCode: 0, aggregatedOutput: "done" }])[1]! } } },
      }),
    );
    const facts = diffDesktopState(s1, s2);
    const fin = facts.find((f) => f.kind === "tool.finished");
    expect(fin).toMatchObject({ exitCode: 0, outputTail: "done" });
  });

  test("requests 新增 → approval.request；消失 → approval.resolved；等待状态优先", () => {
    const s1 = normalizeSnapshot(snapshot());
    const s2 = normalizeSnapshot(
      snapshot({
        revision: 2,
        requests: [{ id: "r1", kind: "command", command: "rm -rf x", cwd: "F:/x", availableDecisions: ["accept", "cancel"] }],
      }),
    );
    let facts = diffDesktopState(s1, s2);
    expect(facts.some((f) => f.kind === "approval.request" && f.requestId === "r1")).toBe(true);
    expect(facts[facts.length - 1]).toMatchObject({ kind: "session.status", status: "waiting_approval" });

    facts = diffDesktopState(s2, s1);
    expect(facts.some((f) => f.kind === "approval.resolved" && f.requestId === "r1")).toBe(true);
  });
});

describe("revision 校验（2.3）", () => {
  test("单调通过、回退拒绝、缺失放行", () => {
    expect(revisionOk(1, 2)).toBe(true);
    expect(revisionOk(2, 1)).toBe(false);
    expect(revisionOk(2, 2)).toBe(false);
    expect(revisionOk(null, 5)).toBe(true);
    expect(revisionOk(3, null)).toBe(true);
  });
});
