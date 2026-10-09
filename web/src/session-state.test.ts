import { describe, expect, test } from "vitest";
import { mergeSessionDetail } from "./session-state";
import type { SessionDetailResponse } from "@agentlink/shared";
describe("后台重启后的详情恢复", () => {
  test("同一后台旧快照不能覆盖新事件；后台换代后低序号快照必须生效", () => {
    const current = { session: { id: "s1", status: "running" }, latestSeq: 500, serverEpoch: "old" } as SessionDetailResponse;
    const old = { ...current, latestSeq: 10 };
    expect(mergeSessionDetail(current, old)).toBe(current);
    const restarted = { ...old, serverEpoch: "new" };
    expect(mergeSessionDetail(current, restarted)).toBe(restarted);
  });
});
