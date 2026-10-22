import type { PushSubscriptionInput } from "@agentlink/shared";
import { api } from "./runtime";

const DEVICE_KEY = "agentlink-push-device";
export function pushDeviceId(): string | null { return localStorage.getItem(DEVICE_KEY); }
export function pushSupportError(): string | null {
  if (!window.isSecureContext) return "系统通知需要 HTTPS，请使用安全网址打开 AgentLink。";
  if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) return "当前浏览器不支持后台推送，请使用支持 Web Push 的浏览器打开并重新添加桌面入口。";
  return null;
}
export function pushPermission(): NotificationPermission | "unsupported" { return "Notification" in window ? Notification.permission : "unsupported"; }

export function boundedPush<T>(promise: Promise<T>, message: string, timeout = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeout);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
async function registration(): Promise<ServiceWorkerRegistration> {
  return boundedPush(navigator.serviceWorker.ready, "通知组件尚未就绪，请更新页面后重试。");
}
export function publicKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const text = atob(key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - key.length % 4) % 4));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}
function sameKey(subscription: PushSubscription, key: string): boolean {
  const actual = subscription.options.applicationServerKey;
  const wanted = publicKeyBytes(key);
  return !!actual && new Uint8Array(actual).length === wanted.length && new Uint8Array(actual).every((x, i) => x === wanted[i]);
}
export async function inspectPush() {
  const config = await api.pushConfig(pushDeviceId());
  const reg = await registration();
  const sub = await boundedPush(reg.pushManager.getSubscription(), "无法读取通知订阅，请稍后重试。");
  return { ...config, active: !!sub && !!config.device && pushPermission() === "granted" && sameKey(sub, config.publicKey) };
}
export async function enablePush(publicKey: string, options: { renew?: boolean } = {}) {
  // 权限弹窗必须直接由点击触发，在第一个异步等待前调用。
  const permission = await boundedPush(Notification.requestPermission(), "通知授权未完成，请重试。");
  if (permission !== "granted") throw new Error("未获得通知权限。请在浏览器或系统设置中允许 AgentLink 通知后重试。");
  const reg = await registration();
  let sub = await boundedPush(reg.pushManager.getSubscription(), "无法读取通知订阅。");
  if (sub && (options.renew || !sameKey(sub, publicKey))) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await boundedPush(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(publicKey) }), "开通超时，手机可能无法连接浏览器推送服务；请检查网络后重试。");
  const subscription = sub.toJSON();
  if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) throw new Error("浏览器返回的通知订阅不完整，请重试。");
  const result = await api.pushSubscribe(subscription as PushSubscriptionInput);
  localStorage.setItem(DEVICE_KEY, result.device.id);
  return { publicKey, device: result.device, active: true };
}
export async function disablePush(): Promise<void> {
  const id = pushDeviceId();
  // 后台先撤销订阅，避免浏览器关掉后仍然发送旧设备通知。
  if (id) await api.pushRemove(id);
  localStorage.removeItem(DEVICE_KEY);
  if ("serviceWorker" in navigator) {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    await sub?.unsubscribe();
  }
}
