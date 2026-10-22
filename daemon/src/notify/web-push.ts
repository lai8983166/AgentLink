import webpush from "web-push";
import { createHash, randomUUID } from "node:crypto";
import type { ListEvent, SessionEvent, PushSubscriptionInput } from "@agentlink/shared";
import { PushStore, type PushJob } from "./push-store";

export type PushSender = (subscription: PushSubscriptionInput, payload: string, options: webpush.RequestOptions) => Promise<unknown>;

/** 库负责标准加密；fetch 的期限同时覆盖 DNS、连接与响应，且不跟随跨站重定向。 */
export const sendWebPush: PushSender = async (subscription, payload, options) => {
  const request = webpush.generateRequestDetails(subscription, payload, options);
  const response = await fetch(request.endpoint, { method: request.method, headers: request.headers,
    body: request.body ? new Uint8Array(request.body) : undefined, redirect: "error", signal: AbortSignal.timeout(10000) });
  await response.body?.cancel().catch(() => {});
  if (!response.ok) throw { statusCode: response.status };
};

/** 只允许浏览器厂商的 Web Push 入口，订阅接口不能成为任意 URL 请求器。 */
export function validPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash && (!u.port || u.port === "443") &&
      (u.hostname === "fcm.googleapis.com" || u.hostname === "android.googleapis.com" || u.hostname === "updates.push.services.mozilla.com" || u.hostname === "web.push.apple.com" || u.hostname.endsWith(".notify.windows.com"));
  } catch { return false; }
}

export class WebPushService {
  readonly publicKey: string;
  private keys: { publicKey: string; privateKey: string };
  private titles = new Map<string, string>();
  private statuses = new Map<string, string>();
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private recordFailures = 0;
  constructor(readonly store: PushStore, private readonly send: PushSender = sendWebPush, private readonly now = Date.now) {
    this.keys = store.keys(webpush.generateVAPIDKeys);
    this.publicKey = this.keys.publicKey;
  }
  subscribe(s: PushSubscriptionInput): string {
    if (!validPushEndpoint(s.endpoint) || Buffer.from(s.keys.p256dh, "base64url").length !== 65 || Buffer.from(s.keys.auth, "base64url").length !== 16) throw new Error("INVALID_PUSH_SUBSCRIPTION");
    return this.store.subscribe(s);
  }
  onEvent(e: SessionEvent | ListEvent): void {
    if (this.stopped) return;
    try { this.recordEvent(e); }
    catch { if (this.recordFailures++ < 3) console.warn("[push] 通知记录失败，不影响任务执行"); }
  }
  private recordEvent(e: SessionEvent | ListEvent): void {
    if ("summary" in e) {
      this.titles.set(e.summary.id, e.summary.title.slice(0, 100));
      if (this.titles.size > 1000) this.titles.delete(this.titles.keys().next().value!);
    } else if (e.type === "session.status") {
      if (this.statuses.get(e.sessionId) === e.status) return;
      this.store.taskStatus(e.sessionId, e.status, (eventId) => JSON.stringify({
        title: e.status === "error" ? "AgentLink · 任务出错" : "AgentLink · 任务完成",
        body: `${this.titles.get(e.sessionId) || `会话 ${e.sessionId.slice(0, 8)}`}：${e.status === "error" ? "本轮出错，点击查看" : "本轮已完成，点击查看结果"}`,
        url: `/${encodeURIComponent(e.sessionId)}`, tag: createHash("sha256").update(eventId).digest("hex").slice(0, 32),
      }), this.now());
      this.statuses.set(e.sessionId, e.status);
      if (this.statuses.size > 1000) this.statuses.delete(this.statuses.keys().next().value!);
      if (e.status === "done" || e.status === "error") void this.flush();
    }
  }
  async test(id: string): Promise<void> {
    this.store.enqueue(`test:${randomUUID()}`, JSON.stringify({ title: "AgentLink · 测试通知", body: "收到此通知表示手机推送已接通。", url: "/settings", tag: "agentlink-test" }), this.now(), id);
    await this.flush();
  }
  start(sync?: () => Promise<unknown>): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.flush(); }, 2000); this.timer.unref?.();
    let syncing = false;
    const refresh = async () => {
      if (!sync || syncing) return;
      syncing = true;
      try { if (this.store.hasDevices()) await sync(); } catch { /* 电脑失联不等于任务完成 */ } finally { syncing = false; }
    };
    this.syncTimer = setInterval(() => { void refresh(); }, 30000); this.syncTimer.unref?.();
    void this.flush(); void refresh();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.timer = null; this.syncTimer = null;
  }
  async close(): Promise<void> { this.stop(); await this.pending; this.store.close(); }
  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(async () => {
      for (const job of this.store.due(this.now())) {
        if (this.stopped) break;
        await this.deliver(job);
      }
    }).catch(() => { /* 通知旁路不影响会话执行 */ }).finally(() => { this.pending = null; });
    return this.pending;
  }
  private async deliver(job: PushJob): Promise<void> {
    if (!this.store.status(job.deviceId)) return;
    try {
      await this.send({ endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth } }, job.payload, {
        vapidDetails: { ...this.keys, subject: "https://github.com/lai8983166/AgentLink" },
        TTL: Math.max(1, Math.floor((job.expiresAt - this.now()) / 1000)), timeout: 10000, urgency: "normal",
        topic: createHash("sha256").update(job.id).digest("base64url").slice(0, 32),
      });
      this.store.accepted(job, this.now());
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : null;
      if (status === 404 || status === 410) this.store.remove(job.deviceId);
      else this.store.failed(job, this.now());
    }
  }
}
