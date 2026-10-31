import { expect, test } from "bun:test";
import { HistoryWindows } from "./history-window";
import type { SessionDetailResponse } from "@agentlink/shared";

const detail = (count = 1600): SessionDetailResponse => ({
  session: { id: "long", agent: "codex", title: "test", cwd: "F:/test", status: "running", preview: "", lastActivityAt: 0,
    approvalPolicy: "never", pendingApprovals: 0, activeElsewhere: false, activeVia: null, desktopGone: false,
    forkedFromId: null, forkedToId: null, tokenUsage: null,
    history: Array.from({ length: count }, (_, i) => ({ type: "agentMessage", id: String(i), text: "content " + i, at: i })) },
  latestSeq: 1700, serverEpoch: "epoch-a",
});
test("长会话首屏有界；无变化只传元数据，变化、移除和顺序可完整核对", () => {
  const windows = new HistoryWindows(), source = detail();
  const first = windows.window(source);
  expect(first.session.history).toHaveLength(60);
  expect(first.historyPage).toMatchObject({ total: 1600, hasMore: true, oldest: "agentMessage:1540" });
  const unchanged = windows.window(source, { revision: first.historyPage!.revision });
  expect(unchanged.session.history).toEqual([]);
  expect(unchanged.historySync.mode).toBe("patch");
  source.session.history[1598] = { type: "agentMessage", id: "1598", text: "updated", at: 1598 };
  source.session.history.splice(1597, 1);
  source.session.history.push({ type: "userMessage", id: "new", text: "prompt", at: 1601 });
  const update = windows.window(source, { revision: first.historyPage!.revision });
  expect(update.session.history.map(i => i.id)).toEqual(["1598", "new"]);
  expect(update.historySync.order).not.toContain("agentMessage:1597");
});
test("向上分页只补较早条目，保留最新输出；游标裁剪、重启和版本失效回退最近一页", () => {
  const windows = new HistoryWindows(), source = detail(150);
  const first = windows.window(source);
  const older = windows.window(source, { revision: first.historyPage!.revision, before: first.historyPage!.oldest! });
  expect(older.session.history).toHaveLength(60);
  expect(older.historySync.order).toHaveLength(120);
  expect(older.historyPage!.oldest).toBe("agentMessage:30");
  const all = windows.window(source, { revision: older.historyPage!.revision, before: older.historyPage!.oldest! });
  expect(all.session.history).toHaveLength(30); expect(all.historyPage!.hasMore).toBe(false);
  const restarted = new HistoryWindows().window(source, { revision: all.historyPage!.revision });
  expect(restarted.historySync.mode).toBe("replace"); expect(restarted.session.history).toHaveLength(60);
  source.serverEpoch = "epoch-b";
  expect(windows.window(source, { revision: first.historyPage!.revision }).historySync.mode).toBe("replace");
  source.serverEpoch = "epoch-a"; source.session.history = source.session.history.slice(-5);
  expect(windows.window(source, { revision: older.historyPage!.revision }).historySync.mode).toBe("replace");
});
test("空历史随后有内容、错误会话版本不复用，单页字节预算保留完整单条", () => {
  const windows = new HistoryWindows(), source = detail(0);
  const empty = windows.window(source); expect(empty.historyPage!.hasMore).toBe(false);
  source.session.history = detail(3).session.history;
  expect(windows.window(source, { revision: empty.historyPage!.revision }).session.history).toHaveLength(3);
  source.session.history = detail().session.history;
  expect(windows.window(source, { revision: empty.historyPage!.revision }).session.history).toHaveLength(60);
  source.session.id = "other";
  expect(windows.window(source, { revision: empty.historyPage!.revision }).historySync.mode).toBe("replace");
  source.session.history = Array.from({ length: 3 }, (_, i) => ({ type: "agentMessage", id: String(i), text: "x".repeat(300_000), at: i }));
  const large = windows.window(source);
  expect(large.session.history).toHaveLength(1); expect(large.historyPage!.hasMore).toBe(true);
  expect(large.session.history[0]!.type === "agentMessage" && large.session.history[0]!.text.length).toBe(300_000);
});
test("用户消息迟到插入窗口首条模型回复之前，增量不会漏掉；旧页边界后的插入也包含", () => {
  const windows = new HistoryWindows(), source = detail(1);
  const first = windows.window(source);
  source.session.history.unshift({ type: "userMessage", id: "late", text: "prompt", at: 0 });
  const update = windows.window(source, { revision: first.historyPage!.revision });
  expect(update.historySync.order).toEqual(["userMessage:late", "agentMessage:0"]);
  expect(update.session.history.map(i => i.id)).toEqual(["late"]);
  const long = detail(1600), initial = windows.window(long);
  long.session.history.splice(1540, 0, { type: "userMessage", id: "late-boundary", text: "prompt", at: 0 });
  const boundary = windows.window(long, { revision: initial.historyPage!.revision });
  expect(boundary.session.history.map(i => i.id)).toEqual(["late-boundary"]);
  expect(boundary.historySync.order[0]).toBe("userMessage:late-boundary");
});
