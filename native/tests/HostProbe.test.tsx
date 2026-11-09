import { expect, open, test } from "nsh/test";

test("input and bidirectional host calls leave the typed text intact", async () => {
  const app = await open("../App.tsx");
  await app.waitFor("text:安卓宿主已就绪");
  await app.type("label:验证输入", "人工测试：安卓输入");
  await app.press("label:验证双向通信");
  await app.waitFor("text:宿主事件：1");
  expect(app.value("label:验证输入")).toBe("人工测试：安卓输入");
  await app.press("label:加密保存测试文字");
  await app.waitFor("text:测试文字已加密保存");
  await app.clear("label:验证输入");
  await app.press("label:读取测试文字");
  await app.waitFor("text:人工测试：安卓输入");
});
