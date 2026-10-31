import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeSessions } from "./sessions";
import { claudeRouter } from "./transport";
import { SessionEventBus } from "../events/bus";
import { FsService } from "../domain/fs";
import { AuditStore } from "../domain/audit";
import { PushStore } from "../notify/push-store";
import { WebPushService } from "../notify/web-push";
import { mergeClaudeHistory } from "./history";
import type { ClaudeEvent, ClaudeExchange, HistoryItem } from "@agentlink/shared";

const cleaners: Array<() => void> = [];
afterEach(() => { for (const close of cleaners.splice(0).reverse()) close(); });
function setup(persistent = false) {
  const dir = mkdtempSync(join(tmpdir(), "agentlink-claude-"));
  cleaners.push(() => { expect(dirname(resolve(dir))).toBe(resolve(tmpdir())); expect(basename(dir).startsWith("agentlink-claude-")).toBe(true); rmSync(dir, { recursive: true, force: true }); });
  const bus = new SessionEventBus(), fs = new FsService([dir]), audit = new AuditStore(join(dir, "audit.db"));
  cleaners.push(() => audit.close());
  let now = Date.now(), sequence = 0;
  const path = persistent ? join(dir, "claude.db") : ":memory:";
  let service = new ClaudeSessions(path, bus, fs, audit, () => now);
  cleaners.push(() => service.close());
  const raw = randomUUID(), id = "claude:" + raw;
  const packet: ClaudeExchange = { protocol: 1, sessionId: raw, instanceId: "original", cwd: dir, version: "2.1.314", status: "unknown", turnId: null, inputBlocked: false, permissionMode: "manual", events: [] };
  const exchange = (type?: ClaudeEvent["type"], data: Record<string, unknown> = {}) => service.exchange({ ...packet, events: type ? [{ seq: ++sequence, type, data }] : [] });
  exchange("connected");
  return { dir, bus, audit, id, raw, packet, exchange, get service() { return service; }, advance: () => { now += 7000; }, restart: () => { service.close(); service = new ClaudeSessions(path, bus, fs, audit, () => now); } };
}

test("原终端注册；失联为 unknown，不能伪报空闲或停止执行", () => {
  const f = setup();
  expect(f.service.list()[0]).toMatchObject({ id: f.id, agent: "claude", status: "unknown", terminal: { connected: true } });
  f.packet.status = "running"; f.packet.turnId = "turn-1"; f.exchange("started", { turnId: "turn-1" });
  f.advance(); f.service.sweep();
  expect(f.service.detail(f.id).session).toMatchObject({ status: "unknown", terminal: { connected: false, canInterrupt: false } });
  expect(() => f.service.sendMessage(f.id, "x", "m1")).toThrow("未连接");
});
test("消息持久排队、同 ID 去重；终端真正开始后才 accepted，顺序在输出之前", () => {
  const f = setup();
  expect(f.service.sendMessage(f.id, "继续", "m1").state).toBe("queued");
  expect(f.service.sendMessage(f.id, "继续", "m1").state).toBe("queued");
  expect(() => f.service.sendMessage(f.id, "别的内容", "m1")).toThrow("同一消息");
  expect(f.exchange().commands).toHaveLength(1);
  f.exchange("command", { commandId: "m1", state: "queued" });
  expect(f.exchange().commands).toHaveLength(0);
  f.packet.status = "running"; f.packet.turnId = "t";
  f.exchange("command", { commandId: "m1", state: "started" });
  f.exchange("text", { itemId: "t:0", text: "回答" });
  expect(f.service.messageReceipt(f.id, "m1")?.state).toBe("accepted");
  expect(f.service.detail(f.id).session.history.map(h => h.type)).toEqual(["userMessage", "agentMessage"]);
});
test("Esc 限制与原生权限模式保留；旧结果不能冒充成功", () => {
  const f = setup(); f.service.sendMessage(f.id, "x", "m1");
  f.packet.inputBlocked = true;
  f.exchange("command", { commandId: "m1", state: "rejected", reason: "the session was stopped" });
  expect(f.service.messageReceipt(f.id, "m1")).toMatchObject({ state: "failed", error: "the session was stopped" });
  expect(() => f.service.sendMessage(f.id, "y", "m2")).toThrow("Esc");
  expect(f.service.detail(f.id).session.terminal?.permissionMode).toBe("manual");
});
test("事件重传不重复文本；daemon 重启后同实例继续，插件换代不重发旧指令", () => {
  const f = setup(true);
  const events = [{ seq: 2, type: "text" as const, data: { itemId: "a", text: "一次" } }];
  f.service.exchange({ ...f.packet, events }); f.service.exchange({ ...f.packet, events });
  expect(f.service.detail(f.id).session.history).toHaveLength(1);
  f.service.sendMessage(f.id, "x", "pending"); f.restart();
  expect(f.service.exchange({ ...f.packet, events }).commands).toHaveLength(1);
  expect(f.service.detail(f.id).session.history[0]).toMatchObject({ text: "一次" });
  f.advance(); f.packet.instanceId = "replacement"; f.exchange();
  expect(f.service.messageReceipt(f.id, "pending")?.state).toBe("uncertain");
  expect(f.exchange().commands).toHaveLength(0);
  expect(() => f.service.exchange({ ...f.packet, instanceId: "original", events: [] })).toThrow("竞争");
});
test("本机桥鉴权与协议检查；公网配对 token 不能直接连接插件通道", async () => {
  const f = setup(), app = claudeRouter(f.service, "bridge-only-secret");
  expect((await app.request("/exchange", { method: "POST", body: "{}" })).status).toBe(401);
  expect((await app.request("/exchange", { method: "POST", headers: { Authorization: "Bearer bridge-only-secret", Origin: "https://untrusted.example" }, body: "{}" })).status).toBe(401);
  expect((await app.request("/exchange", { method: "POST", headers: { Authorization: "Bearer bridge-only-secret" }, body: "{}" })).status).toBe(400);
});
test("审批仅一次，恢复快照包含审批；电脑处理后旧按钮不可用", async () => {
  const f = setup();
  f.exchange("approval", { approvalId: "a", name: "Bash", input: { command: "echo test" } });
  const waiting = f.service.waitApproval(f.raw, "original", "a");
  expect(f.service.detail(f.id).session.approvals).toHaveLength(1);
  f.service.decide(f.id, "a", "accept");
  expect(await waiting).toEqual({ state: "decided", decision: "allow" });
  expect(() => f.service.decide(f.id, "a", "decline")).toThrow("失效");
  expect(f.audit.list(null).entries[0]?.source).toBe("claude-mobile-submitted");
  f.exchange("approval", { approvalId: "b", name: "Read", input: { file_path: "test" } });
  const other = f.service.waitApproval(f.raw, "original", "b");
  f.exchange("approvalEnd", { approvalId: "b" });
  expect(await other).toEqual({ state: "closed" });
  expect(() => f.service.decide(f.id, "b", "accept")).toThrow("失效");
});
test("无需手机订阅，终端完成入安卓通知队列，断线不会产生完成通知", async () => {
  const f = setup(), push = new WebPushService(new PushStore(), async () => {});
  cleaners.push(() => { push.stop(); push.store.close(); });
  const device = randomUUID(); push.store.registerNative(device);
  f.bus.tap(e => push.onEvent(e));
  f.packet.status = "running"; f.packet.turnId = "t"; f.exchange("started", { turnId: "t" });
  f.advance(); f.service.sweep();
  expect(await push.nativeInbox(device, undefined, 0)).toHaveLength(0);
  f.packet.status = "done"; f.packet.turnId = null; f.exchange("completed", { turnId: "t", answer: "好了", isAborted: false });
  const jobs = await push.nativeInbox(device, undefined, 0);
  expect(jobs).toHaveLength(1); expect(jobs[0]?.notification.url).toBe("/" + encodeURIComponent(f.id));
  f.exchange(); expect(await push.nativeInbox(device, undefined, 0)).toHaveLength(1);
});
test("同一个原终端的未决审批可在后台重启后重新建立等待，不自动批准", async () => {
  const f = setup(true);
  f.packet.status = "waiting_approval";
  f.exchange("approval", { approvalId: "surviving", name: "Bash", input: { command: "echo safe" } });
  const before = f.service.waitApproval(f.raw, "original", "surviving");
  f.restart(); expect(await before).toEqual({ state: "closed" });
  f.exchange();
  const after = f.service.waitApproval(f.raw, "original", "surviving");
  f.service.decide(f.id, "surviving", "decline");
  expect(await after).toEqual({ state: "decided", decision: "deny" });
});
test("快照逐条复用重复文本的关联 ID，工具不冒充命令", () => {
  const prior: HistoryItem[] = [ { type: "userMessage", id: "m1", clientMessageId: "m1", text: "继续", at: 1 }, { type: "userMessage", id: "m2", clientMessageId: "m2", text: "继续", at: 2 } ];
  const result = mergeClaudeHistory([{ role: "user", text: "继续" }, { role: "user", text: "继续" }, { role: "assistant", text: "", toolUses: [{ id: "tool", name: "Read", input: { file_path: "a.txt" }, isError: false }] }], prior, 3);
  expect(result.slice(0, 2).map(h => h.id)).toEqual(["m1", "m2"]);
  expect(result[2]).toMatchObject({ type: "toolCall", kind: "tool", target: "Read" });
});
