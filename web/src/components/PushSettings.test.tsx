import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PushSettings } from "./PushSettings";
import { disablePush, enablePush, inspectPush, pushSupportError } from "../push-client";
import { api } from "../runtime";
vi.mock("../runtime", () => ({ api: { pushTest: vi.fn() } }));
vi.mock("../push-client", () => ({ disablePush: vi.fn(), enablePush: vi.fn(), inspectPush: vi.fn(), pushDeviceId: () => null, pushPermission: () => "granted", pushSupportError: vi.fn() }));
const device = { id: "d1", lastAcceptedAt: null, lastError: null, pending: 0 };
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(pushSupportError).mockReturnValue(null);
  vi.mocked(inspectPush).mockResolvedValue({ publicKey: "key", device: null, active: false });
  vi.mocked(enablePush).mockResolvedValue({ publicKey: "key", device, active: true });
  vi.mocked(disablePush).mockResolvedValue();
});
afterEach(cleanup);
describe("任务通知设置", () => {
  test("开启、测试、关闭，服务已接受不宣称实际送达", async () => {
    render(<PushSettings />); await waitFor(() => expect(screen.getByText("开启任务通知").hasAttribute("disabled")).toBe(false));
    expect(enablePush).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("开启任务通知")); await screen.findByText("此设备已开启任务通知");
    vi.mocked(api.pushTest).mockResolvedValue({ device: { ...device, lastAcceptedAt: Date.now() } });
    fireEvent.click(screen.getByText("发送测试通知"));
    await screen.findByText("推送服务已接受测试通知，请确认手机通知栏是否收到。");
    fireEvent.click(screen.getByText("关闭任务通知")); await screen.findByText("已关闭此设备的任务通知");
    expect(disablePush).toHaveBeenCalledTimes(1);
  });
  test("不支持时直接说明原因，不误导用户开启", () => {
    vi.mocked(pushSupportError).mockReturnValue("当前浏览器不支持后台推送");
    render(<PushSettings />); expect(screen.getByText("当前浏览器不支持后台推送")).toBeTruthy(); expect(screen.queryByText("开启任务通知")).toBeNull();
    expect(inspectPush).not.toHaveBeenCalled();
  });
  test("权限拒绝或网络错误显示失败，不能切换成已开启", async () => {
    vi.mocked(enablePush).mockRejectedValueOnce(new Error("未获得通知权限"));
    render(<PushSettings />); await waitFor(() => expect(screen.getByText("开启任务通知").hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByText("开启任务通知")); await screen.findByRole("alert");
    expect(screen.queryByText("此设备已开启任务通知")).toBeNull();
  });
});
