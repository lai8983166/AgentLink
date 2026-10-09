import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { SessionDetail, SessionEvent } from "@agentlink/shared";
import { Session } from "./Session";
import { api } from "../runtime";

const stream = vi.hoisted(() => ({ sink: null as ((e: SessionEvent) => void) | null }));

vi.mock("../runtime", () => ({
  api: {
    sessionDetail: vi.fn(),
    observe: vi.fn().mockResolvedValue({ ok: true }),
    resume: vi.fn().mockResolvedValue({ ok: true }),
    takeover: vi.fn().mockResolvedValue({ ok: true }),
  },
  ws: { subscribe: vi.fn((_id, sink) => { stream.sink = sink; return () => { stream.sink = null; }; }), onSnapshotRequired: null },
}));

function session(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "desktop-1", title: "桌面测试", cwd: "F:/project", agent: "codex",
    status: "idle", activeElsewhere: true, activeVia: "Codex 桌面端",
    desktopGone: false, forkedFromId: null, forkedToId: null, preview: "",
    lastActivityAt: 0, approvalPolicy: "on-request", pendingApprovals: 0,
    history: [], tokenUsage: null, ...overrides,
  };
}

function mount(initial: SessionDetail) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["session", initial.id], { session: initial, latestSeq: 0 });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/${initial.id}`]}>
        <Routes><Route path="/:sessionId" element={<Session />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.sessionDetail).mockImplementation(() => new Promise(() => {})); });
afterEach(cleanup);

describe("原会话连接不会回落到独立 resume", () => {
  test("打开页面直接从快照恢复审批和接管，不依赖旧实时事件", async () => {
    const pending = { approvalId: "2", kind: "command" as const, command: "echo approve", cwd: "F:/project", reason: null, availableDecisions: ["accept"] };
    mount(session({ desktopManaged: true, status: "waiting_approval", controlMode: "takeover", approvals: [pending] }));
    expect(await screen.findByText("echo approve")).toBeTruthy();
    expect(screen.getByText("批准")).toBeTruthy();
    expect(screen.queryByText("接管此会话")).toBeNull();
    expect((screen.getByPlaceholderText(/发送消息/) as HTMLInputElement).disabled).toBe(false);
  });

  test("权威快照移除已在电脑处理的审批；失联时接管态也禁止发送", async () => {
    const initial = session({ desktopManaged: true, controlMode: "takeover", status: "waiting_approval", approvals: [{ approvalId: "2", kind: "command", command: "echo approve", cwd: "F:/project", reason: null, availableDecisions: ["accept"] }] });
    const client = mount(initial);
    await screen.findByText("批准");
    await act(async () => { client.setQueryData(["session", initial.id], { session: { ...initial, status: "unknown", desktopGone: true, approvals: [] }, latestSeq: 3 }); });
    await waitFor(() => expect(screen.queryByText("批准")).toBeNull());
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
  });

  test("迟到 HTTP 快照不能覆盖较新的审批事件和运行状态", async () => {
    let respond!: (v: { session: SessionDetail; latestSeq: number }) => void;
    vi.mocked(api.sessionDetail).mockReturnValueOnce(new Promise((r) => { respond = r; }));
    const client = mount(session({ desktopManaged: true, approvals: [] }));
    await waitFor(() => expect(api.sessionDetail).toHaveBeenCalled());
    act(() => stream.sink?.({ type: "approval.request", sessionId: "desktop-1", seq: 2, at: 2, approvalId: "2", kind: "command", command: "new approval", cwd: "F:/project", reason: null, availableDecisions: ["accept"] }));
    act(() => stream.sink?.({ type: "session.status", sessionId: "desktop-1", seq: 3, at: 3, status: "waiting_approval", activity: null }));
    await act(async () => { respond({ session: session({ desktopManaged: true, status: "idle", approvals: [] }), latestSeq: 1 }); });
    expect(await screen.findByText("new approval")).toBeTruthy();
    expect(client.getQueryData<{ latestSeq: number }>(["session", "desktop-1"])?.latestSeq).toBe(3);
  });
  test("桌面会话闲置且 owner 不可达：只观察，失败也不自动 resume", async () => {
    vi.mocked(api.observe).mockRejectedValueOnce({ code: "IPC_OWNER_NOT_FOUND" });
    mount(session({ desktopManaged: true, activeElsewhere: false, desktopGone: true }));
    await screen.findByText("电脑端连接不可用，请在 Codex 中打开原会话后重试");
    expect(api.observe).toHaveBeenCalledWith("desktop-1");
    expect(api.resume).not.toHaveBeenCalled();
  });

  test("接管后 activeElsewhere 清零、owner 丢失均不会触发 resume", async () => {
    // 兼容旧摘要尚无 desktopManaged 的连接：本页接管态也必须保持 IPC。
    const client = mount(session());
    await waitFor(() => expect(api.observe).toHaveBeenCalled());
    fireEvent.click(screen.getByText("接管此会话"));
    await waitFor(() => expect(screen.queryByText("接管此会话")).toBeNull());
    await act(async () => {
      client.setQueryData(["session", "desktop-1"], {
        session: session({ activeElsewhere: false, desktopGone: false }), latestSeq: 1,
      });
    });
    await act(async () => {
      client.setQueryData(["session", "desktop-1"], {
        session: session({ activeElsewhere: false, desktopGone: true }), latestSeq: 2,
      });
    });
    expect(api.takeover).toHaveBeenCalledWith("desktop-1");
    expect(api.resume).not.toHaveBeenCalled();
  });

  test("普通 AgentLink 会话仍走 resume", async () => {
    mount(session({ desktopManaged: false, activeElsewhere: false, activeVia: null }));
    await waitFor(() => expect(api.resume).toHaveBeenCalledWith("desktop-1"));
    expect(api.observe).not.toHaveBeenCalled();
  });
});
