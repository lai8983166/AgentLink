import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { PushDeviceStatus, PushSubscriptionInput, SessionStatus } from "@agentlink/shared";

export interface PushJob { id: string; deviceId: string; payload: string; attempts: number; expiresAt: number; endpoint: string; p256dh: string; auth: string }

/** 私钥、设备订阅及待发通知均留在本机数据库；重启不丢重试队列。 */
export class PushStore {
  private db: Database;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA foreign_keys=ON");
    this.db.run("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, lastAcceptedAt INTEGER, lastError TEXT)");
    this.db.run("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, active INTEGER NOT NULL, cycle INTEGER NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, deviceId TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, eventId TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL, nextAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, UNIQUE(deviceId,eventId))");
  }
  keys(create: () => { publicKey: string; privateKey: string }): { publicKey: string; privateKey: string } {
    const stored = this.db.query("SELECT value FROM settings WHERE key='vapid'").get() as { value: string } | null;
    if (stored) return JSON.parse(stored.value);
    const keys = create();
    this.db.run("INSERT INTO settings VALUES ('vapid',?)", [JSON.stringify(keys)]);
    return keys;
  }
  subscribe(s: PushSubscriptionInput): string {
    const old = this.db.query("SELECT id FROM devices WHERE endpoint=?").get(s.endpoint) as { id: string } | null;
    const id = old?.id ?? randomUUID();
    this.db.run("INSERT INTO devices (id,endpoint,p256dh,auth) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,lastError=NULL", [id, s.endpoint, s.keys.p256dh, s.keys.auth]);
    return id;
  }
  status(id: string): PushDeviceStatus | null {
    return this.db.query("SELECT id,lastAcceptedAt,lastError,(SELECT COUNT(*) FROM jobs WHERE deviceId=devices.id) AS pending FROM devices WHERE id=?").get(id) as PushDeviceStatus | null;
  }
  hasDevices(): boolean { return !!this.db.query("SELECT 1 FROM devices LIMIT 1").get(); }
  remove(id: string): void { this.db.run("DELETE FROM devices WHERE id=?", [id]); }
  revokeAll(): void { this.db.run("DELETE FROM devices"); }

  /** 首次打开已完成的历史不通知；仅观察到运行/审批中的轮次进入终态时入队。 */
  taskStatus(id: string, status: SessionStatus, payload: (eventId: string) => string, at: number): void {
    this.db.transaction(() => {
      const prev = this.db.query("SELECT active,cycle FROM tasks WHERE id=?").get(id) as { active: number; cycle: number } | null;
      if (status === "running" || status === "waiting_approval") {
        const cycle = (prev?.cycle ?? 0) + (prev?.active ? 0 : 1);
        this.db.run("INSERT INTO tasks VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET active=1,cycle=excluded.cycle", [id, cycle]);
      } else if (status === "done" || status === "error") {
        if (prev?.active) {
          const eventId = `${id}:${prev.cycle}`;
          this.enqueue(eventId, payload(eventId), at);
          this.db.run("UPDATE tasks SET active=0 WHERE id=?", [id]);
        }
      } else if (status === "idle") this.db.run("UPDATE tasks SET active=0 WHERE id=?", [id]);
      // unknown 仅表示失联；保留进行中标记，重连后可核对真实终态。
    })();
  }
  enqueue(eventId: string, payload: string, now: number, deviceId?: string): void {
    const devices = deviceId ? [{ id: deviceId }] : this.db.query("SELECT id FROM devices").all() as Array<{ id: string }>;
    for (const d of devices) this.db.run("INSERT OR IGNORE INTO jobs VALUES (?,?,?,?,0,?,?)", [randomUUID(), d.id, eventId, payload, now, now + 86400000]);
  }
  due(now: number): PushJob[] {
    this.db.run("UPDATE devices SET lastError='有通知已超过 24 小时有效期，不再重试，请重新测试通知' WHERE id IN (SELECT deviceId FROM jobs WHERE expiresAt<=?)", [now]);
    this.db.run("DELETE FROM jobs WHERE expiresAt<=?", [now]);
    return this.db.query("SELECT jobs.*,devices.endpoint,devices.p256dh,devices.auth FROM jobs JOIN devices ON devices.id=jobs.deviceId WHERE nextAt<=? ORDER BY nextAt LIMIT 20").all(now) as PushJob[];
  }
  accepted(job: PushJob, now: number): void {
    this.db.run("DELETE FROM jobs WHERE id=?", [job.id]);
    this.db.run("UPDATE devices SET lastAcceptedAt=?,lastError=NULL WHERE id=?", [now, job.deviceId]);
  }
  failed(job: PushJob, now: number): void {
    const delay = Math.min(600000, 2000 * 2 ** Math.min(job.attempts, 9));
    this.db.run("UPDATE jobs SET attempts=attempts+1,nextAt=? WHERE id=?", [now + delay, job.id]);
    this.db.run("UPDATE devices SET lastError='推送服务暂不可用，后台将重试' WHERE id=?", [job.deviceId]);
  }
  close(): void { this.db.close(); }
}
