import { describe, expect, test, vi } from "vitest";
import { HistoryReader } from "./history-reader";
import type { HistoryCache } from "./history-cache";
import type { HistoryWindowResponse, SessionDetailResponse } from "@agentlink/shared";
const item = (id: string, text = id) => ({ type: "agentMessage" as const, id, text, at: 0 });
function wire(mode: "replace" | "patch", revision: string, ids: string[], changed = ids, baseRevision?: string): HistoryWindowResponse {
  return { session: { id: "s1", agent: "codex", title: "session", cwd: "F:/test", status: "running", preview: "", lastActivityAt: 0,
    approvalPolicy: "never", pendingApprovals: 0, activeElsewhere: false, activeVia: null, desktopGone: false,
    forkedFromId: null, forkedToId: null, tokenUsage: null, history: changed.map(id => item(id)) },
    latestSeq: 10, serverEpoch: "epoch",
    historyPage: { revision, hasMore: true, total: 1600, oldest: ids.length ? "agentMessage:" + ids[0] : null },
    historySync: { mode, baseRevision, order: ids.map(id => "agentMessage:" + id) } };
}
const cache = (): HistoryCache => {
  const data = new Map<string, SessionDetailResponse>();
  return { get: vi.fn(async key => data.get(key)), put: vi.fn(async (key, value) => { data.set(key, structuredClone(value)); }), clear: vi.fn(async () => { data.clear(); }) };
};
describe("历史窗口 HTTP 基准和持久缓存", () => {
  test("首屏、无变化、增改删和旧记录翻页顺序完整，HTTP 不使用 WS 改过的历史作基准", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire("replace", "v1", ["60", "61"]))
      .mockResolvedValueOnce(wire("patch", "v1", ["60", "61"], [], "v1"))
      .mockResolvedValueOnce(wire("patch", "v2", ["59", "60", "62"], ["59", "62"], "v1"));
    const reader = new HistoryReader(fetcher, () => "server+token", cache());
    const first = await reader.load("s1");
    expect(first.session.history.map(i => i.id)).toEqual(["60", "61"]);
    const live = { ...first, session: { ...first.session, history: [...first.session.history, item("ws-only")] } };
    const unchanged = await reader.load("s1");
    expect(unchanged.session.history).toEqual(first.session.history);
    expect(live.session.history).toHaveLength(3);
    const older = await reader.load("s1", true);
    expect(fetcher.mock.calls[2]![1].get("before")).toBe("agentMessage:60");
    expect(older.session.history.map(i => i.id)).toEqual(["59", "60", "62"]);
    expect(fetcher.mock.calls[1]![1].get("revision")).toBe("v1");
  });
  test("重开从缓存传版本，缓存只供查看；后台重启 replace 清除旧窗口", async () => {
    const disk = cache();
    await new HistoryReader(vi.fn().mockResolvedValue(wire("replace", "v1", ["60"])), () => "scope", disk).load("s1");
    const fetcher = vi.fn().mockResolvedValue({ ...wire("replace", "v2", ["99"]), serverEpoch: "new" });
    const reader = new HistoryReader(fetcher, () => "scope", disk);
    const cached = await reader.cached("s1");
    expect(cached?.session.status).toBe("unknown"); expect(cached?.historyPage?.cached).toBe(true);
    expect(cached?.session.approvals).toEqual([]);
    const fresh = await reader.load("s1");
    expect(fetcher.mock.calls[0]![1].get("revision")).toBe("v1");
    expect(fresh.session.history.map(i => i.id)).toEqual(["99"]);
    expect(fresh.historyPage?.cached).toBeUndefined();
  });
  test("损坏增量只读回退最近一页，缺少内容不推进基准", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire("replace", "v1", ["a"]))
      .mockResolvedValueOnce(wire("patch", "bad", ["missing"], [], "v1"))
      .mockResolvedValueOnce(wire("replace", "v2", ["b"]));
    const reader = new HistoryReader(fetcher, () => "scope", cache());
    await reader.load("s1");
    expect((await reader.load("s1")).session.history.map(i => i.id)).toEqual(["b"]);
    expect(fetcher.mock.calls[2]![1].has("revision")).toBe(false);
  });
  test("连接地址与 token 隔离，切换配对后的在途响应不写入缓存", async () => {
    let scope = "server1/token1", resolve!: (wire: HistoryWindowResponse) => void;
    const disk = cache(), fetcher = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const reader = new HistoryReader(fetcher, () => scope, disk);
    const request = reader.load("s1");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    scope = "server2/token2"; resolve(wire("replace", "old", ["private"]));
    await expect(request).rejects.toThrow("配对已变更");
    expect(disk.put).not.toHaveBeenCalled(); expect(await reader.cached("s1")).toBeUndefined();
  });
  test("缓存故障不影响同步，并发定时核对合并请求，清除后不接收旧结果", async () => {
    const disk = cache(); vi.mocked(disk.get).mockRejectedValue(new Error("quota"));
    vi.mocked(disk.put).mockRejectedValue(new Error("quota"));
    let resolve!: (wire: HistoryWindowResponse) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const reader = new HistoryReader(fetcher, () => "scope", disk);
    const first = reader.load("s1"), second = reader.load("s1");
    expect(first).toBe(second);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    reader.clear(); resolve(wire("replace", "old", ["a"]));
    await expect(first).rejects.toThrow(); expect(disk.clear).toHaveBeenCalled();
  });
});
