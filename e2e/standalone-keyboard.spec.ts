import { test, expect, type Page } from "@playwright/test";

test.use({ serviceWorkers: "allow" });
test.beforeEach(async ({ page, request }) => {
  await request.post("/__test__/control", { data: { type: "reset" } });
  await page.addInitScript(() => localStorage.setItem("agentlink-token", "isolated-e2e-token"));
});

// Model shortcut/standalone + keyboard signals. This is not an Android WebAPK/OS keyboard test.
async function installedKeyboard(page: Page, standalone = true) {
  await page.addInitScript((standalone) => {
    const originalMatch = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const result = originalMatch(query);
      if (query.includes("display-mode: standalone")) Object.defineProperty(result, "matches", { value: standalone });
      return result;
    };
    const viewport = Object.assign(new EventTarget(), { height: innerHeight, offsetTop: 0, scale: 0.9 });
    window.addEventListener("DOMContentLoaded", () => { viewport.height = innerHeight; });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    const keyboard = Object.assign(new EventTarget(), { overlaysContent: false, boundingRect: new DOMRect() });
    Object.defineProperty(navigator, "virtualKeyboard", { configurable: true, value: keyboard });
    window.addEventListener("test:keyboard", (event) => {
      const { top, silent, noGeometry } = (event as CustomEvent).detail;
      // This browser reports bounds only after the app opts into overlaysContent.
      keyboard.boundingRect = top && keyboard.overlaysContent && !noGeometry ? new DOMRect(0, top, innerWidth, innerHeight - top) : new DOMRect();
      let overlay = document.querySelector<HTMLDivElement>("#test-keyboard");
      if (!overlay) {
        overlay = document.createElement("div"); overlay.id = "test-keyboard";
        overlay.textContent = "模拟屏幕键盘遮挡区域";
        Object.assign(overlay.style, { position: "fixed", left: "0", right: "0", bottom: "0", zIndex: "1000",
          background: "#ddd", color: "#444", padding: "20px", textAlign: "center" });
        document.body.append(overlay);
      }
      overlay.style.display = top ? "block" : "none";
      overlay.style.height = `${innerHeight - top}px`;
      if (!silent) keyboard.dispatchEvent(new Event("geometrychange"));
    });
    window.addEventListener("test:visible-height", (event) => {
      viewport.height = (event as CustomEvent).detail;
      // Deliberately omit resize; some installed browsers expose changed sizes without firing it.
    });
  }, standalone);
}
async function keyboardTop(page: Page, top: number, silent = false) {
  await page.evaluate(({ top, silent }) => window.dispatchEvent(new CustomEvent("test:keyboard", { detail: { top, silent } })), { top, silent });
}
async function aboveKeyboard(page: Page, top: number) {
  const input = page.getByRole("textbox", { name: "消息指令" });
  await expect.poll(async () => {
    const box = await input.boundingBox();
    return !!box && box.y >= 0 && box.y + box.height <= top;
  }).toBe(true);
  expect(await input.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === element;
  })).toBe(true);
  const button = (await page.getByRole("button", { name: "↑" }).boundingBox())!;
  expect(button.y + button.height).toBeLessThanOrEqual(top);
}

test("Android 桌面入口完全不反馈键盘尺寸时自动显示顶部输入，草稿、诊断和点击发送有效", async ({ page, request }, testInfo) => {
  await installedKeyboard(page, false);
  // Model the Android shortcut on both projects; the real mobile project also sends via touch.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Android XiaoMi/MiuiBrowser" });
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 1 });
  });
  await page.goto("/old1"); await page.getByRole("button", { name: "接管此会话" }).click();
  const root = page.locator(".session-page");
  const input = page.getByRole("textbox", { name: "消息指令" }); await input.fill("无尺寸反馈也能发送");
  const initialHeight = await page.evaluate(() => innerHeight);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("test:keyboard", { detail: { top: 350, silent: true, noGeometry: true } })));
  await expect(root).toHaveAttribute("data-input-layout", "auto-top"); await aboveKeyboard(page, 350);
  await expect(input).toBeFocused(); await expect(input).toHaveValue("无尺寸反馈也能发送");
  expect(await page.evaluate(() => visualViewport!.height)).toBe(initialHeight);
  expect(await root.evaluate((element) => element.getBoundingClientRect().height)).toBe(initialHeight);
  expect(await page.evaluate(() => localStorage.getItem("agentlink-input-at-top"))).toBeNull();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("agentlink-keyboard-layout") ?? "[]").at(-1)?.inputLayout)).toBe("auto-top");
  await page.screenshot({ path: testInfo.outputPath("keyboard-without-signals.png") });
  const send = page.getByRole("button", { name: "↑" });
  if (testInfo.project.name === "mobile") await send.tap(); else await send.click();
  await expect(input).toHaveValue("");
  await expect(page.getByText("电脑端已接收", { exact: true })).toBeVisible();
  expect((await (await request.post("/__test__/metrics")).json()).sends).toHaveLength(1);
  await keyboardTop(page, 0); await input.blur(); await page.locator(".session-header .title").click();
  await expect(root).toHaveAttribute("data-input-layout", "bottom");
  await page.goto("/settings"); await page.getByText("输入框仍被键盘遮挡？", { exact: true }).click();
  await page.getByRole("button", { name: "复制布局诊断" }).click();
  const diagnostic = JSON.parse(await page.getByRole("textbox", { name: "布局诊断信息" }).inputValue());
  expect(diagnostic.samples.some((sample: { inputLayout: string; keyboardHeight: number; fieldBottom: number }) => sample.inputLayout === "auto-top" && sample.keyboardHeight === 0 && sample.fieldBottom < 350)).toBe(true);
});

test("小米桌面入口报告 browser 模式时仍启用键盘 API，输入框紧跟遮挡边界并在关闭后恢复", async ({ page }) => {
  await installedKeyboard(page, false); await page.goto("/old1");
  await page.getByRole("button", { name: "接管此会话" }).click();
  const input = page.getByRole("textbox", { name: "消息指令" }); await input.fill("桌面快捷入口草稿");
  const initialHeight = await page.evaluate(() => innerHeight);
  expect(await page.evaluate(() => matchMedia("(display-mode: standalone)").matches)).toBe(false);
  expect(await page.evaluate(() => (navigator as unknown as { virtualKeyboard: { overlaysContent: boolean } }).virtualKeyboard.overlaysContent)).toBe(true);
  await keyboardTop(page, 420); await aboveKeyboard(page, 420);
  await expect(page.locator(".session-page")).toHaveAttribute("data-input-layout", "bottom");
  expect(await page.evaluate(() => visualViewport!.height)).toBe(initialHeight);
  await expect.poll(() => page.locator(".session-page").evaluate((element) => element.getBoundingClientRect().bottom)).toBe(420);
  await expect(input).toBeFocused(); await expect(input).toHaveValue("桌面快捷入口草稿");
  // Wait for the sample after React commits the new layout, before blurring stops input sampling.
  await expect.poll(() => page.evaluate(() => {
    const samples = JSON.parse(sessionStorage.getItem("agentlink-keyboard-layout") ?? "[]");
    return samples.at(-1)?.fieldBottom;
  })).toBeLessThanOrEqual(420);
  await input.blur(); await keyboardTop(page, 0);
  await expect.poll(() => page.locator(".session-page").evaluate((element) => element.getBoundingClientRect().height)).toBe(initialHeight);
  await page.goto("/settings"); await page.getByText("输入框仍被键盘遮挡？", { exact: true }).click();
  await page.getByRole("button", { name: "复制布局诊断" }).click();
  const diagnostic = JSON.parse(await page.getByRole("textbox", { name: "布局诊断信息" }).inputValue());
  expect(diagnostic.standalone).toBe(false); expect(diagnostic.keyboardOverlay).toBe(true);
  expect(diagnostic.samples.some((sample: { keyboardTop: number; fieldBottom: number }) => sample.keyboardTop === 420 && sample.fieldBottom <= 420)).toBe(true);
});

test("安装模式键盘覆盖但可见区域不缩小：输入及发送按钮可见、可点击且不重复扣高度", async ({ page }, testInfo) => {
  await installedKeyboard(page); await page.goto("/old1");
  await page.getByRole("button", { name: "接管此会话" }).click();
  const input = page.getByRole("textbox", { name: "消息指令" }); await input.fill("安装模式草稿");
  const initialHeight = await page.evaluate(() => innerHeight);
  expect(await page.evaluate(() => (navigator as unknown as { virtualKeyboard: { overlaysContent: boolean } }).virtualKeyboard.overlaysContent)).toBe(true);
  await keyboardTop(page, 420); await aboveKeyboard(page, 420);
  expect(await page.evaluate(() => visualViewport!.height)).toBe(initialHeight);
  await page.screenshot({ path: testInfo.outputPath("standalone-keyboard.png") });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("test:visible-height", { detail: 420 })));
  await expect.poll(() => page.locator(".session-page").evaluate((element) => element.getBoundingClientRect().height)).toBe(420);
  await expect(input).toBeFocused(); await expect(input).toHaveValue("安装模式草稿");
  await page.getByRole("button", { name: "↑" }).click(); await expect(input).toHaveValue("");
  await input.fill("接着输入"); await keyboardTop(page, 330); await aboveKeyboard(page, 330);
  const notice = (await page.locator(".composer-notice").boundingBox())!;
  expect(notice.y + notice.height).toBeLessThanOrEqual((await input.boundingBox())!.y);
});

test("没有 resize/geometrychange 时仍跟随尺寸，关闭键盘恢复，诊断不包含文本和 token", async ({ page }) => {
  await installedKeyboard(page); await page.goto("/old1");
  await page.getByRole("button", { name: "接管此会话" }).click();
  const input = page.getByRole("textbox", { name: "消息指令" }); await input.fill("PRIVATE-TEXT-MUST-NOT-APPEAR");
  await keyboardTop(page, 385, true); await aboveKeyboard(page, 385);
  await expect.poll(() => page.evaluate(() => {
    const samples = JSON.parse(sessionStorage.getItem("agentlink-keyboard-layout") ?? "[]");
    return samples.at(-1)?.fieldBottom;
  })).toBeLessThanOrEqual(385);
  await input.blur(); await keyboardTop(page, 0, true);
  await expect.poll(async () => (await input.boundingBox())!.y).toBeGreaterThan(450);
  await page.goto("/settings"); await page.getByText("输入框仍被键盘遮挡？", { exact: true }).click();
  await page.getByRole("button", { name: "复制布局诊断" }).click();
  const report = await page.getByRole("textbox", { name: "布局诊断信息" }).inputValue();
  const diagnostic = JSON.parse(report);
  expect(diagnostic.standalone).toBe(true); expect(diagnostic.keyboardOverlay).toBe(true);
  expect(diagnostic.samples.some((sample: { keyboardTop: number; fieldBottom: number }) => sample.keyboardTop === 385 && sample.fieldBottom <= 385)).toBe(true);
  expect(report).not.toContain("PRIVATE-TEXT-MUST-NOT-APPEAR"); expect(report).not.toContain("isolated-e2e-token");
});

test("安装模式的新任务描述跟随键盘遮挡区域", async ({ page }) => {
  await installedKeyboard(page); await page.goto("/"); await page.locator(".fab").click();
  const input = page.getByRole("textbox", { name: "任务描述" }); await input.fill("安装模式任务描述");
  await keyboardTop(page, 370);
  await expect.poll(async () => {
    const box = await input.boundingBox(); return !!box && box.y >= 0 && box.y + box.height <= 370;
  }).toBe(true);
  await expect(input).toBeFocused(); await expect(input).toHaveValue("安装模式任务描述");
});

test("浏览器不提供任何键盘尺寸时，可启用顶部输入兼容模式并在重开后保留", async ({ page }) => {
  await installedKeyboard(page); await page.goto("/settings");
  await page.getByText("输入框仍被键盘遮挡？", { exact: true }).click();
  await page.getByRole("checkbox", { name: "会话输入栏固定在顶部（兼容模式）" }).check();
  await page.goto("/old1"); await page.getByRole("button", { name: "接管此会话" }).click();
  const input = page.getByRole("textbox", { name: "消息指令" }); await input.fill("兼容模式草稿");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("test:keyboard", { detail: { top: 350, silent: true, noGeometry: true } })));
  await aboveKeyboard(page, 350);
  expect(await input.boundingBox()).toMatchObject({ y: 10 });
  await page.reload(); await expect(input).toHaveValue("兼容模式草稿");
  await input.focus();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("test:keyboard", { detail: { top: 350, silent: true, noGeometry: true } })));
  await aboveKeyboard(page, 350);
  await page.goto("/settings"); await page.getByText("输入框仍被键盘遮挡？", { exact: true }).click();
  const option = page.getByRole("checkbox", { name: "会话输入栏固定在顶部（兼容模式）" });
  await expect(option).toBeChecked(); await option.uncheck();
  await page.goto("/old1");
  await expect.poll(async () => (await input.boundingBox())!.y).toBeGreaterThan(450);
});
