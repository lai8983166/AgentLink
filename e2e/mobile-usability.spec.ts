import { test, expect, type Page } from "@playwright/test";
import type { SessionSummary } from "@agentlink/shared";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__test__/control", { data: { type: "reset" } });
  await page.addInitScript(() => localStorage.setItem("agentlink-token", "isolated-e2e-token"));
});

// Headless Chromium has no phone OS keyboard. Simulate its independent visual viewport,
// leaving innerHeight unchanged, including the panning Safari performs to reveal focused inputs.
async function installKeyboardViewport(page: Page) {
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: innerHeight, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    window.addEventListener("test:viewport", (event) => {
      Object.assign(viewport, (event as CustomEvent).detail);
      viewport.dispatchEvent(new Event("resize"));
      viewport.dispatchEvent(new Event("scroll"));
    });
  });
}
async function setKeyboardViewport(page: Page, height: number, offsetTop = 0) {
  await page.evaluate(({ height, offsetTop }) => {
    window.dispatchEvent(new CustomEvent("test:viewport", { detail: { height, offsetTop } }));
  }, { height, offsetTop });
}

test("键盘缩小可见区域、平移和收起后，输入及发送按钮始终可见且保留草稿", async ({ page }, testInfo) => {
  await installKeyboardViewport(page);
  await page.goto("/old1");
  await page.getByRole("button", { name: "接管此会话" }).click();
  const input = page.getByRole("textbox", { name: "消息指令" });
  await input.fill("正在输入的草稿");
  const initialHeight = await page.evaluate(() => innerHeight);
  for (const [height, top] of [[390, 0], [240, 55], [180, 20], [initialHeight, 0]]) {
    await setKeyboardViewport(page, height!, top!);
    await expect.poll(async () => {
      const box = await input.boundingBox();
      return !!box && box.y >= top! && box.y + box.height <= top! + height! + 1;
    }).toBe(true);
    const buttonBox = (await page.getByRole("button", { name: "↑" }).boundingBox())!;
    expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(top! + height! + 1);
    const historyBox = (await page.getByTestId("conversation-history").boundingBox())!;
    expect(historyBox.y + historyBox.height).toBeLessThanOrEqual((await input.boundingBox())!.y);
    await expect(input).toHaveValue("正在输入的草稿");
    await expect(input).toBeFocused();
    expect(await page.evaluate(() => innerHeight)).toBe(initialHeight);
    if (height === 390) await page.locator(".session-page").screenshot({ path: testInfo.outputPath("keyboard-visible.png") });
  }
});

test("窗口随键盘缩小及旋转时，发送提示、输入栏和聊天区域不重叠", async ({ page }) => {
  await page.goto("/old1");
  await page.getByRole("button", { name: "接管此会话" }).click();
  const input = page.getByRole("textbox", { name: "消息指令" });
  await input.fill("已发送的消息"); await page.getByRole("button", { name: "↑" }).click();
  await expect(input).toHaveValue("");
  await expect(page.locator(".composer-notice")).toBeVisible();
  await input.fill("下一条草稿");
  const original = page.viewportSize()!;
  for (const viewport of [{ width: original.width, height: 320 }, { width: 700, height: 240 }, original]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => {
      const box = await input.boundingBox();
      return !!box && box.y >= 0 && box.y + box.height <= viewport.height + 1;
    }).toBe(true);
    const history = (await page.getByTestId("conversation-history").boundingBox())!;
    const notice = (await page.locator(".composer-notice").boundingBox())!;
    expect(history.y + history.height).toBeLessThanOrEqual(notice.y + 1);
    expect(notice.y + notice.height).toBeLessThanOrEqual((await input.boundingBox())!.y);
    await expect(input).toHaveValue("下一条草稿");
  }
});

test("新任务描述在键盘弹出后仍可见、可输入", async ({ page }) => {
  await installKeyboardViewport(page);
  await page.goto("/");
  await page.locator(".fab").click();
  const input = page.getByRole("textbox", { name: "任务描述" });
  await input.fill("新任务草稿");
  await setKeyboardViewport(page, 370, 30);
  await expect.poll(async () => {
    const box = await input.boundingBox();
    return !!box && box.y >= 30 && box.y + box.height <= 401;
  }).toBe(true);
  await input.press("End"); await input.pressSequentially(" continued");
  await expect(input).toHaveValue("新任务草稿 continued");
  await expect(input).toBeFocused();
});

function listSession(index: number): SessionSummary {
  return { id: `list-${index}`, title: `列表测试 ${index}`, agent: "codex", cwd: "F:/e2e", status: "idle",
    statusUpdatedAt: 1, lastActivityAt: 1, desktopManaged: false, activeElsewhere: false, activeVia: null,
    desktopGone: false, forkedFromId: null, forkedToId: null, preview: "测试会话", approvalPolicy: "never", pendingApprovals: 0 };
}

async function fixtureList(page: Page, count: number) {
  const state = { count, lists: 0, statuses: 0, fail: false, gate: null as Promise<void> | null };
  // Keep refresh tests deterministic; real WS recovery and live-state merging are tested in reliability.spec.ts.
  await page.routeWebSocket("**/api/v1/ws*", () => {});
  await page.route("**/api/v1/sessions", async (route) => {
    state.lists++;
    if (state.gate) await state.gate;
    await route.fulfill(state.fail
      ? { status: 503, json: { error: { code: "UNAVAILABLE", message: "test offline" } } }
      : { json: { sessions: Array.from({ length: state.count }, (_, i) => listSession(i)) } });
  });
  await page.route("**/api/v1/status", async (route) => {
    state.statuses++;
    await route.fulfill({ json: { rateLimits: null, connections: { desktop: "ready" } } });
  });
  await page.goto("/");
  await expect(page.getByTestId("session-list").locator(".card")).toHaveCount(count);
  await expect(page.getByText("加载中…", { exact: true })).toHaveCount(0);
  await expect.poll(() => state.statuses).toBeGreaterThan(0);
  return state;
}

/** Real Chromium touch input exercises passive listeners, scroll negotiation and touchcancel. */
async function pullList(page: Page, distance = 160) {
  const box = (await page.getByTestId("session-list").boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 45;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 10; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + distance * step / 10 }] });
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach(); }
}

test("空列表和短列表均能连续下拉刷新，同时刷新连接状态", async ({ page, isMobile }) => {
  test.skip(!isMobile, "真实触摸手势使用移动端项目");
  const state = await fixtureList(page, 0);
  for (const count of [1, 0, 1]) {
    const lists = state.lists, statuses = state.statuses;
    state.count = count;
    await pullList(page);
    await expect(page.getByText("已刷新", { exact: true })).toBeVisible();
    await expect(page.getByTestId("session-list").locator(".card")).toHaveCount(count);
    expect(state.lists).toBe(lists + 1); expect(state.statuses).toBe(statuses + 1);
    expect(new URL(page.url()).pathname).toBe("/");
  }
});

test("长列表正常滚动，回到顶部才可下拉刷新，慢请求期间不重复刷新", async ({ page, isMobile }) => {
  test.skip(!isMobile, "真实触摸手势使用移动端项目");
  const state = await fixtureList(page, 30);
  const list = page.getByTestId("session-list");
  await list.evaluate((element) => { element.scrollTop = 500; });
  const initial = state.lists;
  await pullList(page);
  expect(state.lists).toBe(initial);
  expect(await list.evaluate((element) => element.scrollTop)).toBeLessThan(500);
  await list.evaluate((element) => { element.scrollTop = 0; });
  let release!: () => void;
  state.gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await pullList(page);
    await expect(page.getByText("刷新中…", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "刷新会话" })).toBeDisabled();
    await pullList(page);
    expect(state.lists).toBe(initial + 1);
    release(); state.gate = null;
    await expect(page.getByText("已刷新", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "刷新会话" })).toBeEnabled();
  } finally { release(); state.gate = null; }
});

test("刷新失败保留列表、显示失败，按钮和下拉均可重试恢复", async ({ page, isMobile }) => {
  const state = await fixtureList(page, 1);
  state.fail = true;
  await page.getByRole("button", { name: "刷新会话" }).click();
  await expect(page.getByText("刷新失败，请重试", { exact: true })).toBeVisible();
  await expect(page.getByTestId("session-list").locator(".card")).toHaveCount(1);
  state.fail = false;
  if (isMobile) await pullList(page);
  else await page.getByRole("button", { name: "重试加载" }).click();
  await expect(page.getByText("已刷新", { exact: true })).toBeVisible();
  await expect(page.getByText(/加载失败/)).toHaveCount(0);
});
