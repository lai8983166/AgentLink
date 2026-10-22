import type { RateLimit, RateLimitWindow } from "@agentlink/shared";

/**
 * 账户限额监控（额度可见 + 限额告警）：
 * 官方账户读取/推送优先；rollout 文件只作为未获得官方数据时的历史降级来源。
 * 账户级单一状态：变化 → account.limits 列表事件；用尽上升沿 → 回调（ntfy 推送）。
 */
export type LimitsState = RateLimit;
type Metadata = Pick<RateLimit, "source" | "limitId" | "limitName" | "rateLimitReachedType"> & { accountId?: string | null };

export class LimitsMonitor {
  private current: LimitsState | null = null;
  private accountId: string | null = null;
  private officialSeen = false;
  private revision = 0;
  /** 已通知的用尽窗口（窗口类型 + resetsAt），切换账户后清空。 */
  private notifiedWindows = new Set<string>();

  /** 限额变化 → 列表事件（account.limits） */
  onChange: (limits: LimitsState) => void = () => {};
  /** 某窗口用尽上升沿（window: "5h" | "week"）→ ntfy 等外部通知 */
  onExhausted: (window: "5h" | "week", w: RateLimitWindow) => void = () => {};

  snapshot(): LimitsState | null {
    return this.current;
  }
  needsHistoryFallback(): boolean { return !this.officialSeen; }

  reset(): void {
    this.officialSeen = true;
    this.accountId = null;
    this.notifiedWindows.clear();
    this.publish({ primary: null, secondary: null, measuredAt: null, source: "official" });
  }

  markRefreshFailed(): void {
    if (this.current && !this.current.refreshFailed) this.publish({ ...this.current, refreshFailed: true });
  }

  ingest(primary: RateLimitWindow | null, secondary: RateLimitWindow | null, measuredAt: number | null = Date.now(), meta: Metadata = {}): void {
    if (meta.limitId && meta.limitId !== "codex") return;
    const source = meta.source ?? "notification";
    if (source === "history" && this.officialSeen) return;
    if (meta.accountId && this.accountId && meta.accountId !== this.accountId) {
      this.current = null;
      this.notifiedWindows.clear();
    }
    if (meta.accountId) this.accountId = meta.accountId;
    const prev = this.current;
    if (prev?.source !== "history" || source === "history") {
      if (prev?.measuredAt != null && (measuredAt == null || measuredAt < prev.measuredAt)) return;
    }
    if (source !== "history") this.officialSeen = true;
    const next: LimitsState = { primary, secondary, measuredAt, source, limitId: meta.limitId ?? null,
      limitName: meta.limitName ?? null, rateLimitReachedType: meta.rateLimitReachedType ?? null, refreshFailed: false };
    const { updatedAt: _, ...old } = prev ?? {};
    if (JSON.stringify(next) !== JSON.stringify(old)) this.publish(next);
    if (source !== "history") {
      if (primary?.windowDurationMins === 300) this.checkExhausted("5h", primary);
      if (secondary?.windowDurationMins === 10080) this.checkExhausted("week", secondary);
    }
  }

  private publish(state: LimitsState): void {
    this.revision = Math.max(Date.now(), this.revision + 1);
    this.current = { ...state, updatedAt: this.revision };
    this.onChange(this.current);
  }

  private checkExhausted(window: "5h" | "week", w: RateLimitWindow): void {
    if (w.usedPercent < 100 || w.resetsAt <= Date.now() / 1000) return;
    const key = `${window}:${w.resetsAt}`;
    if (this.notifiedWindows.has(key)) return;
    this.notifiedWindows.add(key);
    if (this.notifiedWindows.size > 20) {
      this.notifiedWindows = new Set([...this.notifiedWindows].slice(-10));
    }
    this.onExhausted(window, w);
  }
}
