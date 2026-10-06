import { QueryClient } from "@tanstack/react-query";
import { ApiClient } from "./api/client";
import { WsClient } from "./api/ws";
import { useStore } from "./store";

/** 运行时单例：API 客户端 + WS 管道 + 全局 QueryClient */
export const api = new ApiClient("", () => useStore.getState().token);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 5000 },
  },
});

export const ws = new WsClient(() => {
  const token = useStore.getState().token;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/v1/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
});

export function connectWs(): void {
  ws.onStateChange = (s) => {
    useStore.getState().setWsConnected(s === "open");
    if (s === "open") {
      // 重连成功：桌面会话的快照历史可能已推进，失效详情缓存
      queryClient.invalidateQueries({ queryKey: ["session"] });
    }
  };
  ws.connect();
}
