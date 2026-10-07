import type { SessionEvent } from "@agentlink/shared";
import type { PendingApproval } from "../domain/approvals";

/**
 * ntfy 推送网关（任务 6.2）：三类通知、去重、通道故障隔离。
 * 订阅主题（手机 ntfy App）：
 *   {topicPrefix}-approval  审批请求（最高优先级）
 *   {topicPrefix}-task      完成 / 出错
 */
export interface NtfyConfig {
  enabled: boolean;
  url: string;
  topicPrefix: string;
  /** 点击通知的跳转基址，如 https://agent.example.com（拼 /<sessionId>） */
  clickBase: string;
}

export class NtfyGateway {
  private notifiedApprovals = new Set<string>();
  private failures = 0;

  constructor(private readonly cfg: NtfyConfig) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** 审批请求通知（去重：同一 approvalId 只推一次） */
  approvalRequest(a: PendingApproval): void {
    if (!this.cfg.enabled) return;
    const key = `${a.sessionId}:${a.approvalId}`;
    if (this.notifiedApprovals.has(key)) return;
    this.notifiedApprovals.add(key);
    if (this.notifiedApprovals.size > 500) {
      this.notifiedApprovals = new Set([...this.notifiedApprovals].slice(200));
    }
    const cmd = a.command ?? (a.kind === "fileChange" ? "文件改动" : "操作");
    this.publish(`${this.cfg.topicPrefix}-approval`, {
      title: `⚠️ 等待审批 · ${(a.cwd || "").split(/[\\/]/).pop() ?? ""}`,
      body: cmd.slice(0, 200),
      priority: 5, // ntfy 最高优先级（即时/大声）
      tags: "warning",
      click: this.deepLink(a.sessionId, a.approvalId),
    });
  }

  /** 会话事件 → 完成/出错通知 */
  onEvent(e: SessionEvent): void {
    if (!this.cfg.enabled) return;
    if (e.type === "session.status" && e.status === "done") {
      this.publish(`${this.cfg.topicPrefix}-task`, {
        title: "✅ 任务完成",
        body: "会话本轮已结束，回来看看结果",
        priority: 3,
        click: this.deepLink(e.sessionId),
      });
    } else if (e.type === "session.status" && e.status === "error") {
      this.publish(`${this.cfg.topicPrefix}-task`, {
        title: "🔴 任务出错",
        body: e.activity ?? "会话以错误结束",
        priority: 4,
        tags: "rotating_light",
        click: this.deepLink(e.sessionId),
      });
    }
  }

  /** 账户额度用尽通知（LimitsMonitor 上升沿触发；去重在监控侧，按 resetsAt） */
  quotaExhausted(window: "5h" | "week", resetsAt: number): void {
    if (!this.cfg.enabled) return;
    const at = new Date(resetsAt * 1000);
    const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    this.publish(`${this.cfg.topicPrefix}-task`, {
      title: window === "5h" ? "⏳ 5 小时额度已用尽" : "⏳ 周额度已用尽",
      body: window === "5h" ? `约 ${hhmm} 重置，重置前新任务会被拒` : `约 ${hhmm} 重置（周窗口）`,
      priority: 4,
      tags: "hourglass",
      click: this.cfg.clickBase ? this.cfg.clickBase.replace(/\/$/, "") : undefined,
    });
  }

  private deepLink(sessionId: string, approvalId?: string): string | undefined {
    if (!this.cfg.clickBase) return undefined;
    const base = this.cfg.clickBase.replace(/\/$/, "");
    return approvalId ? `${base}/${sessionId}?approval=${approvalId}` : `${base}/${sessionId}`;
  }

  private publish(topic: string, opts: Record<string, unknown>): void {
    const url = `${this.cfg.url.replace(/\/$/, "")}/${topic}`;
    fetch(url, {
      method: "POST",
      body: JSON.stringify(opts),
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    })
      .then(() => {
        this.failing(false);
      })
      .catch((e) => {
        this.failing(true);
        if (this.failures <= 3) console.warn("[ntfy] 推送失败（不影响主链路）:", e.message ?? e);
      });
  }

  private failing(on: boolean): void {
    if (on) this.failures++;
    else if (this.failures > 0) {
      console.log("[ntfy] 通道恢复");
      this.failures = 0;
    }
  }
}
