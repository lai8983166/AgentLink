import { historyItemKey, type HistoryWindowResponse, type SessionDetailResponse } from "@agentlink/shared";
import { IndexedHistoryCache, type HistoryCache } from "./history-cache";

/** HTTP 基准独立于 WS 展示缓存，防止增量应用到已被实时事件修改的错误基准上。 */
export class HistoryReader {
  private values = new Map<string, SessionDetailResponse>();
  private pending = new Map<string, Promise<SessionDetailResponse>>();
  private reads = new Map<string, Promise<SessionDetailResponse | undefined>>();
  private generation = 0;
  constructor(
    private fetch: (id: string, query: URLSearchParams) => Promise<HistoryWindowResponse>,
    private scope: () => string,
    private cache: HistoryCache = new IndexedHistoryCache(),
  ) {}
  private key(id: string) { return JSON.stringify([this.scope(), id]); }
  private async read(key: string, id: string) {
    if (this.values.has(key)) return this.values.get(key);
    if (!this.reads.has(key)) {
      const generation = this.generation;
      const read = this.cache.get(key).catch(() => undefined).then(value => {
        if (generation !== this.generation || key !== this.key(id)) return undefined;
        if (value?.session.id === id && value.historyPage && !this.values.has(key)) this.keep(key, value);
        return this.values.get(key);
      }).finally(() => this.reads.delete(key));
      this.reads.set(key, read);
    }
    return this.reads.get(key);
  }
  private keep(key: string, value: SessionDetailResponse) {
    this.values.delete(key); this.values.set(key, value);
    while (this.values.size > 8) this.values.delete(this.values.keys().next().value!);
  }
  async cached(id: string): Promise<SessionDetailResponse | undefined> {
    const value = await this.read(this.key(id), id);
    if (!value?.historyPage) return undefined;
    return { ...value, historyPage: { ...value.historyPage, cached: true }, session: {
      ...value.session, status: "unknown", controlMode: "observe", approvals: [], pendingApprovals: 0,
      ...(value.session.terminal ? { terminal: { ...value.session.terminal, connected: false, canInterrupt: false } } : {}),
    } };
  }
  load(id: string, older = false): Promise<SessionDetailResponse> {
    const key = this.key(id), generation = this.generation;
    const pending = this.pending.get(key);
    // 定时核对共享请求；向上翻页排在现有核对之后，基准保持串行。
    if (pending && !older) return pending;
    const job = (async () => {
      if (pending) await pending.catch(() => {});
      const previous = await this.read(key, id);
      if (generation !== this.generation || key !== this.key(id)) throw new Error("配对已变更");
      const query = new URLSearchParams({ history: "window" });
      if (previous?.historyPage) {
        query.set("revision", previous.historyPage.revision);
        if (older && previous.historyPage.oldest) query.set("before", previous.historyPage.oldest);
      }
      let wire = await this.fetch(id, query);
      if (generation !== this.generation || key !== this.key(id)) throw new Error("配对已变更");
      let result = this.merge(previous, wire);
      if (!result) {
        // 本地缓存损坏或丢失基准：只读回退最近一页，不重新执行任何操作。
        wire = await this.fetch(id, new URLSearchParams({ history: "window" }));
        result = this.merge(undefined, wire);
      }
      if (!result || result.session.id !== id) throw new Error("历史同步响应不完整，请重试");
      if (generation !== this.generation || key !== this.key(id)) throw new Error("配对已变更");
      this.keep(key, result);
      void this.cache.put(key, result).catch(() => {});
      return result;
    })();
    this.pending.set(key, job);
    void job.finally(() => { if (this.pending.get(key) === job) this.pending.delete(key); }).catch(() => {});
    return job;
  }
  private merge(previous: SessionDetailResponse | undefined, wire: HistoryWindowResponse): SessionDetailResponse | undefined {
    if (!wire.historySync) return wire; // 后台滚动升级时兼容旧协议。
    const { historySync, ...detail } = wire;
    if (!detail.historyPage || (historySync.mode === "patch" && (!previous || previous.historyPage?.revision !== historySync.baseRevision || previous.serverEpoch !== wire.serverEpoch))) return undefined;
    const items = new Map((historySync.mode === "patch" ? previous!.session.history : []).map(item => [historyItemKey(item), item]));
    for (const item of wire.session.history) items.set(historyItemKey(item), item);
    if (new Set(historySync.order).size !== historySync.order.length || historySync.order.some(key => !items.has(key))) return undefined;
    return { ...detail, session: { ...detail.session, history: historySync.order.map(key => items.get(key)!) } };
  }
  snapshot(wire: HistoryWindowResponse): SessionDetailResponse {
    const detail = this.merge(undefined, wire);
    if (!detail) throw new Error("会话快照不完整，请刷新核对");
    return detail;
  }
  clear() {
    this.generation++; this.values.clear(); this.reads.clear(); this.pending.clear();
    void this.cache.clear().catch(() => {});
  }
}
