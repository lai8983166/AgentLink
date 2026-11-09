// Headless app fixture: all text, paths, identifiers and credentials are synthetic.
export async function createHost(player) {
  let paired = false;
  let sequence = 0;
  const saved = {};
  const session = { id: "sample-session", title: "人工示例任务", cwd: "/workspace/example", agent: "codex", status: "idle", preview: "人工示例", lastActivityAt: Date.now(), approvalPolicy: "on-request", pendingApprovals: 0, controlMode: "local", tokenUsage: null, approvals: [], history: [{ type: "agentMessage", id: "sample-message", text: "人工构造的回复", at: 1 }] };
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
      if (args.path === "/api/v1/status") body = { daemonVersion: "synthetic", mode: "local", latencyMs: 1, rateLimits: null, pendingApprovals: 0 };
      else if (args.path === "/api/v1/sessions" || args.path.includes("scope=all")) body = { sessions: [session] };
      else if (args.path.endsWith("/message")) {
        const message = JSON.parse(args.body); session.history.push({ type: "userMessage", id: "u1", clientMessageId: message.clientMessageId, text: message.text, at: 2 }); sequence++;
        body = { ok: true, receipt: { clientMessageId: message.clientMessageId, state: "accepted", updatedAt: 2, error: null } };
      } else body = { session, latestSeq: sequence, serverEpoch: "fixture", historyPage: { revision: String(sequence), hasMore: false, total: session.history.length, oldest: "agentMessage:sample-message" }, historySync: { mode: "replace", order: session.history.map(i => i.type + ":" + i.id) } };
      return { status: 200, body: JSON.stringify(body) };
    }
    throw new Error("unexpected operation");
  } };
}
