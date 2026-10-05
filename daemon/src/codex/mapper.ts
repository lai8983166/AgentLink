import type { SessionStatus, ToolKind } from "@agentlink/shared";
import {
  CODEX_NOISE_METHODS,
  type CodexApprovalParams,
  type CodexItem,
  type CodexNotification,
  type CodexServerRequest,
  type CodexThreadStatus,
} from "./protocol";

/**
 * codex 事件 → 域事实映射（任务 3.3，design.md D4）。
 * 纯函数：防御性读取，字段缺失给 null，绝不抛错。
 */

export type MappedFact =
  | { kind: "threadStatus"; threadId: string; status: SessionStatus }
  | { kind: "threadStarted"; threadId: string; cwd: string | null }
  | { kind: "threadName"; threadId: string; name: string }
  | { kind: "userMessage"; threadId: string; itemId: string; text: string; at: number }
  | { kind: "agentDelta"; threadId: string; itemId: string; delta: string }
  | { kind: "agentMessage"; threadId: string; itemId: string; text: string }
  | { kind: "toolStarted"; threadId: string; itemId: string; toolKind: ToolKind; target: string; cmd: string | null }
  | {
      kind: "toolFinished";
      threadId: string;
      itemId: string;
      toolKind: ToolKind;
      target: string;
      exitCode: number | null;
      durationMs: number | null;
      added: number | null;
      removed: number | null;
      outputTail: string | null;
    }
  | { kind: "queueChanged"; threadId: string; queued: number }
  | { kind: "patchUpdated"; threadId: string; itemId: string; patch: string | null }
  | { kind: "turnCompleted"; threadId: string; error: string | null }
  | { kind: "tokenUsage"; threadId: string; totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number }
  | {
      kind: "approvalRequest";
      rpcId: number | string;
      threadId: string;
      approvalId: string;
      approvalKind: "command" | "fileChange";
      command: string | null;
      cwd: string;
      reason: string | null;
      availableDecisions: Array<string | Record<string, unknown>>;
    };

const now = () => Date.now();

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function statusFromThreadStatus(s: CodexThreadStatus | undefined): SessionStatus | null {
  if (!s) return null;
  if (s.activeFlags?.includes("waitingOnApproval")) return "waiting_approval";
  if (s.type === "active") return "running";
  if (s.type === "idle") return "idle";
  return null;
}

/** 工具类 item → 展示摘要 */
function toolInfo(item: CodexItem): { toolKind: ToolKind; target: string; cmd: string | null } | null {
  if (item.type === "commandExecution" || item.type === "shellCommand") {
    const cmd = str(item.command) ?? "";
    return { toolKind: "exec", target: cmd.split(/\s+/)[0] || cmd || "命令", cmd: cmd || null };
  }
  if (item.type === "fileChange" || item.type === "apply_patch") {
    // fileChange item 可能带 path / changes[]；target 取第一个路径
    const p =
      str(item.path) ??
      (Array.isArray(item.changes) && item.changes.length
        ? str((item.changes[0] as Record<string, unknown>)?.path)
        : null);
    return { toolKind: "fileChange", target: p ?? "文件改动", cmd: null };
  }
  return null;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : str((c as Record<string, unknown>)?.text) ?? ""))
      .join("");
  }
  return "";
}

export function mapNotification(n: CodexNotification): MappedFact | null {
  if (CODEX_NOISE_METHODS.has(n.method)) return null;
  const p = (n.params ?? {}) as Record<string, unknown>;
  const threadId = str(p.threadId);
  if (!threadId) return null;

  switch (n.method) {
    case "thread/started": {
      const t = (p.thread ?? {}) as Record<string, unknown>;
      const envs = Array.isArray(t.environments) ? (t.environments as Array<Record<string, unknown>>) : [];
      return { kind: "threadStarted", threadId: str(t.id) ?? threadId, cwd: str(envs[0]?.cwd) };
    }
    case "thread/name/updated":
      return { kind: "threadName", threadId, name: str(p.name) ?? "" };
    case "thread/status/changed": {
      const st = statusFromThreadStatus(p.status as CodexThreadStatus);
      return st ? { kind: "threadStatus", threadId, status: st } : null;
    }
    case "item/started":
    case "item/completed": {
      const item = (p.item ?? {}) as CodexItem;
      const itemId = str(item.id);
      if (!itemId) return null;
      const completed = n.method === "item/completed";

      if (item.type === "userMessage") {
        return completed
          ? { kind: "userMessage", threadId, itemId, text: textFromContent(item.content), at: now() }
          : null;
      }
      if (item.type === "agentMessage") {
        return completed
          ? { kind: "agentMessage", threadId, itemId, text: str(item.text) ?? "" }
          : null;
      }
      const tool = toolInfo(item);
      if (tool) {
        if (!completed) return { kind: "toolStarted", threadId, itemId, ...tool };
        // completed：尽量提取 exit code / 耗时 / diff 统计 / 输出尾部
        const exitCode = num(item.exitCode) ?? num(item.exit_code);
        const durationMs = num(item.durationMs) ?? num(item.duration_ms);
        let added: number | null = null;
        let removed: number | null = null;
        const changes = item.changes as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(changes)) {
          added = 0;
          removed = 0;
          for (const ch of changes) {
            added += num(ch.added) ?? num(ch.additions) ?? 0;
            removed += num(ch.removed) ?? num(ch.deletions) ?? 0;
          }
        }
        let outputTail: string | null = str(item.aggregatedOutput) ?? str(item.output);
        if (outputTail && outputTail.length > 4000) outputTail = `${outputTail.slice(0, 4000)}…`;
        return {
          kind: "toolFinished",
          threadId,
          itemId,
          toolKind: tool.toolKind,
          target: tool.target,
          exitCode,
          durationMs,
          added,
          removed,
          outputTail,
        };
      }
      return null;
    }
    case "item/agentMessage/delta":
      return { kind: "agentDelta", threadId, itemId: str(p.itemId) ?? "", delta: str(p.delta) ?? "" };
    case "thread/queue/changed": {
      const q = p.queue ?? p.queued;
      const queued = Array.isArray(q) ? q.length : (num(q) ?? 0);
      return { kind: "queueChanged", threadId, queued };
    }
    case "item/fileChange/patchUpdated": {
      const patch = str(p.patch);
      return { kind: "patchUpdated", threadId, itemId: str(p.itemId) ?? "", patch };
    }
    case "turn/completed": {
      const turn = (p.turn ?? {}) as Record<string, unknown>;
      const errObj = turn.error as Record<string, unknown> | null | undefined;
      const error = errObj ? (str(errObj.message) ?? JSON.stringify(errObj)) : null;
      return { kind: "turnCompleted", threadId, error };
    }
    case "thread/tokenUsage/updated": {
      const u = (p.tokenUsage ?? {}) as Record<string, unknown>;
      const total = (u.total ?? {}) as Record<string, unknown>;
      const tot = num(total.totalTokens) ?? 0;
      if (!tot) {
        // 有些版本直接铺平在线程对象上
        const flat = (p.tokenUsage ?? {}) as Record<string, unknown>;
        const t2 = num(flat.totalTokens) ?? 0;
        if (!t2) return null;
      }
      return {
        kind: "tokenUsage",
        threadId,
        totalTokens: num(total.totalTokens) ?? num((u as Record<string, unknown>).totalTokens) ?? 0,
        inputTokens: num(total.inputTokens) ?? 0,
        cachedInputTokens: num(total.cachedInputTokens) ?? 0,
        outputTokens: num(total.outputTokens) ?? 0,
      };
    }
    default:
      return null;
  }
}

/** codex turn item → HistoryItem（旧会话历史重建用） */
export function historyItemFromCodexItem(item: CodexItem): import("@agentlink/shared").HistoryItem | null {
  const at = Date.now();
  if (item.type === "userMessage") {
    return { type: "userMessage", id: item.id, text: textFromContent(item.content), at };
  }
  if (item.type === "agentMessage") {
    return { type: "agentMessage", id: item.id, text: str(item.text) ?? "", at };
  }
  const tool = toolInfo(item);
  if (tool?.toolKind === "exec") {
    return {
      type: "toolCall",
      id: item.id,
      kind: "exec",
      target: tool.target,
      cmd: tool.cmd,
      exitCode: num(item.exitCode) ?? num(item.exit_code),
      durationMs: num(item.durationMs) ?? num(item.duration_ms),
      diffStat: null,
      outputTail: (() => {
        const o = str(item.aggregatedOutput) ?? str(item.output);
        return o && o.length > 4000 ? `${o.slice(0, 4000)}…` : o;
      })(),
      at,
    };
  }
  if (tool?.toolKind === "fileChange") {
    let added = 0;
    let removed = 0;
    const changes = item.changes as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(changes)) {
      for (const ch of changes) {
        added += num(ch.added) ?? num(ch.additions) ?? 0;
        removed += num(ch.removed) ?? num(ch.deletions) ?? 0;
      }
    }
    return {
      type: "toolCall",
      id: item.id,
      kind: "fileChange",
      target: tool.target,
      cmd: null,
      exitCode: null,
      durationMs: null,
      diffStat: { added, removed },
      outputTail: null,
      at,
    };
  }
  return null;
}

/** 审批类服务端请求 → 域事实（approval.request） */
export function mapServerRequest(r: CodexServerRequest): MappedFact | null {
  const m = r.method;
  if (
    m !== "item/commandExecution/requestApproval" &&
    m !== "item/fileChange/requestApproval" &&
    m !== "item/permissions/requestApproval" &&
    m !== "execCommandApproval" &&
    m !== "applyPatchApproval"
  ) {
    return null;
  }
  const p = (r.params ?? {}) as CodexApprovalParams;
  const threadId = p.threadId ?? "";
  if (!threadId) return null;
  const approvalKind = p.kind === "fileChange" ? "fileChange" : "command";
  const approvalId =
    (p.approvalId ?? (typeof p.itemId === "string" ? p.itemId : "")) || `rpc-${r.id}`;
  return {
    kind: "approvalRequest",
    rpcId: r.id,
    threadId,
    approvalId,
    approvalKind,
    command: p.command ?? null,
    cwd: p.cwd ?? "",
    reason: p.reason ?? null,
    availableDecisions: Array.isArray(p.availableDecisions) ? p.availableDecisions : [],
  };
}
