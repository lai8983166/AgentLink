import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { findRollout } from "../ipc/rollout-limits";
import { DaemonError } from "./bridge";
import type { CodexApprovalPolicy } from "./protocol";

export interface ResumeSettings {
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: CodexApprovalPolicy;
  config?: Record<string, unknown>;
}

/** Resume inherits approvals, but may reset sandbox to the daemon default. */
export async function readResumeSettings(threadId: string, codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")): Promise<ResumeSettings> {
  const path = findRollout(threadId, join(codexHome, "sessions"));
  if (!path) throw new DaemonError("IPC_UNAVAILABLE", "无法读取原会话权限设置，未恢复会话");
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let context: Record<string, unknown> | undefined;
  try {
    for await (const line of lines) {
      if (!/"type"\s*:\s*"turn_context"/.test(line)) continue;
      try {
        const record = JSON.parse(line);
        if (record.type === "turn_context" && record.payload && typeof record.payload === "object") context = record.payload;
      } catch { /* A partial trailing record cannot replace the last complete context. */ }
    }
  } catch {
    throw new DaemonError("IPC_UNAVAILABLE", "读取原会话权限设置失败，未恢复会话");
  } finally { lines.close(); input.destroy(); }
  const policy = context?.sandbox_policy as Record<string, unknown> | undefined;
  const sandbox = policy?.type;
  if (sandbox !== "read-only" && sandbox !== "workspace-write" && sandbox !== "danger-full-access") {
    throw new DaemonError("IPC_UNAVAILABLE", "无法确认原会话的执行权限，请通过电脑端接管");
  }
  // Legacy read-only with network enabled cannot be represented by SandboxMode.
  if (sandbox === "read-only" && policy?.network_access === true) {
    throw new DaemonError("IPC_UNAVAILABLE", "原会话使用自定义只读权限，请通过电脑端接管");
  }
  const approval = context?.approval_policy;
  const approvalPolicy = approval === "never" || approval === "on-request" || approval === "untrusted" ? approval : undefined;
  const settings: ResumeSettings = { sandbox, approvalPolicy };
  if (sandbox === "workspace-write") {
    const workspace: Record<string, unknown> = {};
    for (const key of ["writable_roots", "network_access", "exclude_tmpdir_env_var", "exclude_slash_tmp"]) {
      if (policy?.[key] !== undefined) workspace[key] = policy[key];
    }
    settings.config = { sandbox_workspace_write: workspace };
  }
  return settings;
}
