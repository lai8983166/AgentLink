import { ApiClient } from "./api/client";
import { WsClient } from "./api/ws";
import { useStore } from "./store";

/** 运行时单例：API 客户端 + WS 管道 */
export const api = new ApiClient("", () => useStore.getState().token);

export const ws = new WsClient(() => {
  const token = useStore.getState().token;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/v1/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
});

export function connectWs(): void {
  ws.onStateChange = (s) => useStore.getState().setWsConnected(s === "open");
  ws.connect();
}
