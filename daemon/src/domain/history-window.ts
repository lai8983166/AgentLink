import { createHash } from "node:crypto";
import { historyItemKey, type HistoryWindowResponse, type SessionDetailResponse } from "@agentlink/shared";

const PAGE_BYTES = 256 * 1024;
const MAX_MANIFEST_ITEMS = 50_000;
type Manifest = { id: string; epoch?: string; keys: string[]; hashes: Map<string, string> };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** 只保留有界的 ID/摘要清单，不复制聊天内容。失效版本安全回退最近一页。 */
export class HistoryWindows {
  private manifests = new Map<string, Manifest>();
  private itemCount = 0;
  window(detail: SessionDetailResponse, options: { revision?: string; before?: string; limit?: number } = {}): HistoryWindowResponse {
    const limit = Math.min(100, Math.max(1, options.limit ?? 60));
    const history = [...new Map(detail.session.history.map(item => [historyItemKey(item), item])).values()];
    const keys = history.map(historyItemKey);
    const candidate = options.revision ? this.manifests.get(options.revision) : undefined;
    let base = candidate?.id === detail.session.id && candidate.epoch === detail.serverEpoch ? candidate : undefined;
    // 先返回空历史、随后原终端首帧才到达时，也必须从最近一页开始。
    if (base && base.keys.length === 0 && history.length > 0) base = undefined;
    let start = base ? base.keys.length ? keys.indexOf(base.keys[0]!) : 0 : history.length;
    if (base && start < 0) base = undefined;
    const pageStart = (end: number) => {
      let begin = end, bytes = 0;
      while (begin > 0 && end - begin < limit) {
        const size = Buffer.byteLength(JSON.stringify(history[begin - 1]));
        if (begin < end && bytes + size > PAGE_BYTES) break;
        begin--; bytes += size;
      }
      return begin;
    };
    if (!base) start = pageStart(history.length);
    else if (options.before && options.before === base.keys[0]) start = pageStart(start);
    const items = history.slice(start);
    const order = items.map(historyItemKey);
    const hashes = new Map(items.map(item => [historyItemKey(item), hash(JSON.stringify(item))]));
    const revision = hash(JSON.stringify([detail.serverEpoch, detail.session.id, [...hashes]]));
    const previous = this.manifests.get(revision);
    if (previous) this.itemCount -= previous.keys.length;
    this.manifests.delete(revision);
    this.manifests.set(revision, { id: detail.session.id, epoch: detail.serverEpoch, keys: order, hashes });
    this.itemCount += order.length;
    while (this.manifests.size > 128 || this.itemCount > MAX_MANIFEST_ITEMS) {
      const oldest = this.manifests.keys().next().value!;
      this.itemCount -= this.manifests.get(oldest)!.keys.length;
      this.manifests.delete(oldest);
    }
    return {
      ...detail,
      session: { ...detail.session, history: base ? items.filter(item => base.hashes.get(historyItemKey(item)) !== hashes.get(historyItemKey(item))) : items },
      historyPage: { revision, hasMore: start > 0, total: history.length, oldest: order[0] ?? null },
      historySync: { mode: base ? "patch" : "replace", ...(base ? { baseRevision: options.revision } : {}), order },
    };
  }
}
