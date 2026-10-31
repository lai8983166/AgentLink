import { createHash } from "node:crypto";
import type { HistoryItem, ToolKind } from "@agentlink/shared";

export function toolKind(name: string): ToolKind {
  return /^(Bash|PowerShell)$/.test(name) ? "exec" : /^(Edit|Write|NotebookEdit)$/.test(name) ? "fileChange" : "tool";
}
export function toolLabel(input: unknown, fallback: string): string {
  if (!input || typeof input !== "object") return fallback;
  const i = input as Record<string, unknown>;
  return String(i.command ?? i.file_path ?? i.description ?? fallback).slice(0, 8000);
}

/** API 快照没有消息 UUID。按有序的角色/文本复用实时 ID，重复文本逐条匹配。 */
export function mergeClaudeHistory(raw: unknown, previous: HistoryItem[], at: number): HistoryItem[] {
  if (!Array.isArray(raw)) return previous;
  const used = new Set<string>();
  const result: HistoryItem[] = [];
  const add = (type: "userMessage" | "agentMessage", text: string, index: number) => {
    if (!text) return;
    const old = previous.find(h => h.type === type && h.text === text && !used.has(h.id));
    const id = old?.id ?? "ch-" + createHash("sha256").update(`${index}:${type}:${text}`).digest("hex").slice(0, 24);
    used.add(id);
    result.push(old ?? { type, id, text, at });
  };
  for (const [index, value] of raw.slice(-500).entries()) {
    if (!value || typeof value !== "object") continue;
    const m = value as Record<string, unknown>;
    if (typeof m.text === "string") add(m.role === "user" ? "userMessage" : "agentMessage", m.text, index);
    if (!Array.isArray(m.toolUses)) continue;
    for (const value of m.toolUses) {
      if (!value || typeof value !== "object") continue;
      const tool = value as Record<string, unknown>;
      const id = String(tool.id ?? tool.tool_use_id ?? `snapshot-tool-${index}-${result.length}`);
      const old = previous.find(h => h.type === "toolCall" && h.id === id);
      const name = String(tool.name ?? tool.tool ?? "Tool");
      result.push(old ?? { type: "toolCall", id, kind: toolKind(name), target: name,
        cmd: toolLabel(tool.input, name), exitCode: typeof tool.isError === "boolean" ? tool.isError ? 1 : 0 : null,
        durationMs: null, diffStat: null, outputTail: typeof tool.text === "string" ? tool.text.slice(-8000) : null, at });
    }
  }
  return result.slice(-500);
}
