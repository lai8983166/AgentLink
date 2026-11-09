export const summary = {
  id: "sample-session", title: "人工示例任务", cwd: "/workspace/example", agent: "codex" as const,
  status: "idle" as const, activeElsewhere: false, activeVia: null, desktopGone: false,
  forkedFromId: null, forkedToId: null, preview: "人工构造的演示内容", lastActivityAt: 1794182400000,
  approvalPolicy: "on-request" as const, pendingApprovals: 0,
};
export const detail = {
  session: { ...summary, controlMode: "local" as const, history: [{ type: "agentMessage" as const, id: "a", text: "人工示例回复", at: 1 }], approvals: [], tokenUsage: null },
  latestSeq: 10, serverEpoch: "synthetic-epoch", historyPage: { revision: "r1", hasMore: true, total: 2, oldest: "agentMessage:a" },
  historySync: { mode: "replace" as const, order: ["agentMessage:a"] },
};
export const status = { daemonVersion: "test-only", mode: "local", latencyMs: 1, rateLimits: null, pendingApprovals: 0 };
