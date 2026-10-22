import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ status: vi.fn(), start: vi.fn(), stop: vi.fn(), test: vi.fn(), batterySettings: vi.fn() }));
vi.mock("../native", () => ({ native: mocks, serverBase: () => "https://agentlink.example" }));
import { NativePushSettings } from "./NativePushSettings";
import { useStore } from "../store";
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("安卓通知由原生服务开启和关闭，测试入队不声称已送达", async () => {
  const disabled = { enabled: false, running: false, permission: true, batteryExempt: true, state: "尚未开启", lastDeliveredAt: 0 };
  mocks.status.mockResolvedValue(disabled); mocks.start.mockResolvedValue({ ...disabled, enabled: true, running: true, state: "后台连接正常" }); mocks.stop.mockResolvedValue(disabled); mocks.test.mockResolvedValue(undefined);
  useStore.getState().setToken("test-token");
  render(<NativePushSettings />);
  await waitFor(() => expect((screen.getByText("开启任务通知") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByText("开启任务通知"));
  await screen.findByText("后台连接正常");
  expect(mocks.start).toHaveBeenCalledWith({ url: "https://agentlink.example", token: "test-token" });
  fireEvent.click(screen.getByText("测试通知")); await screen.findByText(/不代表手机已经展示/);
  fireEvent.click(screen.getByText("关闭任务通知")); await screen.findByText("尚未开启"); expect(mocks.stop).toHaveBeenCalledOnce();
});
