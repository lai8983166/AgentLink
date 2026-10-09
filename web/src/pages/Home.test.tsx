import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ListEvent, SessionListResponse, SessionSummary } from "@agentlink/shared";
import { api } from "../runtime";
import { Home } from "./Home";

const events = vi.hoisted(() => ({ sink: null as ((e: ListEvent) => void) | null }));
vi.mock("../runtime", () => ({
  api: { sessions: vi.fn(), status: vi.fn().mockResolvedValue({ rateLimits: null }) },
  ws: { subscribeList: vi.fn((sink) => { events.sink = sink; return () => { events.sink = null; }; }) },
}));

function summary(status: SessionSummary["status"], at: number): SessionSummary {
  return { id: "s1", title: "真实桌面任务", cwd: "F:/project", agent: "codex", status,
    statusUpdatedAt: at, desktopManaged: true, activeElsewhere: false, activeVia: null,
    desktopGone: false, forkedFromId: null, forkedToId: null, preview: "",
    lastActivityAt: 0, approvalPolicy: "never", pendingApprovals: 0 };
}

function mount(initial?: SessionSummary) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (initial) client.setQueryData(["sessions"], { sessions: [initial] });
  render(<QueryClientProvider client={client}><MemoryRouter><Home /></MemoryRouter></QueryClientProvider>);
  return client;
}
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("首页显示权威运行状态", () => {
  test("首次打开就显示真实运行状态，无需进入会话或再刷新", async () => {
    vi.mocked(api.sessions).mockResolvedValueOnce({ sessions: [summary("running", 2)] });
    mount();
    expect(await screen.findByText("运行中")).toBeTruthy();
    expect(screen.queryByText("空闲")).toBeNull();
    expect(api.sessions).toHaveBeenCalledTimes(1);
  });

  test("旧列表响应迟到不能覆盖已到达的运行推送；较新完成推送仍生效", async () => {
    let resolve!: (s: SessionListResponse) => void;
    vi.mocked(api.sessions).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const client = mount(summary("idle", 1));
    await waitFor(() => expect(api.sessions).toHaveBeenCalled());
    act(() => events.sink?.({ type: "session.updated", sessionId: "__all__", seq: 1, at: 2, summary: summary("running", 2) }));
    expect(await screen.findByText("运行中")).toBeTruthy();
    await act(async () => { resolve({ sessions: [summary("idle", 1)] }); });
    expect(screen.queryByText("空闲")).toBeNull();
    expect(client.getQueryData<SessionListResponse>(["sessions"])?.sessions[0]?.status).toBe("running");
    act(() => events.sink?.({ type: "session.updated", sessionId: "__all__", seq: 2, at: 3, summary: summary("done", 3) }));
    expect(await screen.findByText("已完成")).toBeTruthy();
  });

  test("没有有效桌面状态时明确显示待确认，不显示空闲或猜测运行中", async () => {
    vi.mocked(api.sessions).mockResolvedValueOnce({ sessions: [{ ...summary("unknown", 0), activeElsewhere: true }] });
    mount();
    expect(await screen.findByText("状态待确认")).toBeTruthy();
    expect(screen.queryByText("空闲")).toBeNull();
    expect(screen.queryByText("运行中")).toBeNull();
  });
});
