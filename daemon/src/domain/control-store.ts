import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MessageReceipt } from "@agentlink/shared";

/** 控制状态与指令回执落盘；恢复过程绝不自动重新执行未确认的指令。 */
export class ControlStore {
  private db: Database;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS deliveries (sessionId TEXT, messageId TEXT, text TEXT NOT NULL, state TEXT NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, PRIMARY KEY(sessionId,messageId))");
    this.db.run("CREATE TABLE IF NOT EXISTS controls (sessionId TEXT PRIMARY KEY, mode TEXT NOT NULL)");
    this.db.run("UPDATE deliveries SET state='uncertain', error='后台在收到执行回执前重启，请核对原会话', updatedAt=? WHERE state='sending'", [Date.now()]);
  }
  delivery(sessionId: string, messageId: string): (MessageReceipt & { text: string }) | null {
    const row = this.db.query("SELECT messageId AS clientMessageId,text,state,updatedAt,error FROM deliveries WHERE sessionId=? AND messageId=?").get(sessionId, messageId);
    return row as (MessageReceipt & { text: string }) | null;
  }
  saveDelivery(sessionId: string, text: string, receipt: MessageReceipt): void {
    this.db.run("INSERT INTO deliveries VALUES (?,?,?,?,?,?) ON CONFLICT(sessionId,messageId) DO UPDATE SET state=excluded.state, updatedAt=excluded.updatedAt, error=excluded.error", [sessionId, receipt.clientMessageId, text, receipt.state, receipt.updatedAt, receipt.error]);
  }
  setControl(sessionId: string, mode: "observe" | "takeover" | null): void {
    if (mode === null) this.db.run("DELETE FROM controls WHERE sessionId=?", [sessionId]);
    else this.db.run("INSERT INTO controls VALUES (?,?) ON CONFLICT(sessionId) DO UPDATE SET mode=excluded.mode", [sessionId, mode]);
  }
  controls(): Array<{ sessionId: string; mode: "observe" | "takeover" }> {
    return this.db.query("SELECT * FROM controls").all() as Array<{ sessionId: string; mode: "observe" | "takeover" }>;
  }
  close(): void { this.db.close(); }
}
