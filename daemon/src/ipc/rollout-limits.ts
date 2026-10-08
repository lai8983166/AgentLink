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

/** 读文件尾部，提取最后一条 rate_limits（primary 5h / secondary 周）+ 记录时间 */
export function tailRateLimits(
  path: string,
): { primary: RateLimitWindow; secondary: RateLimitWindow | null; measuredAt: number | null } | null {
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
    let measuredAt: number | null = null;
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
          const ts = rec.timestamp;
          if (typeof ts === "string") {
            const t = Date.parse(ts);
            if (Number.isFinite(t)) measuredAt = t;
          }
          break;
        }
      } catch {
        continue;
      }
    }
    if (!last) return null;
    const primary = parseWindow(last.primary);
    if (!primary) return null;
    return { primary, secondary: parseWindow(last.secondary), measuredAt };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export type RolloutLimits = NonNullable<ReturnType<typeof tailRateLimits>>;

/** 合并多条来源：按 (resetsAt, usedPercent) 取各窗口最新值（同窗口内用量单调增，值大者新） */
export function mergeLimits(a: RolloutLimits | null, b: RolloutLimits | null): RolloutLimits | null {
  if (!a) return b;
  if (!b) return a;
  const pick = (x: RateLimitWindow, y: RateLimitWindow) =>
    y.resetsAt > x.resetsAt || (y.resetsAt === x.resetsAt && y.usedPercent > x.usedPercent) ? y : x;
  const secondary = [a.secondary, b.secondary].filter((w): w is RateLimitWindow => w !== null);
  return {
    primary: pick(a.primary, b.primary),
    secondary: secondary.length ? secondary.reduce((acc, w) => pick(acc, w)) : null,
    measuredAt: Math.max(a.measuredAt ?? 0, b.measuredAt ?? 0) || null,
  };
}

/** 观察中会话 + 全局最近活跃的 rollout（最多 2 个）合并取最新——账户级额度，别的会话干活也算 */
export function recentLimits(conversationId: string, sessionsRoot = join(homedir(), ".codex", "sessions")): RolloutLimits | null {
  const candidates = new Set<string>();
  const observed = findRollout(conversationId, sessionsRoot);
  if (observed) candidates.add(observed);
  try {
    if (existsSync(sessionsRoot)) {
      const files = readdirSync(sessionsRoot, { recursive: true, encoding: "utf8" }) as string[];
      const hot = files
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ f, m: statSync(join(sessionsRoot, f)).mtimeMs }))
        .sort((x, y) => y.m - x.m)
        .slice(0, 2);
      for (const h of hot) candidates.add(join(sessionsRoot, h.f));
    }
  } catch {
    // 目录扫描失败不影响被观察会话的读取
  }
  let out: RolloutLimits | null = null;
  for (const p of candidates) out = mergeLimits(out, tailRateLimits(p));
  return out;
}

/** 组合入口：会话 → 最新限额（找不到 rollout 或无记录返回 null） */
export function rolloutLimits(conversationId: string): RolloutLimits | null {
  const path = findRollout(conversationId);
  if (!path) return null;
  return tailRateLimits(path);
}
