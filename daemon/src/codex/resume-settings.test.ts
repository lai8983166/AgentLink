import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readResumeSettings } from "./resume-settings";

const homes: string[] = [];
function fixture(records: unknown[]) {
  const home = mkdtempSync(join(tmpdir(), "al-resume-settings-")); homes.push(home);
  mkdirSync(join(home, "sessions"));
  const id = crypto.randomUUID();
  const path = join(home, "sessions", `rollout-test-${id}.jsonl`);
  writeFileSync(path, records.map((payload) => JSON.stringify({ type: "turn_context", payload })).join("\n") + '\n{"type":"turn_context","payload":');
  return { home, id };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("原会话执行权限恢复", () => {
  test("最后完整记录的 Full Access 优先，尾部半行不覆盖；不会读取或复制指令", async () => {
    const { home, id } = fixture([
      { approval_policy: "untrusted", sandbox_policy: { type: "read-only" } },
      { approval_policy: "never", sandbox_policy: { type: "danger-full-access" }, developer_instructions: "must not copy" },
    ]);
    expect(await readResumeSettings(id, home)).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
  });
  test("workspace-write 保留附加写目录、网络和临时目录规则，granular 审批由引擎继承", async () => {
    const workspace = { writable_roots: ["F:/allowed-extra"], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true };
    const { home, id } = fixture([{ approval_policy: { granular: { sandbox_approval: true } }, sandbox_policy: { type: "workspace-write", ...workspace } }]);
    expect(await readResumeSettings(id, home)).toEqual({ sandbox: "workspace-write", approvalPolicy: undefined, config: { sandbox_workspace_write: workspace } });
  });
  test("缺失记录或无法表示的自定义权限拒绝恢复，不能猜测 Full Access", async () => {
    for (const records of [[], [{ sandbox_policy: { type: "external-sandbox" } }], [{ sandbox_policy: { type: "read-only", network_access: true } }]]) {
      const { home, id } = fixture(records);
      await expect(readResumeSettings(id, home)).rejects.toMatchObject({ code: "IPC_UNAVAILABLE" });
    }
  });
});
