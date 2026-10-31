import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeCatalog } from "./catalog";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(root.includes("agentlink-catalog-")).toBe(true); rmSync(root, { recursive: true, force: true }); } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentlink-catalog-")); roots.push(root);
  const project = join(root, "F--project-test"); mkdirSync(project);
  const raw = randomUUID(), path = join(project, raw + ".jsonl"), at = "2026-08-01T00:00:00Z";
  const lines = [
    { type: "user", sessionId: raw, cwd: "C:/projects/test", uuid: "u1", timestamp: at, message: { content: "原始问题" } },
    { type: "assistant", sessionId: raw, uuid: "a1", timestamp: at, message: { content: [{ type: "thinking", thinking: "never expose" }, { type: "text", text: "原始回复" }, { type: "tool_use", id: "tool1", name: "Bash", input: { command: "echo hello" } }] } },
    { type: "user", sessionId: raw, uuid: "r1", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "tool1", content: "hello", is_error: false }] } },
    { type: "api-request", sessionId: raw, timestamp: "2026-10-31T00:00:00Z", params: { secret: "never expose API params" } },
    { type: "custom-title", sessionId: raw, customTitle: "自定义标题" },
  ];
  writeFileSync(path, lines.map(r => JSON.stringify(r)).join("\n") + "\n");
  return { root, project, raw, path, at };
}
test("本机未接插件的历史可列出和只读查看，真实消息时间不被文件修改或 API 元数据刷新", async () => {
  const f = fixture(); utimesSync(f.path, new Date(), new Date());
  const catalog = new ClaudeCatalog(f.root), list = await catalog.list();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ id: "claude:" + f.raw, title: "自定义标题", agent: "claude", lastActivityAt: Date.parse(f.at), terminal: { connected: false, canInterrupt: false } });
  const detail = await catalog.detail("claude:" + f.raw);
  expect(detail.session.controlMode).toBe("observe");
  expect(detail.session.history.map(h => h.type)).toEqual(["userMessage", "agentMessage", "toolCall"]);
  expect(detail.session.history[2]).toMatchObject({ cmd: "echo hello", exitCode: 0, outputTail: "hello" });
  expect(JSON.stringify(detail)).not.toContain("never expose");
});
test("仅主会话 UUID 文件进入目录，忽略嵌套子代理和非会话文件，任意路径不能作为会话 ID", async () => {
  const f = fixture(); writeFileSync(join(f.project, "agent-scratch.jsonl"), "{}");
  mkdirSync(join(f.project, "subagents")); writeFileSync(join(f.project, "subagents", randomUUID() + ".jsonl"), "{}");
  const catalog = new ClaudeCatalog(f.root);
  expect(await catalog.list()).toHaveLength(1);
  await expect(catalog.detail("claude:../../config")).rejects.toThrow("不存在");
  await expect(catalog.detail("claude:" + randomUUID())).rejects.toThrow("未找到");
  expect(await new ClaudeCatalog(false).list()).toEqual([]);
});
