// Headless app fixture: all text, paths, identifiers and credentials are synthetic.
export async function createHost(player) {
  let paired = false;
  let sequence = 0;
  const saved = {};
  const session = { id: "sample-session", title: "人工示例任务", cwd: "/workspace/example", agent: "codex", status: "idle", preview: "人工示例", lastActivityAt: Date.now(), approvalPolicy: "on-request", pendingApprovals: 0, controlMode: "local", tokenUsage: null, approvals: [], history: [{ type: "agentMessage", id: "sample-message", text: "人工构造的回复", at: 1 }] };
  session.history.push({ type: "toolCall", id: "file-1", kind: "fileChange", target: "example.txt", cmd: null, exitCode: 0, durationMs: 1, diffStat: { added: 1, removed: 1 }, outputTail: "-before\n+after", at: 2 });
  session.history.push({ type: "toolCall", id: "command-1", kind: "exec", target: "shell", cmd: "echo synthetic-output", exitCode: 0, durationMs: 1200, diffStat: null, outputTail: "synthetic-output", at: 3 });
  const approval = { ...session, id: "approval-session", title: "人工审批任务", status: "waiting_approval", pendingApprovals: 1, approvals: [{ approvalId: "approval-1", kind: "command", command: "echo synthetic", cwd: "/workspace/example", reason: "人工说明", availableDecisions: ["accept", "decline", "acceptForSession"] }], history: [] };
  const desktop = { ...session, id: "desktop-session", title: "人工观察任务", desktopManaged: true, controlMode: "observe", activeElsewhere: true, history: [] };
  const claude = { ...session, id: "claude:fixture", title: "人工终端任务", agent: "claude", status: "unknown", terminal: { connected: false, inputBlocked: true, canInterrupt: false, reason: "人工终端未连接", permissionMode: null, originalSessionId: "fixture" }, history: [] };
  const sessions = [session, approval, desktop, claude];
  const pairing = () => ({ paired, scope: "test-scope", url: "https://agent.example.com", version: "test" });
  return { call(name, args) {
    if (name !== "client.call") throw new Error("unexpected host name");
    const { op } = args;
    if (op === "bootstrap") return pairing();
    if (op === "pair") { paired = true; return pairing(); }
    if (op === "unpair") { paired = false; return pairing(); }
    if (op === "uuid") return "synthetic-message";
    if (op === "storage.get") return saved[args.key] ?? null;
    if (op === "storage.set") { saved[args.key] = args.value; return true; }
    if (op === "ws.open") { player.hostEvent("client.socket", { id: args.id, kind: "open" }); return true; }
    if (op.startsWith("ws.")) return true;
    if (op === "notifications.status") return { enabled: false, permission: false, running: false, state: "人工通知状态" };
    if (op === "request") {
      let body;
      const current = sessions.find(s => s.id === decodeURIComponent(args.path.split("/")[4]?.split("?")[0] ?? "")) ?? session;
      if (args.path.startsWith("/api/v1/audit")) body = { entries: [{ id: 1, at: 1, sessionId: session.id, project: "/workspace/example", kind: "command", command: "echo synthetic-audit", decision: "accept", source: "mobile" }], nextCursor: null };
      else if (args.path.startsWith("/api/v1/fs")) body = { path: "", entries: [{ name: "示例项目", path: "/workspace/example", kind: "dir" }] };
      else if (args.path === "/api/v1/sessions" && args.method === "POST") body = { id: session.id };
      else if (args.path.startsWith("/api/v1/status")) body = { daemonVersion: "synthetic", mode: "local", latencyMs: 1, rateLimits: null, pendingApprovals: 0 };
      else if (args.path === "/api/v1/sessions" || args.path.includes("scope=all")) body = { sessions };
      else if (args.path.includes("/approvals/")) { approval.approvals = []; approval.pendingApprovals = 0; approval.status = "idle"; body = { ok: true }; }
      else if (args.path.endsWith("/message")) {
        const message = JSON.parse(args.body); session.history.push({ type: "userMessage", id: "u1", clientMessageId: message.clientMessageId, text: message.text, at: 2 }); sequence++;
        body = { ok: true, receipt: { clientMessageId: message.clientMessageId, state: "accepted", updatedAt: 2, error: null } };
      } else body = { session: current, latestSeq: sequence, serverEpoch: "fixture", historyPage: { revision: String(sequence), hasMore: false, total: current.history.length, oldest: "agentMessage:sample-message" }, historySync: { mode: "replace", order: current.history.map(i => i.type + ":" + i.id) } };
      return { status: 200, body: JSON.stringify(body) };
    }
    throw new Error("unexpected operation");
  } };
}
