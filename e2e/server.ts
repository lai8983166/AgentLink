// 仅供测试：独立端口、临时数据库、模拟桌面，无 Codex 进程或真实 IPC。
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, websocket, type DaemonApp } from "../daemon/src/server";
import { CodexBridge, DaemonError } from "../daemon/src/codex/bridge";
import { FakeCodexServer } from "../daemon/src/testing/fake-codex";
import { DesktopSessionManager } from "../daemon/src/ipc/desktop-manager";
import { IpcClient, type PipeLikeSocket } from "../daemon/src/ipc/client";

const token = "isolated-e2e-token";
const root = mkdtempSync(join(tmpdir(), "agentlink-e2e-"));
const webDist = join(import.meta.dir, "../web/dist");
const builtVersion = JSON.parse(readFileSync(join(webDist, "version.json"), "utf8")).build as string;
let pwaVersion: "old" | "legacy" | "new" | null = null;
const legacyPage = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>旧桌面入口<script>navigator.serviceWorker.register("/sw.js",{scope:"/"})</script></body></html>';
let caseNumber = 0;
let auditPath = "";
let fixture: DaemonApp;
let pipes: TestPipe[] = [];
const sockets = new Set<{ close(code?: number, reason?: string): void }>();
let state: { revision: number; requests: unknown[]; status: string; items: unknown[]; approvalReject: boolean; sends: string[]; approvalMethods: string[];
  ownerAvailable: boolean; ownerError: string | null; writerHeld: boolean;
  delayedMessages: boolean; turns: Array<{ turnId: string; params: { clientUserMessageId: string }; items: unknown[]; pendingUser?: unknown }> };

class TestPipe implements PipeLikeSocket {
  private handlers = new Map<string, (...args: any[]) => void>();
  on(event: string, cb: (...args: any[]) => void): unknown { this.handlers.set(event, cb); return this; }
  destroy(): void { pipes = pipes.filter((p) => p !== this); }
  emit(event: string, ...args: any[]): void { this.handlers.get(event)?.(...args); }
  response(obj: unknown): void {
    const body = Buffer.from(JSON.stringify(obj)); const head = Buffer.alloc(4); head.writeUInt32LE(body.length);
    this.emit("data", Buffer.concat([head, body]));
  }
  snapshot(): void {
    if (!state.ownerAvailable) return;
    this.response({ type: "broadcast", params: { conversationId: "old1", change: { type: "snapshot", revision: state.revision, conversationState: {
      id: "old1", title: "远程可靠性测试",
      latestThreadSettings: { approvalPolicy: "never" },
      turnHistory: { history: { entitiesByKey: { active: { turnId: "active", status: state.status, items: state.items },
        ...Object.fromEntries(state.turns.map((turn) => [turn.turnId, { turnId: turn.turnId, params: turn.params, items: turn.items, status: state.status }])),
      } } },
      requests: state.requests,
    } } } });
  }
  write(bytes: Buffer): boolean {
    const msg = JSON.parse(bytes.subarray(4).toString());
    if (msg.type === "broadcast") { if (msg.params?.following) this.snapshot(); return true; }
    if (msg.type !== "request") return true;
    if (msg.method === "initialize") this.response({ type: "response", requestId: msg.requestId, result: { clientId: "e2e-follower" } });
    else if (msg.method === "thread-owner-discovery") this.response(state.ownerError || !state.ownerAvailable
      ? { type: "response", requestId: msg.requestId, resultType: "error", error: state.ownerError ?? "no-client-found" }
      : { type: "response", requestId: msg.requestId, resultType: "success", handledByClientId: "e2e-owner" });
    else if (msg.method.includes("approval-decision")) {
      state.approvalMethods.push(msg.method);
      if (state.approvalReject) this.response({ type: "response", requestId: msg.requestId, error: "desktop rejected" });
      else {
        state.requests = []; state.revision++; push();
        this.response({ type: "response", requestId: msg.requestId, result: { ok: true } });
      }
    } else if (msg.method === "thread-follower-start-turn") {
      const request = msg.params.turnStart.request;
      state.sends.push(request.clientUserMessageId);
      const user = { id: "server-" + request.clientUserMessageId, type: "userMessage", content: [{ type: "text", text: request.input[0].text }], status: "completed" };
      state.turns.push({ turnId: "turn-" + request.clientUserMessageId, params: { clientUserMessageId: request.clientUserMessageId },
        items: state.delayedMessages ? [{ id: "model-" + request.clientUserMessageId, type: "agentMessage", text: "模型先到的回复", status: "inProgress" }] : [user],
        ...(state.delayedMessages ? { pendingUser: user } : {}),
      });
      state.revision++; push();
      this.response({ type: "response", requestId: msg.requestId, result: { ok: true } });
    } else this.response({ type: "response", requestId: msg.requestId, result: { ok: true } });
    return true;
  }
}
function push(): void { for (const pipe of pipes) pipe.snapshot(); }
function commandRequest(id: number, kind = "command") {
  return { id, method: kind === "command" ? "item/commandExecution/requestApproval" : "item/fileChange/requestApproval",
    params: { command: kind === "command" ? "echo E2E" : null, cwd: "F:/e2e", availableDecisions: ["accept", "decline"] } };
}
async function build(reset: boolean) {
  fixture?.desktop?.shutdown(); fixture?.bridge.stop(); fixture?.audit.close(); fixture?.controls.close();
  if (reset) {
    pwaVersion = null;
    auditPath = join(root, String(++caseNumber), "audit.db");
    state = { revision: 1, requests: [commandRequest(2)], status: "inProgress", items: [], approvalReject: false, sends: [], approvalMethods: [], delayedMessages: false, turns: [], ownerAvailable: true, ownerError: null, writerHeld: false };
  }
  const fake = new FakeCodexServer(); const bridge = new CodexBridge(fake); await bridge.start();
  fake.onTurnStart = (params) => {
    const threadId = params.threadId as string;
    fake.notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
    fake.notify("item/completed", { threadId, item: { type: "userMessage", id: crypto.randomUUID(), content: params.input } });
  };
  fixture = createApp({ token, allowedRoots: [root], bridge, auditPath,
    assertNoWriter: async () => { if (state.writerHeld) throw new DaemonError("SESSION_BUSY", "原会话仍被其他入口持有，请先关闭该会话"); },
    resumeSettings: async () => ({ sandbox: "danger-full-access", approvalPolicy: "never" }),
    desktopFactory: (bus, approvals, controls) => new DesktopSessionManager(bus, approvals, {
    controls, log: () => {}, clientFactory: () => new IpcClient(() => { const pipe = new TestPipe(); pipes.push(pipe); queueMicrotask(() => pipe.emit("connect")); return pipe; }, { callTimeoutMs: 300 }),
  }) });
  await fixture.registry.start();
  fixture.app.post("/__test__/control", async (c) => {
    const action = await c.req.json();
    if (action.type === "reset") await build(true);
    else if (action.type === "pwaVersion") pwaVersion = action.version;
    else if (action.type === "restart") { await build(false); for (const socket of sockets) socket.close(1012, "fixture restart"); }
    else if (action.type === "rejectApproval") state.approvalReject = action.enabled;
    else if (action.type === "ownership") { state.ownerAvailable = action.available; state.ownerError = action.error ?? null; state.writerHeld = action.writerHeld ?? false; }
    else if (action.type === "resumeConflict") fake.resumeError = "thread already has an active writer";
    else if (action.type === "fileApproval") { state.requests = [commandRequest(3, "fileChange")]; state.revision++; push(); }
    else if (action.type === "done") { state.status = "completed"; state.requests = []; state.revision++; push(); }
    else if (action.type === "delayMessages") state.delayedMessages = true;
    else if (action.type === "flushMessages") {
      const baseRevision = state.revision;
      const patches = state.turns.filter((t) => t.pendingUser).map((turn) => {
        const user = turn.pendingUser; delete turn.pendingUser; turn.items.unshift(user);
        return { op: "add", path: ["turnHistory", "history", "entitiesByKey", turn.turnId, "items", 0], value: user };
      });
      state.revision++;
      for (const pipe of pipes) pipe.response({ type: "broadcast", params: { conversationId: "old1", change: { type: "patches", baseRevision, revision: state.revision, patches } } });
    }
    return c.json({ ok: true });
  });
  fixture.app.post("/__test__/metrics", (c) => c.json({ sends: state.sends, approvalMethods: state.approvalMethods,
    resumeCalls: fake.written.filter((line) => JSON.parse(line).method === "thread/resume").length,
    resumes: fake.written.map((line) => JSON.parse(line)).filter((m) => m.method === "thread/resume").map((m) => m.params),
    localSends: fake.written.map((line) => JSON.parse(line)).filter((m) => m.method === "turn/start").map((m) => m.params),
    forkCalls: fake.written.filter((line) => JSON.parse(line).method === "thread/fork").length,
  }));
}
await build(true);
Bun.serve({ hostname: "127.0.0.1", port: 48917, fetch: (req, server) => {
  const pathname = new URL(req.url).pathname;
  // Serve two versions without modifying production dist or connecting to real user sessions.
  if (pwaVersion && pathname === "/version.json") {
    return Response.json({ build: pwaVersion === "new" ? builtVersion : "pwa-old" }, { headers: { "Cache-Control": "no-store" } });
  }
  if (pwaVersion === "legacy" && (pathname === "/" || pathname === "/index.html")) {
    return new Response(legacyPage, { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
  }
  if ((pwaVersion === "old" || pwaVersion === "legacy") && pathname === "/sw.js") {
    const script = readFileSync(join(webDist, "sw.js"), "utf8").replace(/revision:(?:null|"[^"]+")/g, 'revision:"pwa-old"');
    return new Response(script + "\n// isolated old PWA\n", { headers: { "Content-Type": "application/javascript", "Cache-Control": "no-store" } });
  }
  if ((pwaVersion === "old" || pwaVersion === "legacy") && /^\/assets\/[a-zA-Z0-9_-]+\.js$/.test(pathname)) {
    const script = readFileSync(join(webDist, pathname.slice(1)), "utf8").replaceAll(builtVersion, "pwa-old");
    return new Response(script, { headers: { "Content-Type": "application/javascript", "Cache-Control": "no-store" } });
  }
  return fixture.app.fetch(req, server);
}, websocket: {
  ...websocket,
  open(ws) { sockets.add(ws); websocket.open?.(ws); },
  close(ws, code, reason) { sockets.delete(ws); websocket.close?.(ws, code, reason); },
} });
