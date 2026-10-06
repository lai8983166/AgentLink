import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DesktopBanner } from "./DesktopBanner";
import { api } from "../runtime";

vi.mock("../runtime", () => ({
  api: {
    takeover: vi.fn().mockResolvedValue({ ok: true }),
    fork: vi.fn().mockResolvedValue({ id: "fork-9" }),
    observe: vi.fn().mockResolvedValue({ ok: true }),
  },
  ws: { subscribe: vi.fn(() => () => {}), onSnapshotRequired: () => {} },
}));

const base: Parameters<typeof DesktopBanner>[0] = {
  sessionId: "s1",
  activeElsewhere: false,
  activeVia: "ChatGPT 桌面端",
  desktopGone: false,
  takenOver: false,
  forkedFromId: null,
  forkedToId: null,
  onTakenOver: () => {},
};

function ui(props: Partial<Parameters<typeof DesktopBanner>[0]> = {}) {
  return (
    <MemoryRouter>
      <DesktopBanner {...base} {...props} />
    </MemoryRouter>
  );
}

describe("DesktopBanner（任务 5.1-5.3）", () => {
  test("观察模式：显示占用方与接管按钮", () => {
    render(ui({ activeElsewhere: true }));
    expect(screen.getByText(/ChatGPT 桌面端运行中/)).toBeTruthy();
    expect(screen.getByText("接管此会话")).toBeTruthy();
  });

  test("点击接管 → API + onTakenOver（输入解禁）", async () => {
    const onTakenOver = vi.fn();
    render(ui({ activeElsewhere: true, onTakenOver }));
    fireEvent.click(screen.getByText("接管此会话"));
    await waitFor(() => expect(onTakenOver).toHaveBeenCalled());
    expect(api.takeover).toHaveBeenCalledWith("s1");
  });

  test("desktopGone → 不显示横幅（可直接恢复）", () => {
    render(ui({ activeElsewhere: true, desktopGone: true }));
    expect(screen.queryByText("接管此会话")).toBeNull();
  });

  test("已接管：无横幅；有谱系来源时显示接力标注", () => {
    const { rerender } = render(ui({ activeElsewhere: true, takenOver: true }));
    expect(screen.queryByText("接管此会话")).toBeNull();
    rerender(ui({ activeElsewhere: false, takenOver: true, forkedFromId: "abc12345-xxx" }));
    expect(screen.getByText(/接力而来/)).toBeTruthy();
  });

  test("旧会话有后代 → 引导直达", () => {
    render(ui({ activeElsewhere: false, forkedToId: "fork-9" }));
    expect(screen.getByText(/已接力至新会话/)).toBeTruthy();
    expect(screen.getByText("打开 →").getAttribute("href")).toBe("/fork-9");
  });

  test("owner 消失 → 兜底接力按钮（fork）", async () => {
    (api.takeover as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: "IPC_OWNER_NOT_FOUND",
    });
    const onForked = vi.fn();
    render(ui({ activeElsewhere: true, onForked }));
    fireEvent.click(screen.getByText("接管此会话"));
    await waitFor(() => expect(screen.getByText(/接力为新会话/)).toBeTruthy());
    fireEvent.click(screen.getByText(/接力为新会话/));
    await waitFor(() => expect(onForked).toHaveBeenCalledWith("fork-9"));
    expect(api.fork).toHaveBeenCalledWith("s1");
  });
});
