import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditEntry } from "@agentlink/shared";

/** 审计存储（任务 4.4）：bun:sqlite，append-only，分页倒序 */
export class AuditStore {
  private db: Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".agentlink", "audit.db");
    mkdirSync(join(path, ".."), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      sessionId TEXT NOT NULL,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      command TEXT,
      decision TEXT NOT NULL,
      source TEXT NOT NULL
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC)");
  }

  append(e: Omit<AuditEntry, "id">): void {
    this.db.run(
      "INSERT INTO audit (at, sessionId, project, kind, command, decision, source) VALUES (?,?,?,?,?,?,?)",
      [e.at, e.sessionId, e.project, e.kind, e.command, e.decision, e.source],
    );
  }

  /** 倒序分页；cursor 为上一页最后一条的 id */
  list(cursor: number | null, limit = 50): { entries: AuditEntry[]; nextCursor: number | null } {
    const lim = Math.min(Math.max(limit, 1), 200);
    const rows = cursor
      ? this.db.query("SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?").all(cursor, lim)
      : this.db.query("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(lim);
    const entries = (rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as number,
      at: r.at as number,
      sessionId: r.sessionId as string,
      project: r.project as string,
      kind: r.kind as AuditEntry["kind"],
      command: (r.command as string | null) ?? null,
      decision: r.decision as AuditEntry["decision"],
      source: r.source as string,
    }));
    return {
      entries,
      nextCursor: entries.length === lim ? (entries[entries.length - 1]?.id ?? null) : null,
    };
  }

  close(): void {
    this.db.close();
  }
}
