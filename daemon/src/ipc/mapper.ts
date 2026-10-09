import type {
  ConversationState,
  IpcPendingRequest,
  IpcTurnItem,
} from "./protocol";

/**
 * conversationState → 内部事件差分映射（任务 2.2/2.3）。
 * 快照为权威状态；两次快照间按 turn/item/request 差分产出事件。
 * 纯函数： Defensive 读取，未知 item 类型降级为占位卡片。
 */

export interface DesktopTurnItemState {
  key: string;
  type: string;
  status: string | null;
  text: string;
  command: string | null;
  outputTail: string | null;
  exitCode: number | null;
  added: number | null;
  removed: number | null;
}

export interface DesktopTurnState {
  turnId: string;
  status: string;
  items: DesktopTurnItemState[];
}

export interface DesktopRequestState {
  id: string;
  kind: "command" | "fileChange";
  command: string | null;
  cwd: string;
  reason: string | null;
  availableDecisions: Array<string | Record<string, unknown>>;
}

export interface DesktopState {
  revision: number | null;
  title: string;
  turns: DesktopTurnState[];
  requests: DesktopRequestState[];
}

/** 差分产出的事件（无 seq/at，由总线补齐） */
export type DesktopFact =
  | { kind: "session.status"; status: "running" | "waiting_approval" | "done" | "error" | "idle" | "unknown"; activity: string | null }
  | { kind: "user.message"; itemId: string; text: string }
  | { kind: "agent.message"; itemId: string; text: string }
  | { kind: "agent.delta"; itemId: string; delta: string }
  | { kind: "tool.started"; itemId: string; toolKind: "exec" | "fileChange"; target: string; cmd: string | null }
  | {
      kind: "tool.finished";
      itemId: string;
      toolKind: "exec" | "fileChange";
      target: string;
      exitCode: number | null;
      added: number | null;
      removed: number | null;
      outputTail: string | null;
    }
  | {
      kind: "approval.request";
      requestId: string;
      approvalKind: "command" | "fileChange";
      command: string | null;
      cwd: string;
      reason: string | null;
      availableDecisions: Array<string | Record<string, unknown>>;
    }
  | { kind: "approval.resolved"; requestId: string }
  /** 基准快照落位（首跟/重订阅/换 owner）：历史权威版已就绪，客户端应重拉 detail */
  | { kind: "history.sync" };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function itemKey(turnId: string, idx: number, item: IpcTurnItem): string {
  return str(item.id) ?? `${turnId}:${idx}:${item.type ?? "?"}`;
}

/** 文件改动 changes 兼容三种实测形态：
 *  数组 [{path, kind:{type}, diff:"@@ hunks"}]（IPC 快照实测，diff 为统一 diff 文本）
 *  数组 [{path, added, removed}]（app-server 风格统计）
 *  对象映射 { "路径": {type:'add'|'edit'|'delete', content?, before?, after?} }（rollout/patch_apply 风格，含全文） */
function extractChanges(item: IpcTurnItem): { added: number; removed: number; content: string | null; paths: string[] } {
  const changes = item.changes;
  let added = 0;
  let removed = 0;
  const parts: string[] = [];
  const paths: string[] = [];
  if (Array.isArray(changes)) {
    for (const ch of changes) {
      const p = str((ch as { path?: unknown }).path);
      if (p) paths.push(p);
      const diff = str((ch as { diff?: unknown }).diff);
      if (diff) {
        // 统一 diff：数 +/- 行（排除 hunk 头）
        for (const line of diff.split("\n")) {
          if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) continue;
          if (line.startsWith("+")) added++;
          else if (line.startsWith("-")) removed++;
        }
        const kind = str((ch as { kind?: { type?: unknown } }).kind?.type) ?? "";
        parts.push(`@@ ${p}（${kind || "update"}）\n${diff}`);
        continue;
      }
      added += num((ch as { added?: unknown }).added) ?? 0;
      removed += num((ch as { removed?: unknown }).removed) ?? 0;
    }
  } else if (changes && typeof changes === "object") {
    for (const [path, c] of Object.entries(changes as Record<string, Record<string, unknown>>)) {
      paths.push(path);
      const ctype = str(c.type) ?? "";
      const content = str(c.content);
      const before = str(c.before);
      const after = str(c.after);
      const lineCount = (s: string | null) => (s ? s.split("\n").length : 0);
      if (ctype === "add" && content) {
        added += lineCount(content);
        parts.push(`--- ${path}（新增文件）\n${content
          .split("\n")
          .map((l) => `+${l}`)
          .join("\n")}`);
      } else if (ctype === "delete") {
        removed += lineCount(before ?? content);
        parts.push(`--- ${path}（删除文件）`);
      } else if (before || after) {
        removed += lineCount(before);
        added += lineCount(after);
        parts.push(
          `--- ${path}\n${(before ?? "")
            .split("\n")
            .filter(Boolean)
            .map((l) => `-${l}`)
            .join("\n")}\n${(after ?? "")
            .split("\n")
            .filter(Boolean)
            .map((l) => `+${l}`)
            .join("\n")}`,
        );
      } else if (content) {
        added += lineCount(content);
        parts.push(`--- ${path}\n${content}`);
      }
    }
  }
  const content = parts.length ? parts.join("\n") : null;
  return {
    added,
    removed,
    content: content && content.length > 8000 ? `${content.slice(0, 8000)}…` : content,
    paths,
  };
}

function normalizeItem(turnId: string, idx: number, item: IpcTurnItem): DesktopTurnItemState | null {
  const type = item.type ?? "";
  if (type === "reasoning") return null; // reasoning v0 不渲染
  const key = itemKey(turnId, idx, item);
  const status = str(item.status);
  if (type === "userMessage") {
    // 用户消息（含接管后手机发的指令）——进对话流
    const text = Array.isArray(item.content)
      ? item.content.map((c) => str((c as { text?: unknown })?.text) ?? "").join("")
      : (str(item.text) ?? "");
    return {
      key,
      type: "userMessage",
      status,
      text,
      command: null,
      outputTail: null,
      exitCode: null,
      added: null,
      removed: null,
    };
  }
  if (type === "agentMessage") {
    return {
      key,
      type,
      status,
      text: str(item.text) ?? "",
      command: null,
      outputTail: null,
      exitCode: null,
      added: null,
      removed: null,
    };
  }
  if (type === "commandExecution" || type === "shellCommand" || type === "custom_tool_call") {
    const cmd = str(item.command) ?? "";
    return {
      key,
      type: "commandExecution",
      status,
      text: "",
      command: cmd || null,
      outputTail: (() => {
        const o = str(item.aggregatedOutput) ?? str(item.output);
        return o && o.length > 4000 ? `${o.slice(0, 4000)}…` : o;
      })(),
      exitCode: num(item.exitCode) ?? num(item.exit_code),
      added: null,
      removed: null,
    };
  }
  if (type === "fileChange" || type === "apply_patch" || type === "patch_apply") {
    const ex = extractChanges(item);
    return {
      key,
      type: "fileChange",
      status,
      text: "",
      command: null,
      outputTail: ex.content,
      exitCode: null,
      added: ex.added,
      removed: ex.removed,
    };
  }
  // 未知类型：降级占位卡片（tool.started with generic target）
  return {
    key,
    type: "unknown",
    status,
    text: str(item.text) ?? "",
    command: null,
    outputTail: null,
    exitCode: null,
    added: null,
    removed: null,
  };
}

function normalizeRequest(r: IpcPendingRequest): DesktopRequestState | null {
  const id = typeof r.id === "number" ? String(r.id) : str(r.id);
  if (!id) return null;
  const params = r.params && typeof r.params === "object" ? r.params as Record<string, unknown> : r;
  const raw = JSON.stringify(r);
  const isFile = /file|patch/i.test(str(r.kind) ?? "") || /fileChange/i.test(raw);
  return {
    id,
    kind: isFile ? "fileChange" : "command",
    command: str(params.command) ?? null,
    cwd: str(params.cwd) ?? "",
    reason: str(params.reason),
    availableDecisions: Array.isArray(params.availableDecisions) ? params.availableDecisions : [],
  };
}

export function normalizeSnapshot(cs: ConversationState): DesktopState {
  const entities = cs.turnHistory?.history?.entitiesByKey ?? {};
  const turns: DesktopTurnState[] = Object.entries(entities).map(([key, t]) => ({
    turnId: str(t.turnId) ?? key,
    status: str(t.status) ?? "unknown",
    items: (t.items ?? [])
      .map((it, idx) => normalizeItem(str(t.turnId) ?? key, idx, it))
      .filter((x): x is DesktopTurnItemState => x !== null),
  }));
  const requests = (cs.requests ?? [])
    .map(normalizeRequest)
    .filter((x): x is DesktopRequestState => x !== null);
  return {
    revision: num(cs.revision),
    title: str(cs.title) ?? "",
    turns,
    requests,
  };
}

export function desktopStatusFact(next: DesktopState): Extract<DesktopFact, { kind: "session.status" }> {
  const hasPending = next.requests.length > 0;
  if (hasPending) return { kind: "session.status", status: "waiting_approval", activity: next.requests[0]?.command ?? "等待批准" };
  // history 中可能有本地 tail 或插入顺序不同的实体，不能只用最后一个实体判断活动轮次。
  if (next.turns.some((t) => t.status === "inProgress" || t.status === "running")) {
    return { kind: "session.status", status: "running", activity: null };
  }
  const last = next.turns[next.turns.length - 1];
  if (!last) return { kind: "session.status", status: "idle", activity: null };
  if (last.status === "inProgress" || last.status === "running") return { kind: "session.status", status: "running", activity: null };
  if (last.status === "failed" || last.status === "error") return { kind: "session.status", status: "error", activity: null };
  if (last.status === "interrupted") return { kind: "session.status", status: "idle", activity: null };
  return { kind: "session.status", status: last.status === "completed" ? "done" : "unknown", activity: null };
}

/** 差分：prev → next 产出事件序列 */
export function diffDesktopState(prev: DesktopState | null, next: DesktopState): DesktopFact[] {
  const facts: DesktopFact[] = [];
  const prevTurns = new Map((prev?.turns ?? []).map((t) => [t.turnId, t]));
  const seenItemKeys = new Set((prev?.turns ?? []).flatMap((t) => t.items.map((i) => i.key)));
  const prevText = new Map(
    (prev?.turns ?? []).flatMap((t) => t.items.map((i) => [i.key, i.text] as const)),
  );

  for (const turn of next.turns) {
    const prevTurn = prevTurns.get(turn.turnId);
    for (const item of turn.items) {
      const isNew = !seenItemKeys.has(item.key);

      if (item.type === "userMessage") {
        if (isNew && item.text) {
          facts.push({ kind: "user.message", itemId: item.key, text: item.text });
          seenItemKeys.add(item.key);
        }
        continue;
      }
      if (item.type === "agentMessage") {
        const before = prevText.get(item.key);
        if (isNew && item.text) {
          facts.push({ kind: "agent.message", itemId: item.key, text: item.text });
        } else if (item.text !== before && item.text) {
          // 文本变化（常见为增长）→ 合成流式增量 + 全量消息兜底
          if (before && item.text.length > before.length) {
            facts.push({ kind: "agent.delta", itemId: item.key, delta: item.text.slice(before.length) });
          }
          facts.push({ kind: "agent.message", itemId: item.key, text: item.text });
        }
        seenItemKeys.add(item.key);
        continue;
      }

      const toolKind: "exec" | "fileChange" = item.type === "fileChange" ? "fileChange" : "exec";
      const target =
        toolKind === "exec" ? (item.command?.split(/\s+/)[0] ?? "命令") : (item.outputTail?.slice(0, 60) || "文件改动");
      if (isNew) {
        facts.push({
          kind: "tool.started",
          itemId: item.key,
          toolKind,
          target: item.type === "unknown" ? `未知操作(${item.type})` : target,
          cmd: item.command,
        });
        seenItemKeys.add(item.key);
      }
      const wasFinished =
        prevTurn?.items.find((i) => i.key === item.key)?.status !== "completed" && item.status === "completed";
      const isFreshFinished = isNew && item.status === "completed";
      if (wasFinished || isFreshFinished) {
        facts.push({
          kind: "tool.finished",
          itemId: item.key,
          toolKind,
          target,
          exitCode: item.exitCode,
          added: item.added,
          removed: item.removed,
          outputTail: item.outputTail,
        });
      }
    }
  }

  // requests 差分
  const prevReq = new Map((prev?.requests ?? []).map((r) => [r.id, r]));
  for (const r of next.requests) {
    if (!prevReq.has(r.id)) {
      facts.push({
        kind: "approval.request",
        requestId: r.id,
        approvalKind: r.kind,
        command: r.command,
        cwd: r.cwd,
        reason: r.reason,
        availableDecisions: r.availableDecisions,
      });
    }
  }
  const nextReqIds = new Set(next.requests.map((r) => r.id));
  for (const r of prev?.requests ?? []) {
    if (!nextReqIds.has(r.id)) facts.push({ kind: "approval.resolved", requestId: r.id });
  }

  // 状态（放在末尾，保证 UI 先看到内容再看状态）
  facts.push(desktopStatusFact(next));
  return facts;
}

/** revision 单调校验（任务 2.3）：返回 false 表示乱序/回退，应丢弃并重建。
 *  相等 revision 放行——桌面流式期间同一 revision 会推多个快照（文本在增长），
 *  只有严格更旧才是乱序；差分本身按内容收敛，重复推不产生重复事件。 */
export function revisionOk(prev: number | null, next: number | null): boolean {
  if (prev === null || next === null) return true; // 无 revision 字段时以快照为准
  return next >= prev;
}
