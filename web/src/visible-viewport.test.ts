import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useVisibleViewport } from "./visible-viewport";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function viewport() {
  const vv = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", vv);
  return vv;
}

describe("可见区域跟随", () => {
  test("键盘只缩小可见区域时更新高度，滚动时更新偏移，关闭后恢复", () => {
    const vv = viewport();
    const { result } = renderHook(useVisibleViewport);
    expect(result.current).toMatchObject({ height: 800, top: 0 });
    act(() => { vv.height = 390; vv.dispatchEvent(new Event("resize")); });
    expect(result.current).toMatchObject({ height: 390, top: 0 });
    act(() => { vv.offsetTop = 45; vv.dispatchEvent(new Event("scroll")); });
    expect(result.current).toMatchObject({ height: 390, top: 45 });
    act(() => { vv.height = 800; vv.offsetTop = 0; vv.dispatchEvent(new Event("resize")); });
    expect(result.current).toMatchObject({ height: 800, top: 0 });
  });

  test("无 VisualViewport 的浏览器仍响应窗口大小变化", () => {
    vi.stubGlobal("visualViewport", undefined);
    vi.stubGlobal("innerHeight", 720);
    const { result } = renderHook(useVisibleViewport);
    expect(result.current.height).toBe(720);
    act(() => { vi.stubGlobal("innerHeight", 360); window.dispatchEvent(new Event("resize")); });
    expect(result.current.height).toBe(360);
  });

  test("不跟随手势放大的平移，恢复缩放后继续跟随", () => {
    const vv = viewport();
    const { result } = renderHook(useVisibleViewport);
    act(() => { vv.scale = 2; vv.height = 400; vv.offsetTop = 80; vv.dispatchEvent(new Event("resize")); });
    expect(result.current).toMatchObject({ height: 800, top: 0 });
    act(() => { vv.scale = 1; vv.offsetTop = 0; vv.dispatchEvent(new Event("resize")); });
    expect(result.current).toMatchObject({ height: 400, top: 0 });
  });

  test("卸载移除窗口和可见区域监听", () => {
    const vv = viewport();
    const removeViewport = vi.spyOn(vv, "removeEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(useVisibleViewport);
    unmount();
    expect(removeViewport).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(removeViewport).toHaveBeenCalledWith("scroll", expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith("resize", expect.any(Function));
    removeWindow.mockRestore();
  });
});
