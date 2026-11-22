import type { CodexTransportFactory } from "./process";

export interface SharedEndpoint {
  url: string;
  token: string;
}

export function sharedEndpoint(url: string, token: string): SharedEndpoint {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" ||
      !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname !== "/") {
    throw new Error("共享 App Server 必须使用带端口的本机 WebSocket（127.0.0.1）");
  }
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error("共享 App Server 需要独立的能力令牌");
  return { url: endpoint.href, token };
}

function connect(endpoint: SharedEndpoint) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  return new BunWebSocket(endpoint.url, { headers: { Authorization: `Bearer ${endpoint.token}` } });
}

/** Stop/reconnect closes only this client socket. The shared server owns its lifecycle. */
export function sharedTransport(endpoint: SharedEndpoint): CodexTransportFactory {
  return {
    create(onData) {
      const socket = connect(endpoint);
      const pending: string[] = [];
      let onClose: (() => void) | undefined;
      socket.onopen = () => { for (const line of pending.splice(0)) socket.send(line); };
      socket.onmessage = ({ data }) => { if (typeof data === "string") onData(data + "\n"); };
      socket.onclose = () => { pending.length = 0; onClose?.(); };
      return {
        write(line) {
          if (socket.readyState === WebSocket.OPEN) socket.send(line);
          else if (socket.readyState === WebSocket.CONNECTING) pending.push(line);
          else throw new Error("共享 App Server 连接已断开");
        },
        kill() { socket.close(); },
        onExit(callback) { onClose = () => callback(null); },
      };
    },
  };
}

type Frame = {
  id?: string | number;
  method?: string;
  params?: { threadId?: string };
  result?: { thread?: { id?: string; status?: { type?: string } } };
};
type Peer = {
  upstream?: WebSocket;
  pending: string[];
  reads: Map<string | number, string>;
  subscriptions: Set<string>;
  attaches: Map<string, string>;
};
function parse(text: string): Frame | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : undefined;
  } catch { return undefined; }
}

/** Desktop reads an already loaded thread without subscribing. Join it on the same socket. */
export function startSharedDesktopRelay(endpoint: SharedEndpoint, port: number, key: string) {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(key) || key === endpoint.token) throw new Error("桌面中转需要单独的随机密钥");
  const path = `/${key}`;
  return Bun.serve<Peer>({
    hostname: "127.0.0.1", port, idleTimeout: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === path &&
          server.upgrade(request, { data: { pending: [], reads: new Map(), subscriptions: new Set(), attaches: new Map() } })) return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      maxPayloadLength: 16 * 1024 * 1024,
      open(peer) {
        const upstream = connect(endpoint);
        peer.data.upstream = upstream;
        upstream.onopen = () => { for (const line of peer.data.pending.splice(0)) upstream.send(line); };
        upstream.onclose = () => peer.close();
        upstream.onmessage = ({ data }) => {
          if (typeof data !== "string") return;
          const frame = parse(data);
          if (typeof frame?.id === "string" && peer.data.attaches.has(frame.id)) {
            const id = peer.data.attaches.get(frame.id)!;
            peer.data.attaches.delete(frame.id);
            if (frame.result?.thread?.id === id) peer.data.subscriptions.add(id);
            return;
          }
          if (frame?.id != null) {
            const id = peer.data.reads.get(frame.id);
            peer.data.reads.delete(frame.id);
            const thread = frame.result?.thread;
            if (id && thread?.id === id && ["idle", "active"].includes(thread.status?.type ?? "") &&
                !peer.data.subscriptions.has(id) && ![...peer.data.attaches.values()].includes(id) &&
                peer.data.attaches.size < 32) {
              const requestId = `agentlink-subscribe-${crypto.randomUUID()}`;
              peer.data.attaches.set(requestId, id);
              upstream.send(JSON.stringify({ id: requestId, method: "thread/resume", params: { threadId: id, excludeTurns: true } }));
            }
          }
          peer.send(data);
        };
      },
      message(peer, data) {
        if (typeof data !== "string") { peer.close(1003, "Text JSON-RPC required"); return; }
        const frame = parse(data);
        const id = frame?.params?.threadId;
        if (frame?.method === "thread/read" && frame.id != null && typeof id === "string" && peer.data.reads.size < 128) {
          peer.data.reads.set(frame.id, id);
        }
        if (frame?.method === "thread/unsubscribe" && typeof id === "string") peer.data.subscriptions.delete(id);
        const upstream = peer.data.upstream;
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(data);
        else if (peer.data.pending.length < 32) peer.data.pending.push(data);
        else peer.close(1013, "App Server unavailable");
      },
      close(peer) { peer.data.upstream?.close(); },
    },
  });
}
