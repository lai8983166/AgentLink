import { SessionListResponse, SessionDetailResponse, HistoryWindowResponse, StatusResponse, FsListResponse,
  MessageReceipt, ServerMessage, historyItemKey } from "../../shared/src/index";
import type { SessionSummary, SessionDetailResponse as Detail, HistoryWindowResponse as WindowDetail, SessionEvent } from "../../shared/src/index";
import { applySessionEvent, mergeSessionDetail, mergeResumedDetail } from "../../web/src/session-state";
import { WsClient, type FakeableSocket } from "../../web/src/api/ws";

export interface Port { call(op: string, data?: Record<string, unknown>): Promise<any>; }
export type Pairing = { paired: boolean; scope: string; url: string; pendingUnpair?: boolean; version?: string; navigation?: string };
export type Outgoing = { id: string; text: string; state: "sending" | "queued" | "accepted" | "failed" | "uncertain" };
type Box = { draft: string; messages: Outgoing[] };
export type Screen = "home" | "session" | "settings" | "new";
export class ApiError extends Error { constructor(public status: number, public code: string, text: string) { super(text); } }
export function decodeDetail(raw: unknown): Detail | WindowDetail {
  return raw && typeof raw === "object" && "historySync" in raw ? HistoryWindowResponse.parse(raw) : SessionDetailResponse.parse(raw);
}

export function mergeWindow(previous: Detail | undefined, wire: WindowDetail | Detail): Detail | undefined {
  if (!("historySync" in wire)) return wire;
  const { historySync: sync, ...detail } = wire;
  if (!detail.historyPage || (sync.mode === "patch" && (!previous || previous.historyPage?.revision !== sync.baseRevision || previous.serverEpoch !== wire.serverEpoch))) return;
  const items = new Map((sync.mode === "patch" ? previous!.session.history : []).map(item => [historyItemKey(item), item]));
  for (const item of wire.session.history) items.set(historyItemKey(item), item);
  if (new Set(sync.order).size !== sync.order.length || sync.order.some(id => !items.has(id))) return;
  return { ...detail, session: { ...detail.session, history: sync.order.map(id => items.get(id)!) } };
}
export function canControl(detail: Detail | undefined, fresh: boolean): boolean {
  if (!fresh || !detail || detail.historyPage?.cached || detail.session.status === "unknown") return false;
  const s = detail.session;
  return s.agent === "claude" ? !!s.terminal?.connected && !s.terminal.inputBlocked : s.controlMode === "local" || s.controlMode === "takeover";
}
export function decisions(values: unknown[]): string[] {
  return values.filter((v): v is string => typeof v === "string" && ["accept", "acceptForSession", "decline", "cancel"].includes(v));
}

export class Client {
  view = { pairing: null as Pairing | null, screen: "home" as Screen, sessions: [] as SessionSummary[],
    agent: "recent" as "recent" | "codex" | "claude", query: "", limit: 50, sessionId: "", detail: undefined as Detail | undefined,
    fresh: false, online: false, ws: "idle", busy: false, notice: "", status: null as any, notifications: null as any,
    fs: null as any, project: "", policy: "on-request", prompt: "", outbox: { draft: "", messages: [] } as Box };
  onChange = () => {};
  private generation = 0;
  private http = new Map<string, Detail>();
  private boxes: Record<string, Box> = {};
  private pending = new Map<string, Promise<Detail>>();
  private ws?: WsClient;
  private socket?: HostSocket;
  private unlisten?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private active = true;
  private rechecking = false;
  private disposed = false;
  constructor(private port: Port) {}
  changed() { if (!this.disposed) { this.view = { ...this.view }; this.onChange(); } }
  private async call(op: string, data: Record<string, unknown> = {}) {
    const generation = this.generation;
    const value = await this.port.call(op, { scope: this.view.pairing?.scope ?? "", ...data });
    if (generation !== this.generation || this.disposed) throw new Error("配对已变更");
    return value;
  }
  async bootstrap() {
    try {
      this.view.pairing = await this.port.call("bootstrap");
      if (this.view.pairing?.paired) {
        try {
          const cached = JSON.parse(await this.call("storage.get", { key: "history" }) || "[]");
          for (const raw of cached.slice(-8)) { const d = SessionDetailResponse.safeParse(raw); if (d.success) this.http.set(d.data.session.id, d.data); }
          const boxes = JSON.parse(await this.call("storage.get", { key: "outbox" }) || "{}");
          for (const [id, raw] of Object.entries(boxes)) {
            const b = raw as Box;
            if (typeof b?.draft !== "string" || !Array.isArray(b.messages)) continue;
            this.boxes[id] = { draft: b.draft, messages: b.messages.filter(m => typeof m.id === "string" && typeof m.text === "string" && ["sending", "queued", "accepted", "failed", "uncertain"].includes(m.state)).map(m => ({ ...m, state: m.state === "sending" ? "uncertain" : m.state })) };
          }
        } catch { this.view.notice = "本地缓存不可用，正在联网读取"; }
        this.connect(); await this.refresh();
        if (this.view.pairing.navigation) this.navigate(this.view.pairing.navigation);
      }
    } catch (e) { this.error(e); }
    this.changed();
  }
  navigate(path: string) {
    if (path === "/settings") this.screen("settings");
    else if (/^\/[a-zA-Z0-9_%.-]+$/.test(path)) {
      try { void this.open(decodeURIComponent(path.slice(1))); } catch { /* ignore invalid navigation */ }
    }
  }
  async pair(url: string, token: string) {
    await this.perform(async () => { this.view.pairing = await this.port.call("pair", { url, token }); this.generation++; this.connect(); await this.refresh(); });
  }
  async unpair() {
    if (this.view.busy) return;
    this.ws?.disconnect(); this.view.fresh = false;
    await this.perform(async () => {
      try { await this.call("unpair"); }
      finally {
        this.generation++; this.http.clear(); this.boxes = {}; this.pending.clear();
        this.view.detail = undefined; this.view.sessions = []; this.view.outbox = { draft: "", messages: [] };
        this.view.pairing = await this.port.call("bootstrap"); this.view.screen = "settings";
      }
    });
  }
  async request(path: string, method = "GET", body?: unknown): Promise<any> {
    const result = await this.call("request", { path, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (result.status === 401) { this.ws?.disconnect(); this.view.online = false; this.view.fresh = false; }
    let value: any; try { value = JSON.parse(result.body); } catch { throw new Error("后台响应格式不兼容"); }
    if (result.status < 200 || result.status >= 300) {
      if (result.status === 401) { this.ws?.disconnect(); this.view.online = false; this.view.fresh = false; }
      throw new ApiError(result.status, value?.error?.code ?? "HTTP_ERROR", value?.error?.message ?? `HTTP ${result.status}`);
    }
    return value;
  }
  private connect() {
    this.ws?.disconnect(); this.unlisten?.();
    this.ws = new WsClient(() => "native-host", () => {
      this.socket = new HostSocket(this.port, this.view.pairing!.scope);
      return this.socket;
    });
    this.ws.onStateChange = state => { this.view.ws = state; if (state === "closed") this.view.fresh = false; this.changed(); };
    this.ws.onSnapshotRequired = async id => { this.view.fresh = false; this.http.delete(id); const d = await this.load(id); this.display(id, d); return d; };
    this.ws.subscribeList(() => this.scheduleRefresh());
    this.ws.connect();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { if (this.active && this.view.pairing?.paired) { void this.refresh(); void this.recheck(); } }, 10_000);
  }
  socketEvent(e: { id: string; kind: string; data?: string }) {
    if (e.kind === "message") {
      try { if (!ServerMessage.safeParse(JSON.parse(e.data || "null")).success) throw new Error(); }
      catch { this.view.fresh = false; this.scheduleRefresh(); return; }
    }
    this.socket?.event(e);
  }
  lifecycle(active: boolean) {
    this.active = active;
    if (!active) { this.ws?.disconnect(); this.view.fresh = false; if (this.view.pairing?.paired) void this.saveBoxes().catch(() => {}); }
    else if (this.view.pairing?.paired) { this.ws?.connect(); void this.refresh(); void this.recheck(); }
    this.changed();
  }
  private scheduleRefresh() { if (!this.refreshTimer) this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; if (this.active) void this.refresh(); }, 350); }
  async refresh() {
    if (!this.view.pairing?.paired) return;
    try {
      if (this.view.screen === "session") {
        const id = this.view.sessionId; this.display(id, await this.load(id));
      } else {
        const agent = this.view.agent;
        const value = SessionListResponse.parse(await this.request("/api/v1/sessions" + (agent === "recent" ? "" : `?scope=all&agent=${agent}`)));
        if (agent === this.view.agent) this.view.sessions = value.sessions;
        this.view.status = StatusResponse.parse(await this.request("/api/v1/status"));
      }
      this.view.online = true;
    } catch (e) { this.view.online = false; this.view.fresh = false; this.error(e); }
    this.changed();
  }
  private display(id: string, detail: Detail) {
    if (this.view.sessionId !== id || this.view.screen !== "session") return;
    this.view.detail = mergeSessionDetail(this.view.detail, detail); this.view.fresh = true; this.view.online = true; this.changed();
  }
  async load(id: string, older = false): Promise<Detail> {
    const pending = this.pending.get(id);
    if (pending && !older) return pending;
    const gen = this.generation;
    const job = (async () => {
      if (pending) await pending.catch(() => {});
      const previous = this.http.get(id);
      const q = new URLSearchParams({ history: "window" });
      if (previous?.historyPage) { q.set("revision", previous.historyPage.revision); if (older && previous.historyPage.oldest) q.set("before", previous.historyPage.oldest); }
      const parse = decodeDetail;
      let d = mergeWindow(previous, parse(await this.request(`/api/v1/sessions/${encodeURIComponent(id)}?${q}`)));
      if (!d) d = mergeWindow(undefined, parse(await this.request(`/api/v1/sessions/${encodeURIComponent(id)}?history=window`)));
      if (!d || d.session.id !== id || gen !== this.generation) throw new Error("历史基准失效，请刷新");
      this.http.delete(id); this.http.set(id, d);
      while (this.http.size > 8) this.http.delete(this.http.keys().next().value!);
      const values = [...this.http.values()];
      while (values.length && JSON.stringify(values).length * 2 > 8 * 1024 * 1024) values.shift();
      void this.call("storage.set", { key: "history", value: JSON.stringify(values) }).catch(() => {});
      return d;
    })();
    this.pending.set(id, job);
    try { return await job; } finally { if (this.pending.get(id) === job) this.pending.delete(id); }
  }
  async open(id: string) {
    this.unlisten?.(); this.view.screen = "session"; this.view.sessionId = id; this.view.fresh = false;
    this.view.detail = undefined; this.view.notice = "";
    this.view.outbox = this.boxes[id] ??= { draft: "", messages: [] };
    const cached = this.http.get(id);
    if (cached) this.view.detail = { ...cached, historyPage: cached.historyPage ? { ...cached.historyPage, cached: true } : undefined,
      session: { ...cached.session, status: "unknown", controlMode: "observe", approvals: [] } };
    this.changed();
    this.unlisten = this.ws?.subscribe(id, e => this.event(e));
    await this.refresh();
    const s = this.view.detail?.session;
    if (this.view.sessionId === id && s?.agent === "codex" && (s.desktopManaged || s.activeElsewhere)) {
      try { await this.request(`/api/v1/sessions/${encodeURIComponent(id)}/observe`, "POST", { mode: "observe" }); await this.refresh(); }
      catch (e) { this.error(e); }
    }
    await this.recheck();
  }
  private event(e: SessionEvent) {
    if (e.sessionId !== this.view.sessionId) return;
    if (!this.view.fresh || e.type === "history.sync" || (this.view.detail?.serverEpoch && e.serverEpoch !== this.view.detail.serverEpoch)) { this.scheduleRefresh(); return; }
    this.view.detail = applySessionEvent(this.view.detail, e);
    if (e.type === "error") this.view.notice = e.message;
    this.changed();
  }
  home(agent = this.view.agent) { this.unlisten?.(); this.unlisten = undefined; this.view.screen = "home"; this.view.agent = agent; this.view.limit = 50; this.view.query = ""; this.changed(); void this.refresh(); }
  screen(screen: Screen) { this.unlisten?.(); this.view.screen = screen; this.changed(); if (screen === "settings") void this.notifications("status"); }
  filtered() {
    const q = this.view.query.toLowerCase();
    return this.view.sessions.filter(s => (this.view.agent !== "recent" || s.lastActivityAt >= Date.now() - 30 * 86400000) && `${s.title} ${s.cwd}`.toLowerCase().includes(q))
      .sort((a, b) => ({ waiting_approval: 0, running: 1, done: 2, error: 3, idle: 4, unknown: 5 }[a.status] - { waiting_approval: 0, running: 1, done: 2, error: 3, idle: 4, unknown: 5 }[b.status]) || b.lastActivityAt - a.lastActivityAt);
  }
  async older() { await this.perform(async () => { const id = this.view.sessionId; this.display(id, await this.load(id, true)); }); }
  setDraft(text: string) { this.view.outbox.draft = text; this.changed(); if (this.persistTimer) clearTimeout(this.persistTimer); this.persistTimer = setTimeout(() => { void this.saveBoxes().catch(e => this.error(e)); }, 250); }
  private saveBoxes() { return this.call("storage.set", { key: "outbox", value: JSON.stringify(this.boxes) }); }
  async send() {
    if (!canControl(this.view.detail, this.view.fresh) || !this.view.outbox.draft.trim()) return;
    const id = this.view.sessionId, box = this.view.outbox, text = box.draft.trim();
    await this.perform(async () => {
      const message: Outgoing = { id: await this.call("uuid"), text, state: "sending" };
      box.messages.push(message);
      try { await this.saveBoxes(); } catch (e) { message.state = "failed"; throw e; }
      box.draft = "";
      try {
        const result = await this.request(`/api/v1/sessions/${encodeURIComponent(id)}/message`, "POST", { text, clientMessageId: message.id });
        message.state = result.receipt ? MessageReceipt.parse(result.receipt).state : "accepted";
      } catch (e) {
        message.state = e instanceof ApiError && [400, 401, 403, 404, 409].includes(e.status) ? "failed" : "uncertain";
        this.error(e);
      }
      await this.saveBoxes(); await this.recheck(); await this.refresh();
    });
  }
  async recheck() {
    if (this.rechecking || !this.view.pairing?.paired) return;
    this.rechecking = true;
    try {
      for (const [session, box] of Object.entries(this.boxes)) for (const message of box.messages) {
        if (!["uncertain", "queued"].includes(message.state)) continue;
        try {
          const result = await this.request(`/api/v1/sessions/${encodeURIComponent(session)}/messages/${encodeURIComponent(message.id)}`);
          if (result.receipt) message.state = MessageReceipt.parse(result.receipt).state;
        } catch { /* Never resend on a receipt lookup failure. */ }
      }
      await this.saveBoxes();
    } catch { /* Offline: preserve local records. */ }
    finally { this.rechecking = false; this.changed(); }
  }
  async action(action: "resume" | "takeover" | "interrupt" | "fork" | "policy", body?: unknown) {
    const detail = this.view.detail;
    if (!this.view.fresh || !detail || detail.session.status === "unknown" || detail.historyPage?.cached) return;
    if (["resume", "takeover", "fork", "policy"].includes(action) && detail.session.agent !== "codex") return;
    if (["interrupt", "policy"].includes(action) && !canControl(detail, true)) return;
    if (action === "interrupt" && detail.session.agent === "claude" && !detail.session.terminal?.canInterrupt) return;
    const id = this.view.sessionId;
    await this.perform(async () => {
      try {
        const value = await this.request(`/api/v1/sessions/${encodeURIComponent(id)}` + (action === "policy" ? "" : `/${action}${action === "resume" ? "?history=window" : ""}`), action === "policy" ? "PATCH" : "POST", body);
        if (action === "fork") { await this.open(value.id); return; }
        if (action === "resume") {
          const d = mergeWindow(undefined, decodeDetail(value));
          if (d && this.view.sessionId === id) this.view.detail = mergeResumedDetail(this.view.detail, d);
        }
        this.view.notice = "操作已确认";
      } finally { await this.refresh(); }
    });
  }
  async approve(id: string, decision: string) {
    if (!canControl(this.view.detail, this.view.fresh)) return;
    const approval = this.view.detail?.session.approvals?.find(a => a.approvalId === id);
    if (!approval || !decisions(approval.availableDecisions).includes(decision)) return;
    await this.perform(async () => {
      try { await this.request(`/api/v1/sessions/${encodeURIComponent(this.view.sessionId)}/approvals/${encodeURIComponent(id)}`, "POST", { decision }); this.view.notice = "审批已确认"; }
      finally { await this.refresh(); }
    });
  }
  async browse(path = "") { await this.perform(async () => { this.view.fs = FsListResponse.parse(await this.request(`/api/v1/fs?path=${encodeURIComponent(path)}`)); }); }
  async create() {
    if (!this.view.project || !this.view.prompt.trim()) return;
    await this.perform(async () => {
      const result = await this.request("/api/v1/sessions", "POST", { projectPath: this.view.project, approvalPolicy: this.view.policy, prompt: this.view.prompt });
      this.view.prompt = ""; await this.open(result.id);
    });
  }
  async notifications(action: string) {
    await this.perform(async () => { if (action !== "status") await this.call(`notifications.${action}`); this.view.notifications = await this.call("notifications.status"); });
  }
  error(e: unknown) { this.view.notice = e instanceof Error ? e.message : "操作失败，请重试"; this.changed(); }
  async perform(action: () => Promise<void>) {
    if (this.view.busy) return;
    this.view.busy = true; this.view.notice = ""; this.changed();
    try { await action(); } catch (e) { this.error(e); }
    finally { this.view.busy = false; this.changed(); }
  }
  dispose() { this.disposed = true; this.ws?.disconnect(); if (this.timer) clearInterval(this.timer); if (this.refreshTimer) clearTimeout(this.refreshTimer); if (this.persistTimer) clearTimeout(this.persistTimer); }
}

let socketNumber = 0;
class HostSocket implements FakeableSocket {
  id = `socket-${++socketNumber}`;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(private port: Port, private scope: string) { void this.call("ws.open").catch(() => this.onclose?.()); }
  private call(op: string, data: Record<string, unknown> = {}) { return this.port.call(op, { scope: this.scope, id: this.id, ...data }); }
  send(data: string) { void this.call("ws.send", { data }).catch(() => this.onclose?.()); }
  close() { void this.call("ws.close").catch(() => {}); }
  event(e: { id: string; kind: string; data?: string }) { if (e.id !== this.id) return; if (e.kind === "open") this.onopen?.(); else if (e.kind === "close") this.onclose?.(); else if (e.kind === "message") this.onmessage?.({ data: e.data! }); }
}
