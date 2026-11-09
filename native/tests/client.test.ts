import { describe, test, expect, afterEach } from "bun:test";
import { Client, canControl, decisions, decodeDetail, mergeWindow, type Port } from "../core/client";
import { SessionListResponse, ServerMessage, NativeDelivery, MessageReceipt } from "../../shared/src/index";
import { detail, status, summary } from "./fixtures";

class FakePort implements Port {
  writes: any[] = []; calls: any[] = []; stored: Record<string, string> = {}; index = 0;
  reply: (path: string, method: string, body: any) => any = path => {
    if (path === "/api/v1/status") return status;
    if (path.startsWith("/api/v1/sessions?" ) || path === "/api/v1/sessions") return { sessions: [summary] };
    if (path.includes("/messages/")) return { receipt: null };
    return detail;
  };
  async call(op: string, data: any = {}) {
    this.calls.push({ op, ...data });
    if (op === "bootstrap") return { paired: true, scope: "fixture-scope", url: "https://agent.example.com" };
    if (op === "storage.get") return this.stored[data.key] ?? null;
    if (op === "storage.set") { this.stored[data.key] = data.value; return true; }
    if (op === "uuid") return `synthetic-${++this.index}`;
    if (op.startsWith("ws.")) return true;
    if (op === "request") {
      const body = data.body ? JSON.parse(data.body) : null;
      if (data.method !== "GET") this.writes.push(data);
      return { status: 200, body: JSON.stringify(await this.reply(data.path, data.method, body)) };
    }
    throw new Error("Unexpected synthetic operation");
  }
}
const clients: Client[] = [];
function make() { const port = new FakePort(); const client = new Client(port); clients.push(client); return { port, client }; }
afterEach(() => { for (const c of clients.splice(0)) c.dispose(); });

describe("NSH shared wire contracts", () => {
  test("Codex and disconnected Claude summaries use the same validators", () => {
    expect(SessionListResponse.parse({ sessions: [summary, { ...summary, id: "claude:example", agent: "claude", terminal: { connected: false, inputBlocked: true, canInterrupt: false, reason: null, permissionMode: null, originalSessionId: "example" } }] }).sessions.length).toBe(2);
    expect(canControl({ ...detail, session: { ...detail.session, agent: "claude" } }, true)).toBe(false);
  });
  test("malformed patch cannot silently fall back to full-detail decoding", () => {
    expect(() => decodeDetail({ ...detail, historySync: { mode: "patch" } })).toThrow();
    expect(decodeDetail(detail).session.id).toBe(summary.id);
  });
  test("patch requires correct epoch, base revision, complete unique ordering", () => {
    const base = mergeWindow(undefined, detail)!;
    const patch = { ...detail, historyPage: { ...detail.historyPage, revision: "r2" }, historySync: { mode: "patch" as const, baseRevision: "r1", order: ["agentMessage:a"] } };
    expect(mergeWindow(base, patch)?.historyPage?.revision).toBe("r2");
    expect(mergeWindow(base, { ...patch, serverEpoch: "other" })).toBeUndefined();
    expect(mergeWindow(base, { ...patch, historySync: { ...patch.historySync, order: ["missing"] } })).toBeUndefined();
    expect(mergeWindow(base, { ...patch, historySync: { ...patch.historySync, order: ["agentMessage:a", "agentMessage:a"] } })).toBeUndefined();
  });
  test("unknown controls and empty advanced approval decisions fail closed", () => {
    expect(canControl(detail, false)).toBe(false);
    expect(canControl({ ...detail, session: { ...detail.session, controlMode: "observe" } }, true)).toBe(false);
    expect(decisions([])).toEqual([]);
    expect(decisions([{ custom: true }, "accept", "invented"])).toEqual(["accept"]);
  });
  test("notification, receipt, replay and reset messages validate", () => {
    expect(NativeDelivery.safeParse({ id: "00000000-0000-4000-8000-000000000001", expiresAt: 100, notification: { title: "人工标题", body: "人工正文", url: "/sample-session", tag: "test" } }).success).toBe(true);
    for (const state of ["queued", "accepted", "uncertain"]) expect(MessageReceipt.safeParse({ clientMessageId: "sample", state, updatedAt: 1, error: null }).success).toBe(true);
    for (const message of [{ type: "snapshot.required", sessionId: summary.id, serverEpoch: "new" }, { type: "event", event: { type: "agent.delta", sessionId: summary.id, itemId: "a", seq: 12, at: 1, delta: "人工片段", serverEpoch: "new" } }]) expect(ServerMessage.safeParse(message).success).toBe(true);
  });
});

describe("NSH client safe operations", () => {
  test("native launch pairing is restored without waiting for a bootstrap host call or network", async () => {
    const { port, client } = make();
    const call = port.call.bind(port);
    port.call = async (op, data) => { if (op === "bootstrap") throw new Error("must not require startup bridge roundtrip"); return call(op, data); };
    port.reply = () => { throw new Error("offline"); };
    await client.bootstrap({ paired: true, scope: "saved-scope", url: "https://agent.example.com" });
    expect(client.view.startup).toBe("ready"); expect(client.view.pairing?.paired).toBe(true);
    expect(port.calls.some(c => c.op === "pair")).toBe(false);
  });
  test("restore failure is distinct from unpaired and a read-only retry recovers", async () => {
    const { port, client } = make();
    await client.bootstrap({ restoreError: true });
    expect(client.view.startup).toBe("error"); expect(client.view.pairing).toBeNull();
    await client.bootstrap(); expect(client.view.startup).toBe("ready"); expect(client.view.pairing?.paired).toBe(true);
    expect(port.calls.some(c => c.op === "pair" || c.op === "unpair")).toBe(false);
  });
  test("slow local restore stays loading rather than falsely displaying unpaired", async () => {
    const { port, client } = make(); const call = port.call.bind(port);
    let resolve!: (value: unknown) => void;
    port.call = async (op, data) => op === "bootstrap" ? new Promise(r => { resolve = r; }) : call(op, data);
    const restoring = client.bootstrap(); expect(client.view.startup).toBe("loading");
    resolve({ paired: false, scope: "", url: "" }); await restoring;
    expect(client.view.startup).toBe("ready"); expect(client.view.pairing?.paired).toBe(false);
  });
  test("opening a normal session only reads and never resumes or forks", async () => {
    const { port, client } = make(); await client.bootstrap(); await client.open(summary.id);
    expect(port.writes).toEqual([]); expect(client.view.fresh).toBe(true);
  });
  test("lost send response persists identity and never resends on recheck/restart", async () => {
    const { port, client } = make(); await client.bootstrap(); await client.open(summary.id);
    const original = port.reply;
    port.reply = path => { if (path.endsWith("/message")) throw new Error("synthetic disconnect"); return original(path, "GET", null); };
    client.setDraft("人工测试指令"); await client.send(); await client.recheck();
    expect(port.writes.filter(w => w.path.endsWith("/message")).length).toBe(1);
    expect(client.view.outbox.messages[0]?.state).toBe("uncertain");
    client.dispose();
    const next = new Client(port); clients.push(next); await next.bootstrap(); await next.open(summary.id); await next.recheck();
    expect(port.writes.filter(w => w.path.endsWith("/message")).length).toBe(1);
  });
  test("queued becomes accepted without clearing a newer draft", async () => {
    const { port, client } = make(); await client.bootstrap(); await client.open(summary.id);
    const original = port.reply; let receiptState = "queued";
    port.reply = path => path.endsWith("/message") || path.includes("/messages/") ? { receipt: { clientMessageId: "synthetic-1", state: receiptState, updatedAt: 1, error: null } } : original(path, "GET", null);
    client.setDraft("第一条人工指令"); await client.send(); client.setDraft("新的草稿"); receiptState = "accepted"; await client.recheck();
    expect(client.view.outbox.draft).toBe("新的草稿"); expect(client.view.outbox.messages[0]?.state).toBe("accepted");
  });
  test("storage failure prevents sending an unrecorded message", async () => {
    const { port, client } = make(); await client.bootstrap(); await client.open(summary.id);
    const call = port.call.bind(port); port.call = async (op, data) => { if (op === "storage.set") throw new Error("full"); return call(op, data); };
    client.setDraft("测试"); await client.send(); expect(port.writes).toEqual([]);
  });
  test("typing while message identity is saved does not erase the newer draft", async () => {
    const { port, client } = make(); await client.bootstrap(); await client.open(summary.id);
    const call = port.call.bind(port); let release!: () => void;
    port.call = async (op, data) => {
      if (op === "uuid") await new Promise<void>(r => { release = r; });
      return call(op, data);
    };
    client.setDraft("第一条"); const sending = client.send(); client.setDraft("新的草稿"); release(); await sending;
    expect(client.view.outbox.draft).toBe("新的草稿");
    expect(JSON.parse(port.writes[0].body).text).toBe("第一条");
  });
  test("offline cached history disables controls", async () => {
    const { port, client } = make(); port.stored.history = JSON.stringify([detail]);
    port.reply = () => { throw new Error("offline"); };
    await client.bootstrap(); await client.open(summary.id); client.setDraft("不可发送"); await client.send();
    expect(client.view.sessions.map(s => s.id)).toContain(summary.id);
    expect(client.view.detail?.session.history.length).toBe(1); expect(client.view.fresh).toBe(false); expect(port.writes).toEqual([]);
  });
  test("invalid patch triggers a fresh read without a write", async () => {
    const { port, client } = make(); await client.bootstrap(); await client.open(summary.id);
    port.reply = path => path.includes("revision=") ? { ...detail, historySync: { mode: "patch", baseRevision: "wrong", order: ["agentMessage:a"] } } : detail;
    await client.load(summary.id); expect(port.calls.some(c => c.path?.endsWith("?history=window"))).toBe(true); expect(port.writes).toEqual([]);
  });
  test("create timeout is not retried", async () => {
    const { port, client } = make(); await client.bootstrap();
    port.reply = () => { throw new Error("unknown creation result"); };
    client.view.project = "/workspace/example"; client.view.prompt = "人工新任务"; await client.create();
    expect(port.writes.length).toBe(1); expect(client.view.prompt).toBe("人工新任务");
  });
  test("expired authorization with a non-JSON response still disables controls", async () => {
    const { port, client } = make(); await client.bootstrap(); await client.open(summary.id);
    const call = port.call.bind(port);
    port.call = async (op, data) => op === "request" ? { status: 401, body: "Unauthorized" } : call(op, data);
    await client.refresh(); client.setDraft("人工指令"); await client.send();
    expect(client.view.fresh).toBe(false); expect(port.writes).toHaveLength(0);
  });
  test("unknown ownership and disconnected Claude block every control action", async () => {
    const { port, client } = make(); await client.bootstrap(); await client.open(summary.id);
    client.view.detail!.session.status = "unknown";
    for (const action of ["resume", "takeover", "fork", "interrupt", "policy"] as const) await client.action(action);
    client.view.detail!.session = { ...client.view.detail!.session, status: "idle", agent: "claude", terminal: { connected: false, canInterrupt: false, inputBlocked: true, reason: null, permissionMode: null, originalSessionId: "sample" } };
    for (const action of ["resume", "takeover", "fork", "interrupt", "policy"] as const) await client.action(action);
    expect(port.writes).toHaveLength(0);
  });
  test("approval decisions use current server capabilities and competing decisions remain errors", async () => {
    const { port, client } = make(); await client.bootstrap(); await client.open(summary.id);
    client.view.detail!.session.approvals = [{ approvalId: "synthetic-approval", kind: "command", command: "echo example", cwd: "/workspace/example", reason: null, availableDecisions: ["accept", "decline"] }] as any;
    await client.approve("synthetic-approval", "acceptForSession"); expect(port.writes).toHaveLength(0);
    const call = port.call.bind(port);
    port.call = async (op, data) => {
      if (op === "request" && data?.method === "POST") {
        port.writes.push(data); return { status: 409, body: JSON.stringify({ error: { code: "CONFLICT", message: "已由另一客户端处理" } }) };
      }
      return call(op, data);
    };
    await Promise.all([client.approve("synthetic-approval", "accept"), client.approve("synthetic-approval", "accept")]);
    expect(port.writes).toHaveLength(1); expect(client.view.notice).toContain("另一客户端");
  });
  test("history cache persists at most eight sessions and excludes an oversized entry", async () => {
    const { port, client } = make(); await client.bootstrap();
    port.reply = path => ({ ...detail, session: { ...detail.session, id: decodeURIComponent(path.split("/").at(-1)!.split("?")[0]) } });
    for (let n = 0; n < 10; n++) await client.load("synthetic-" + n);
    expect(JSON.parse(port.stored.history).length).toBe(8);
    port.reply = () => ({ ...detail, session: { ...detail.session, id: "large", history: [{ type: "agentMessage", id: "a", text: "x".repeat(5 * 1024 * 1024), at: 1 }] } });
    await client.load("large"); expect(port.stored.history.length * 2).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
  test("corrupt cache recovers online and all-directory includes older sessions", async () => {
    const { port, client } = make(); port.stored.history = "invalid-json"; await client.bootstrap(); await client.open(summary.id);
    expect(client.view.fresh).toBe(true);
    client.view.sessions = [{ ...summary, lastActivityAt: Date.now() - 31 * 86400000 }];
    expect(client.filtered()).toHaveLength(0); client.view.agent = "codex"; expect(client.filtered()).toHaveLength(1);
  });
  test("late history after unpair cannot restore the old identity", async () => {
    const { port, client } = make(); await client.bootstrap();
    let resolve!: (value: any) => void;
    port.reply = () => new Promise(r => { resolve = r; });
    const loading = client.load(summary.id).catch(() => undefined);
    await client.unpair(); resolve(detail); await loading;
    expect(client.view.detail).toBeUndefined(); expect(port.stored.history).toBeUndefined();
  });
});
