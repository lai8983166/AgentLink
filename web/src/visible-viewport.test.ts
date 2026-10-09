import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { configureKeyboardLayout, keyboardDiagnosticReport, useVisibleViewport } from "./visible-viewport";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); document.body.innerHTML = ""; });

function viewport() {
  vi.stubGlobal("innerHeight", 800);
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

function keyboard() {
  const api = Object.assign(new EventTarget(), { overlaysContent: false, boundingRect: new DOMRect(0, 0, 0, 0) });
  vi.stubGlobal("navigator", { userAgent: "test browser", virtualKeyboard: api });
  return api;
}

describe("桌面安装模式键盘兼容", () => {
  test("API 支持时启用键盘边界，不依赖桌面入口是否报告安装模式", () => {
    const api = keyboard();
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    configureKeyboardLayout(); expect(api.overlaysContent).toBe(true);
    api.overlaysContent = false;
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    configureKeyboardLayout(); expect(api.overlaysContent).toBe(true);
  });
  test("API 缺失或拒绝设置时不阻断启动，仍跟随原生区域缩小", () => {
    const vv = viewport();
    vi.stubGlobal("navigator", { userAgent: "test browser" });
    expect(configureKeyboardLayout).not.toThrow();
    const api = keyboard();
    Object.defineProperty(api, "overlaysContent", { get: () => false, set: () => { throw new Error("unavailable"); } });
    expect(configureKeyboardLayout).not.toThrow();
    const { result } = renderHook(useVisibleViewport);
    act(() => { vv.height = 410; vv.dispatchEvent(new Event("resize")); });
    expect(result.current.height).toBe(410);
  });
  test("键盘覆盖页面且 VV 不缩小时按键盘上沿收缩，键盘关闭后恢复", () => {
    viewport(); const api = keyboard();
    const { result } = renderHook(useVisibleViewport);
    act(() => { api.boundingRect = new DOMRect(0, 440, 390, 360); api.dispatchEvent(new Event("geometrychange")); });
    expect(result.current.height).toBe(440);
    act(() => { api.boundingRect = new DOMRect(0, 0, 0, 0); api.dispatchEvent(new Event("geometrychange")); });
    expect(result.current.height).toBe(800);
  });
  test("VV 已缩小时不会再扣一次键盘高度，偏移与键盘边界组合正确", () => {
    const vv = viewport(); const api = keyboard();
    const { result } = renderHook(useVisibleViewport);
    act(() => {
      vv.height = 390; api.boundingRect = new DOMRect(0, 390, 390, 410);
      api.dispatchEvent(new Event("geometrychange"));
    });
    expect(result.current.height).toBe(390);
    act(() => { vv.offsetTop = 45; vv.dispatchEvent(new Event("scroll")); });
    expect(result.current).toMatchObject({ top: 45, height: 345 });
  });
  test("窗口先缩小但 VV 仍旧时使用窗口尺寸", () => {
    viewport(); const { result } = renderHook(useVisibleViewport);
    act(() => { vi.stubGlobal("innerHeight", 350); window.dispatchEvent(new Event("resize")); });
    expect(result.current.height).toBe(350);
  });
  test("初始缩放不是 1 时仍跟随键盘，之后的手势缩放保留原生平移", () => {
    const vv = viewport(); vv.scale = 0.9;
    const { result } = renderHook(useVisibleViewport);
    act(() => { vv.height = 420; vv.dispatchEvent(new Event("resize")); });
    expect(result.current.height).toBe(420);
    act(() => { vv.scale = 1.8; vv.height = 200; vv.offsetTop = 50; vv.dispatchEvent(new Event("scroll")); });
    expect(result.current).toMatchObject({ height: 420, top: 0 });
  });
  test("尺寸变化没有事件时，输入期间轮询补偿；卸载取消轮询", () => {
    vi.useFakeTimers();
    try {
      const vv = viewport(); const { result, unmount } = renderHook(useVisibleViewport);
      const input = document.createElement("input"); document.body.append(input);
      act(() => input.focus());
      act(() => { vv.height = 410; vi.advanceTimersByTime(150); });
      expect(result.current.height).toBe(410);
      act(() => { input.blur(); vv.height = 800; vi.advanceTimersByTime(150); });
      expect(result.current.height).toBe(800);
      unmount(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  test("布局诊断保留几何数据，不包含输入文本、token 或会话 ID", () => {
    viewport(); keyboard();
    const { unmount } = renderHook(useVisibleViewport);
    const input = document.createElement("input"); input.value = "secret user text"; input.id = "private-session-id";
    localStorage.setItem("agentlink-token", "secret token"); document.body.append(input);
    act(() => input.focus()); unmount();
    const report = keyboardDiagnosticReport();
    expect(JSON.parse(report).samples.length).toBeGreaterThan(0);
    expect(report).toContain("fieldBottom");
    expect(report).not.toContain("secret user text"); expect(report).not.toContain("secret token");
    expect(report).not.toContain("private-session-id");
    localStorage.removeItem("agentlink-token");
  });
});
