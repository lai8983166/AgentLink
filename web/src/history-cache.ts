import { SessionDetailResponse } from "@agentlink/shared";
import type { SessionDetailResponse as Detail } from "@agentlink/shared";

export interface HistoryCache {
  get(key: string): Promise<Detail | undefined>;
  put(key: string, value: Detail): Promise<void>;
  clear(): Promise<void>;
}
const MAX_BYTES = 8 * 1024 * 1024;
/** 独立于草稿的有界 IndexedDB 缓存；键由服务器地址和配对身份的摘要隔离。 */
export class IndexedHistoryCache implements HistoryCache {
  private writes: Promise<void> = Promise.resolve();
  private mutate(operation: () => Promise<void>): Promise<void> {
    const result = this.writes.then(operation, operation);
    this.writes = result.catch(() => {});
    return result;
  }
  private async key(value: string) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
  }
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("agentlink-history-v1", 1);
      request.onupgradeneeded = () => { request.result.createObjectStore("sessions", { keyPath: "key" }); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("History cache blocked"));
    });
  }
  async get(key: string): Promise<Detail | undefined> {
    try {
      const digest = await this.key(key), db = await this.open();
      try {
        const row = await new Promise<{ value: unknown } | undefined>((resolve, reject) => {
          const tx = db.transaction("sessions"), request = tx.objectStore("sessions").get(digest);
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        const parsed = SessionDetailResponse.safeParse(row?.value);
        return parsed.success && parsed.data.historyPage ? parsed.data : undefined;
      } finally { db.close(); }
    } catch { return undefined; }
  }
  put(key: string, value: Detail): Promise<void> { return this.mutate(() => this.write(key, value)); }
  private async write(key: string, value: Detail): Promise<void> {
    const bytes = JSON.stringify(value).length * 2;
    // 大窗口只保留内存版本，不阻塞聊天或耗尽浏览器存储。
    if (bytes > 2 * 1024 * 1024 || !value.historyPage) return;
    try {
      const digest = await this.key(key), db = await this.open();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("sessions", "readwrite"), store = tx.objectStore("sessions");
          const request = store.getAll();
          request.onsuccess = () => {
            const rows = (request.result as Array<{ key: string; at: number; bytes: number }>).filter(r => r.key !== digest).sort((a, b) => b.at - a.at);
            let total = bytes;
            for (const [i, row] of rows.entries()) {
              total += row.bytes;
              if (i >= 7 || total > MAX_BYTES) store.delete(row.key);
            }
            store.put({ key: digest, at: Date.now(), bytes, value });
          };
          tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        });
      } finally { db.close(); }
    } catch { /* 缓存不可用仍正常联网同步。 */ }
  }
  clear(): Promise<void> { return this.mutate(() => this.erase()); }
  private async erase(): Promise<void> {
    try {
      const db = await this.open();
      try { await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("sessions", "readwrite"); tx.objectStore("sessions").clear();
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      }); } finally { db.close(); }
    } catch { /* 配对隔离同时由缓存键保证。 */ }
  }
}
