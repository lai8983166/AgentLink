import { parseCodexRateLimits } from "../codex/mapper";
import type { LimitsMonitor } from "./limits";

/** 手机和定时轮询共享一次账户级读取；不会加载或接管会话。 */
export class LimitsRefresh {
  private pending: Promise<void> | null = null;
  private lastAttempt: number | null = null;
  private generation = 0;
  private rerun = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly monitor: LimitsMonitor,
    private readonly bridge: { ready: boolean; accountRateLimitsRead(): Promise<unknown> },
    private readonly now = Date.now) {}

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, 30_000);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.generation++;
    this.rerun = false;
  }
  invalidate(): void {
    this.generation++;
    this.lastAttempt = null;
    this.rerun = !!this.pending;
  }
  refresh(force = false): Promise<void> {
    if (this.pending) return this.pending;
    const startedAt = this.now();
    if (!force && this.lastAttempt != null && startedAt - this.lastAttempt < 15_000) return Promise.resolve();
    if (!this.bridge.ready) { this.monitor.markRefreshFailed(); return Promise.resolve(); }
    this.lastAttempt = startedAt;
    const generation = this.generation;
    this.pending = Promise.resolve().then(() => this.bridge.accountRateLimitsRead()).then((result) => {
      if (generation !== this.generation) return;
      const limits = parseCodexRateLimits(result);
      if (!limits) throw new Error("Codex quota unavailable");
      const accountId = result && typeof result === "object" && "accountId" in result && typeof result.accountId === "string" ? result.accountId : null;
      this.monitor.ingest(limits.primary, limits.secondary, startedAt, { ...limits, source: "official", accountId });
    }).catch(() => {
      if (generation === this.generation) this.monitor.markRefreshFailed();
    }).finally(() => {
      this.pending = null;
      if (this.rerun) { this.rerun = false; void this.refresh(true); }
    });
    return this.pending;
  }
}
