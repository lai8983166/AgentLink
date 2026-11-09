// Browser-rendered layout review using synthetic data only; run scripts/visual-review.mjs.
import { open, test } from "nsh/test";
test("synthetic page screenshots", async () => {
 const app = await open("../App.tsx", { width: 390, height: 844 });
 await app.waitFor("label:配对"); await app.screenshot("artifacts/pair.png");
 await app.type("label:服务器地址", "https://agent.example.com"); await app.type("label:配对 token", "synthetic-token"); await app.press("label:配对");
 await app.waitFor("label:人工示例任务"); await app.screenshot("artifacts/home.png");
 await app.press("label:全部 Codex 会话"); await app.screenshot("artifacts/catalog.png"); await app.press("label:‹ 返回");
 await app.press("label:新建任务"); await app.waitFor("text:新任务"); await app.screenshot("artifacts/new-task.png");
 await app.press("label:选择项目目录…"); await app.waitFor("label:示例项目"); await app.screenshot("artifacts/project-browser.png"); await app.press("label:示例项目"); await app.screenshot("artifacts/project-selected.png"); await app.press("label:取消");
 await app.press("label:人工审批任务"); await app.waitFor("label:批准"); await app.screenshot("artifacts/approval.png"); await app.press("label:‹ 返回");
 await app.press("label:人工观察任务"); await app.waitFor("label:接管此会话"); await app.screenshot("artifacts/observe.png"); await app.press("label:‹ 返回");
 await app.press("label:人工终端任务"); await app.waitFor("text:/Claude 终端未连接/"); await app.screenshot("artifacts/claude.png"); await app.press("label:‹ 返回");
 await app.press("label:人工示例任务"); await app.waitFor("text:人工构造的回复"); await app.screenshot("artifacts/session.png");
 await app.press("label:展开工具输出"); await app.screenshot("artifacts/tool-expanded.png");
 await app.press("label:查看文件差异"); await app.waitFor("text:改动预览"); await app.screenshot("artifacts/diff.png"); await app.press("label:关闭差异");
 await app.press("label:‹ 返回"); await app.press("label:设置"); await app.waitFor("text:家里 PC"); await app.screenshot("artifacts/settings.png");
 await app.scroll("text:家里 PC", 600); await app.screenshot("artifacts/settings-bottom.png");
 await app.press("label:审计日志 ›"); await app.waitFor("text:echo synthetic-audit"); await app.screenshot("artifacts/audit.png");
});
