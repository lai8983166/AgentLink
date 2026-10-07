import { readdirSync, openSync, readSync, closeSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RateLimitWindow } from "@agentlink/shared";

/**
 * rollout 文件限额尾读（桌面会话的额度来源）：
 * 桌面端干活时把 token_usage_record（含 rate_limits 双窗口）持续写进
 * ~/.codex/sessions/YYYY/MM/DD/rollout-*-<conversationId>.jsonl——IPC 快照不含限额，
 * 这是桌面驱动场景下唯一的实时来源。只读文件尾部，路径按会话 ID 缓存。
 */

const rolloutCache = new Map<string, string | null>();

export function findRollout(conversationId: string, sessionsRoot = join(homedir(), ".codex", "sessions")): string | null {
  if (rolloutCache.has(conversationId)) return rolloutCache.get(conversationId) ?? null;
  let found: string | null = null;
  if (existsSync(sessionsRoot)) {
    const files = readdirSync(sessionsRoot, { recursive: true, encoding: "utf8" }) as string[];
    for (const f of files) {
      if (f.endsWith(`-${conversationId}.jsonl`)) {
        found = join(sessionsRoot, f);
        break;
      }
    }
  }
  rolloutCache.set(conversationId, found);
  if (rolloutCache.size > 100) {
    const first = rolloutCache.keys().next().value;
    if (first !== undefined) rolloutCache.delete(first);
  }
  return found;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** snake_case / camelCase 双命名防御解析（rollout 实测 snake_case，app-server 通知 camelCase） */
function parseWindow(v: unknown): RateLimitWindow | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const used = num(o.used_percent) ?? num(o.usedPercent);
  const mins = num(o.window_minutes) ?? num(o.windowMinutes) ?? num(o.windowDurationMins);
  const resets = num(o.resets_at) ?? num(o.resetsAt);
  if (used == null || mins == null || resets == null) return null;
  return { usedPercent: used, windowDurationMins: mins, resetsAt: resets };
}

/** 读文件尾部，提取最后一条 rate_limits（primary 5h / secondary 周） */
export function tailRateLimits(path: string): { primary: RateLimitWindow; secondary: RateLimitWindow | null } | null {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    // 从尾部最多 256KB 找（额度记录高频，足够覆盖）
    const length = Math.min(size, 262_144);
    const start = size - length;
    fd = openSync(path, "r");
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0 && lines[0] !== undefined) lines.shift(); // 前半截行丢弃
    let last: { primary?: unknown; secondary?: unknown } | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l || !l.includes("rate_limits")) continue;
      try {
        const rec = JSON.parse(l) as Record<string, unknown>;
        const payload = (rec.payload ?? rec) as Record<string, unknown>;
        const rl = (payload.rate_limits ?? rec.rate_limits ?? payload.rateLimits) as
          | { primary?: unknown; secondary?: unknown }
          | undefined;
        if (rl) {
          last = rl;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!last) return null;
    const primary = parseWindow(last.primary);
    if (!primary) return null;
    return { primary, secondary: parseWindow(last.secondary) };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** 组合入口：会话 → 最新限额（找不到 rollout 或无记录返回 null） */
export function rolloutLimits(conversationId: string): { primary: RateLimitWindow; secondary: RateLimitWindow | null } | null {
  const path = findRollout(conversationId);
  if (!path) return null;
  return tailRateLimits(path);
}
