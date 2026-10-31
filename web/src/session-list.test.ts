import { expect, test } from "vitest";
import type { SessionSummary } from "@agentlink/shared";
import { recentSessions, RECENT_ACTIVITY_MS } from "./session-list";
test("首页仅保留最近30天，包含边界；缺失时间、旧运行状态及连接探测不能冒充最近活动", () => {
  const now = 2_000_000_000_000;
  const make = (id: string, lastActivityAt: number) => ({ id, lastActivityAt, status: "running", statusUpdatedAt: now } as SessionSummary);
  expect(recentSessions([make("new", now), make("edge", now - RECENT_ACTIVITY_MS), make("old", now - RECENT_ACTIVITY_MS - 1), make("unknown", 0)], now).map(s => s.id)).toEqual(["new", "edge"]);
});
