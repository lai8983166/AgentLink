import type { RateLimitWindow } from "@agentlink/shared";

/**
 * 账户限额监控（额度可见 + 限额告警）：
 * 数据源双通道——app-server 用量通知（自驱会话）+ rollout 文件尾读（桌面会话，token_usage_record 带 rate_limits）。
 * 账户级单一状态：变化 → account.limits 列表事件；用尽上升沿 → 回调（ntfy 推送）。
 */
export interface LimitsState {
  primary: RateLimitWindow;
  secondary: RateLimitWindow | null;
  /** 本次数据的测量时刻（rollout 记录时间；用于 UI 标注新鲜度） */
  measuredAt: number | null;
}

const EXHAUSTED_PCT = 99.5;

export class LimitsMonitor {
  private current: LimitsState | null = null;
  /** 已通知的用尽窗口（resetsAt 为键：新窗口才再次通知） */
  private notifiedResetsAt = new Set<number>();

  /** 限额变化 → 列表事件（account.limits） */
  onChange: (limits: LimitsState) => void = () => {};
  /** 某窗口用尽上升沿（window: "5h" | "week"）→ ntfy 等外部通知 */
  onExhausted: (window: "5h" | "week", w: RateLimitWindow) => void = () => {};

  snapshot(): LimitsState | null {
    const c = this.current;
    if (!c) return null;
    // 过期窗口不再展示为"当前"（reset 时间已过 10 分钟且没有新数据 → 视为陈旧）
    const now = Date.now() / 1000;
    if (c.primary.resetsAt > now - 600) return c;
    if (c.secondary && c.secondary.resetsAt > now - 600) return { primary: c.secondary, secondary: null, measuredAt: c.measuredAt };
    return null;
  }

  ingest(primary: RateLimitWindow, secondary: RateLimitWindow | null, measuredAt: number | null = null): void {
    const prev = this.current;
    // 只前进：resetsAt 更新或百分比变化的才视为新数据（防旧文件尾读回退）
    if (prev && primary.resetsAt === prev.primary.resetsAt && primary.usedPercent < prev.primary.usedPercent) {
      return;
    }
    this.current = { primary, secondary, measuredAt };
    if (
      !prev ||
      primary.usedPercent !== prev.primary.usedPercent ||
      secondary?.usedPercent !== prev.secondary?.usedPercent ||
      primary.resetsAt !== prev.primary.resetsAt
    ) {
      this.onChange({ primary, secondary, measuredAt });
    }
    this.checkExhausted("5h", primary);
    if (secondary) this.checkExhausted("week", secondary);
  }

  private checkExhausted(window: "5h" | "week", w: RateLimitWindow): void {
    if (w.usedPercent < EXHAUSTED_PCT) return;
    if (this.notifiedResetsAt.has(w.resetsAt)) return;
    this.notifiedResetsAt.add(w.resetsAt);
    if (this.notifiedResetsAt.size > 20) {
      this.notifiedResetsAt = new Set([...this.notifiedResetsAt].slice(-10));
    }
    this.onExhausted(window, w);
  }
}
