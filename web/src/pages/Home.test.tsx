import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("首页手动刷新", () => {
  beforeEach(() => {
    vi.mocked(api.sessions).mockReset().mockResolvedValue({ sessions: [] });
    vi.mocked(api.status).mockReset().mockResolvedValue({ rateLimits: null } as Awaited<ReturnType<typeof api.status>>);
  });

  test("按钮同时刷新列表和连接状态，慢请求期间防止重复提交", async () => {
    mount();
    await screen.findByText(/还没有会话/);
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(1));
    let resolve!: (value: SessionListResponse) => void;
    vi.mocked(api.sessions).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const button = screen.getByRole("button", { name: "刷新会话" });
    fireEvent.click(button); fireEvent.click(button);
    expect(button.getAttribute("disabled")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("刷新中…");
    await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(2));
    expect(api.status).toHaveBeenCalledTimes(2);
    await act(async () => { resolve({ sessions: [summary("running", 3)] }); });
    expect(await screen.findByText("运行中")).toBeTruthy();
    expect(await screen.findByText("已刷新")).toBeTruthy();
    expect(button.getAttribute("disabled")).toBeNull();
  });

  test("首次加载失败仍可下拉刷新，显示准确结果并恢复列表", async () => {
    vi.mocked(api.sessions).mockRejectedValueOnce(new Error("offline"));
    mount();
    await screen.findByText(/加载失败/);
    expect(screen.queryByText(/还没有会话/)).toBeNull();
    vi.mocked(api.sessions).mockResolvedValueOnce({ sessions: [summary("running", 4)] });
    const list = screen.getByTestId("session-list");
    const touch = (y: number) => ({ identifier: 1, clientX: 10, clientY: y });
    fireEvent.touchStart(list, { touches: [touch(100)] });
    fireEvent.touchMove(list, { touches: [touch(190)], cancelable: true });
    expect(screen.getByText("松开刷新")).toBeTruthy();
    fireEvent.touchEnd(list, { touches: [] });
    expect(await screen.findByText("运行中")).toBeTruthy();
    expect(await screen.findByText("已刷新")).toBeTruthy();
    expect(api.sessions).toHaveBeenCalledTimes(2);
  });

  test("仅连接状态刷新失败也显示失败，下次重试可恢复且保留已有会话", async () => {
    vi.mocked(api.sessions).mockResolvedValue({ sessions: [summary("running", 4)] });
    mount(); await screen.findByText("运行中");
    vi.mocked(api.status).mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "刷新会话" }));
    expect(await screen.findByText("刷新失败，请重试")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新会话" }));
    expect(await screen.findByText("已刷新")).toBeTruthy();
    expect(api.sessions).toHaveBeenCalledTimes(3);
    expect(api.status).toHaveBeenCalledTimes(3);
  });
});
