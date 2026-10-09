// 仅供测试：独立端口、临时数据库、模拟桌面，无 Codex 进程或真实 IPC。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, websocket, type DaemonApp } from "../daemon/src/server";
import { CodexBridge } from "../daemon/src/codex/bridge";
import { FakeCodexServer } from "../daemon/src/testing/fake-codex";
import { DesktopSessionManager } from "../daemon/src/ipc/desktop-manager";
import { IpcClient, type PipeLikeSocket } from "../daemon/src/ipc/client";

const token = "isolated-e2e-token";
const root = mkdtempSync(join(tmpdir(), "agentlink-e2e-"));
let caseNumber = 0;
let auditPath = "";
let fixture: DaemonApp;
let pipes: TestPipe[] = [];
const sockets = new Set<{ close(code?: number, reason?: string): void }>();
let state: { revision: number; requests: unknown[]; status: string; items: unknown[]; approvalReject: boolean; sends: string[]; approvalMethods: string[] };

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
    this.response({ type: "broadcast", params: { conversationId: "old1", change: { type: "snapshot", conversationState: {
      id: "old1", title: "远程可靠性测试", revision: state.revision,
      latestThreadSettings: { approvalPolicy: "never" },
      turnHistory: { history: { entitiesByKey: { active: { turnId: "active", status: state.status, items: state.items } } } },
      requests: state.requests,
    } } } });
  }
  write(bytes: Buffer): boolean {
    const msg = JSON.parse(bytes.subarray(4).toString());
    if (msg.type === "broadcast") { if (msg.params?.following) this.snapshot(); return true; }
    if (msg.type !== "request") return true;
    if (msg.method === "initialize") this.response({ type: "response", requestId: msg.requestId, result: { clientId: "e2e-follower" } });
    else if (msg.method === "thread-owner-discovery") this.response({ type: "response", requestId: msg.requestId, resultType: "success", handledByClientId: "e2e-owner" });
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
      state.items.push({ id: request.clientUserMessageId, type: "userMessage", content: [{ type: "text", text: request.input[0].text }], status: "completed" });
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
    auditPath = join(root, String(++caseNumber), "audit.db");
    state = { revision: 1, requests: [commandRequest(2)], status: "inProgress", items: [], approvalReject: false, sends: [], approvalMethods: [] };
  }
  const fake = new FakeCodexServer(); const bridge = new CodexBridge(fake); await bridge.start();
  fixture = createApp({ token, allowedRoots: [root], bridge, auditPath, desktopFactory: (bus, approvals, controls) => new DesktopSessionManager(bus, approvals, {
    controls, log: () => {}, clientFactory: () => new IpcClient(() => { const pipe = new TestPipe(); pipes.push(pipe); queueMicrotask(() => pipe.emit("connect")); return pipe; }, { callTimeoutMs: 300 }),
  }) });
  await fixture.registry.start();
  fixture.app.post("/__test__/control", async (c) => {
    const action = await c.req.json();
    if (action.type === "reset") await build(true);
    else if (action.type === "restart") { await build(false); for (const socket of sockets) socket.close(1012, "fixture restart"); }
    else if (action.type === "rejectApproval") state.approvalReject = action.enabled;
    else if (action.type === "fileApproval") { state.requests = [commandRequest(3, "fileChange")]; state.revision++; push(); }
    else if (action.type === "done") { state.status = "completed"; state.requests = []; state.revision++; push(); }
    return c.json({ ok: true });
  });
  fixture.app.post("/__test__/metrics", (c) => c.json({ sends: state.sends, approvalMethods: state.approvalMethods,
    resumeCalls: fake.written.filter((line) => JSON.parse(line).method === "thread/resume").length }));
}
await build(true);
Bun.serve({ hostname: "127.0.0.1", port: 48917, fetch: (req, server) => fixture.app.fetch(req, server), websocket: {
  ...websocket,
  open(ws) { sockets.add(ws); websocket.open?.(ws); },
  close(ws, code, reason) { sockets.delete(ws); websocket.close?.(ws, code, reason); },
} });
