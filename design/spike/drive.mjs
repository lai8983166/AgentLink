// codex app-server 摸底驱动：stdio JSON-RPC
// 用法: node drive.mjs
import { spawn } from 'node:child_process';

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const proc = spawn('codex', ['app-server'], { shell: true });
proc.on('exit', (c, s) => { log('[proc exit]', c, s); process.exit(0); });

let nextId = 1;
const pending = new Map();      // id -> {resolve, method}
const notifications = [];       // 全部通知留档

let buf = '';
proc.stdout.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { log('[non-json line]', line.slice(0, 120)); continue; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg); log('← result', p.method, JSON.stringify(msg.result ?? msg.error).slice(0, 200)); }
      else log('← result?', msg.id, JSON.stringify(msg).slice(0, 120));
    } else if (msg.method) {
      // server -> client：通知 或 请求（请求需要回包）
      log('↙ notify/req:', msg.method, JSON.stringify(msg.params).slice(0, 220));
      notifications.push(msg);
      if (msg.id !== undefined) {
        // 默认先不回应审批类请求，由主流程决定；这里对未知请求一律回 capabilities 不支持
        sendRaw({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'driver: not handled in auto mode' } });
      }
    } else log('← other', JSON.stringify(msg).slice(0, 120));
  }
});
proc.stderr.on('data', d => log('[stderr]', d.toString().trim().slice(0, 200)));

function sendRaw(obj) { const s = JSON.stringify(obj); proc.stdin.write(s + '\n'); }
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, method });
    log('→ call', method);
    sendRaw({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)); } }, 30000).unref();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const phase = process.argv[2] || 'all';

  // 1. initialize
  const init = await call('initialize', {
    clientInfo: { name: 'agentlink-spike', title: 'AgentLink Spike', version: '0.0.1' },
  });
  log('== initialize ok:', JSON.stringify(init.result).slice(0, 300));

  if (phase === 'list') { await doList(); return; }

  // 2. thread/start（scratch 目录，只读沙箱）
  const scratch = process.cwd() + '\\scratch';
  const start = await call('thread/start', { cwd: scratch, sandbox: 'read-only' });
  const threadId = start.result?.thread?.id || start.result?.threadId || start.result?.id;
  log('== threadId:', threadId, JSON.stringify(start.result).slice(0, 200));

  // 3. turn/start：最小配额探测
  await call('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Reply with exactly: PONG' }],
  });

  // 4. 收 25 秒事件流
  log('== collecting events for 25s ...');
  await sleep(25000);

  // 5. thread/list
  await doList();

  // 6. 收尾
  await sleep(2000);
  log('== total notifications:', notifications.length);
  const counts = {};
  notifications.forEach(n => counts[n.method] = (counts[n.method] || 0) + 1);
  log('== event histogram:', JSON.stringify(counts, null, 1));
  proc.kill();
  process.exit(0);
}

async function doList() {
  const list = await call('thread/list', {});
  const items = list.result?.items || list.result?.threads || list.result || [];
  if (Array.isArray(items)) {
    log('== thread/list count:', items.length);
    items.slice(0, 5).forEach(t => log('   ', JSON.stringify(t).slice(0, 180)));
  } else log('== thread/list raw:', JSON.stringify(list.result).slice(0, 500));
}

main().catch(e => { log('[FATAL]', e.message); proc.kill(); process.exit(1); });
