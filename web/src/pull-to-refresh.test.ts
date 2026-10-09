import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { usePullToRefresh } from "./pull-to-refresh";

afterEach(cleanup);
function setup(refresh = vi.fn(async () => {}), refreshing = false) {
  const element = document.createElement("div");
  const container = { current: element };
  const hook = renderHook(() => usePullToRefresh(container, refresh, refreshing));
  const touch = (y: number, x = 10) => ({ identifier: 1, clientX: x, clientY: y });
  const start = () => fireEvent.touchStart(element, { touches: [touch(100)] });
  const move = (y: number, x = 10, cancelable = true) => fireEvent.touchMove(element, { touches: [touch(y, x)], cancelable });
  const end = () => fireEvent.touchEnd(element, { touches: [] });
  return { ...hook, element, refresh, start, move, end, touch };
}

describe("列表下拉刷新手势", () => {
  test("短列表在顶部阻止浏览器滚动，超过阈值松开刷新，可重复刷新", async () => {
    const h = setup();
    h.start(); expect(h.move(190)).toBe(false);
    expect(h.result.current.armed).toBe(true);
    await act(async () => { h.end(); });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.result.current.distance).toBe(0);
    await act(async () => { h.start(); h.move(200); h.end(); });
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });
  test("从列表中部开始的手势保持正常滚动，即使移动期间回到顶部也不刷新", async () => {
    const h = setup(); h.element.scrollTop = 200; h.start(); h.element.scrollTop = 0;
    expect(h.move(250)).toBe(true);
    await act(async () => { h.end(); });
    expect(h.refresh).not.toHaveBeenCalled();
  });
  test("不到阈值及拉回后松手不刷新", async () => {
    const h = setup();
    await act(async () => { h.start(); h.move(150); h.end(); });
    await act(async () => { h.start(); h.move(240); h.move(120); h.end(); });
    expect(h.refresh).not.toHaveBeenCalled();
  });
  test("横向与向上手势不被拦截，随后转向下拉也不误触刷新", async () => {
    const h = setup(); h.start(); expect(h.move(120, 100)).toBe(true); h.move(240);
    await act(async () => { h.end(); });
    h.start(); expect(h.move(70)).toBe(true); h.move(240);
    await act(async () => { h.end(); });
    expect(h.refresh).not.toHaveBeenCalled();
  });
  test("系统取消、多指操作、浏览器已接管的不可取消事件均不触发刷新", async () => {
    const h = setup(); h.start(); h.move(240); fireEvent.touchCancel(h.element);
    await act(async () => { h.end(); });
    h.start(); h.move(240); fireEvent.touchMove(h.element, { touches: [h.touch(240), { ...h.touch(240), identifier: 2 }] });
    await act(async () => { h.end(); });
    h.start(); h.move(240, 10, false);
    await act(async () => { h.end(); });
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.result.current.distance).toBe(0);
  });
  test("刷新尚未返回时，反复下拉只发一次请求；失败后可重试", async () => {
    let reject!: () => void;
    const refresh = vi.fn(() => new Promise<void>((_, fail) => { reject = () => fail(new Error("offline")); }));
    const h = setup(refresh);
    await act(async () => { h.start(); h.move(240); h.end(); h.start(); h.move(240); h.end(); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { reject(); });
    await act(async () => { h.start(); h.move(240); h.end(); });
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(async () => { reject(); });
  });
  test("按钮正在刷新时下拉不会再发请求", async () => {
    const h = setup(vi.fn(async () => {}), true);
    await act(async () => { h.start(); h.move(240); h.end(); });
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
