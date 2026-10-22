import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export const isAndroidApp = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
export interface NativeStatus {
  enabled: boolean; running: boolean; permission: boolean; batteryExempt: boolean;
  state: string; lastConnectedAt: number; lastDeliveredAt: number; version: string;
}
interface NativePlugin {
  start(options: { url: string; token: string }): Promise<NativeStatus>;
  stop(): Promise<NativeStatus>;
  status(): Promise<NativeStatus>;
  test(): Promise<void>;
  batterySettings(): Promise<void>;
  consumeNavigation(): Promise<{ path?: string }>;
  addListener(event: "navigation", listener: (event: { path: string }) => void): Promise<PluginListenerHandle>;
}
export const native = registerPlugin<NativePlugin>("AgentLinkNative");
export function normalizeServerUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("请输入完整的 HTTPS 服务器地址，不包含路径、参数或账号密码");
  }
  return url.origin;
}
export function serverBase(): string {
  return isAndroidApp() ? localStorage.getItem("agentlink-server") ?? "" : "";
}
export function setServerBase(value: string) { localStorage.setItem("agentlink-server", normalizeServerUrl(value)); }
/** 通知仅允许打开应用内部页面。 */
export function notificationPath(path: string): string | null {
  return /^\/(?:settings|[a-zA-Z0-9_%.-]+)$/.test(path) && !path.includes("..") ? path : null;
}
