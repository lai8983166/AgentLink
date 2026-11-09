import { expect, open, test } from "nsh/test";

test("pair, browse a session, send and inspect native notification settings", async () => {
  const app = await open("../App.tsx");
  await app.waitFor("text:连接你的电脑");
  await app.type("label:服务器地址", "https://agent.example.com");
  await app.type("label:配对 token", "synthetic-token");
  await app.press("label:连接后台");
  await app.waitFor("label:人工示例任务");
  await app.press("label:人工示例任务");
  await app.waitFor("text:人工构造的回复");
  await app.type("label:消息输入", "人工新指令");
  await app.press("label:发送消息");
  await app.waitFor("text:已接收 · 人工新指令");
  expect(app.value("label:消息输入")).toBe("");
  await app.press("label:设置");
  await app.waitFor("text:人工通知状态");
});

test("cold launch restores a saved pairing from native launch parameters", async () => {
  const app = await open("../App.tsx", { host: { params: { pairing: { paired: true, scope: "test-scope", url: "https://agent.example.com" } } } });
  await app.waitFor("label:全部 Codex 会话");
  expect(app.texts().includes("连接你的电脑")).toBe(false);
});
