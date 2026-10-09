import { test, expect, type Page } from "@playwright/test";

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

test("键盘缩小可见区域、平移和收起后，输入及发送按钮始终可见且保留草稿", async ({ page }) => {
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
