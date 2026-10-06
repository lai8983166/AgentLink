// 双通道活性探测：协议订阅(thread/read) vs rollout 文件直读
// 用法: bun live-probe.mjs <秒数>
import { spawn } from "node:child_process";


const BUSY = "01a0f832-bf3c-7470-9974-b707b159226c";
const ROLLOUT = `${process.env.USERPROFILE}/.codex/sessions/2026/10/02/rollout-2026-10-02T00-01-12-${BUSY}.jsonl`;
const DURATION = Number(process.argv[2] ?? 90) * 1000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// 通道 1：协议订阅
const proc = spawn("cmd", ["/c", "codex", "app-server"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let nextId = 1;
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!l) continue;
    try {
      const m = JSON.parse(l);
      if (m.id !== undefined && (m.result !== undefined || m.error)) {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); p(m); }
      } else if (m.method && !/account|remoteControl/.test(m.method)) {
        log("[协议通道] ↙", m.method, JSON.stringify(m.params ?? {}).slice(0, 120));
      }
    } catch {}
  }
});
const call = (method, params) =>
  new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

// 通道 2：rollout 文件监视
let prevSize = 0;
try {
  const { statSync } = await import("node:fs");
  prevSize = statSync(ROLLOUT).size;
} catch { log("[文件通道] rollout 文件找不到:", ROLLOUT); }

await call("initialize", { clientInfo: { name: "probe", title: "probe", version: "0" } });
const r = await call("thread/read", { threadId: BUSY });
log("thread/read:", r.error ? `失败 ${r.error.message.slice(0, 50)}` : "成功（已只读加载）");

// 文件通道：轮询 size（Windows 上比 watch 事件更稳）
const { statSync } = await import("node:fs");
const fileTimer = setInterval(() => {
  try {
    const s = statSync(ROLLOUT).size;
    if (s !== prevSize) {
      log(`[文件通道] rollout 增长 +${s - prevSize} 字节`);
      prevSize = s;
    }
  } catch {}
}, 500);

setTimeout(() => {
  clearInterval(fileTimer);
  proc.kill();
  log("探测结束");
  process.exit(0);
}, DURATION);
log(`双通道监听中（${DURATION / 1000}s）… 请在桌面端发消息`);
