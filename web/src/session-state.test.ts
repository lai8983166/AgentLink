import { describe, expect, test } from "vitest";
import { mergeSessionDetail, mergeResumedDetail } from "./session-state";
import type { SessionDetailResponse } from "@agentlink/shared";
describe("后台重启后的详情恢复", () => {
  test("同一后台旧快照不能覆盖新事件；后台换代后低序号快照必须生效", () => {
    const current = { session: { id: "s1", status: "running" }, latestSeq: 500, serverEpoch: "old" } as SessionDetailResponse;
    const old = { ...current, latestSeq: 10 };
    expect(mergeSessionDetail(current, old)).toBe(current);
    const restarted = { ...old, serverEpoch: "new" };
    expect(mergeSessionDetail(current, restarted)).toBe(restarted);
  });
  test("恢复回执晚于新事件时仍切换本地控制，但保留新运行状态、历史和序号", () => {
    const current = { session: { id: "s1", controlMode: "observe", desktopManaged: true, status: "running", history: [{ id: "new-message" }], approvals: [] }, latestSeq: 12, serverEpoch: "same" } as unknown as SessionDetailResponse;
    const incoming = { session: { id: "s1", controlMode: "local", desktopManaged: false, desktopGone: false, activeElsewhere: false, activeVia: null, approvalPolicy: "never", status: "idle", history: [] }, latestSeq: 10, serverEpoch: "same" } as unknown as SessionDetailResponse;
    const merged = mergeResumedDetail(current, incoming);
    expect(merged.session).toMatchObject({ controlMode: "local", desktopManaged: false, approvalPolicy: "never", status: "running", history: [{ id: "new-message" }] });
    expect(merged.latestSeq).toBe(12);
    expect(mergeResumedDetail(undefined, incoming)).toBe(incoming);
    expect(mergeResumedDetail(current, { ...incoming, serverEpoch: "new" }).latestSeq).toBe(10);
  });
});
