// 阶段2：旧会话继承验证 —— thread/list 翻页 + thread/resume + 历史读取
import { spawn } from 'node:child_process';

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const proc = spawn('codex', ['app-server'], { shell: true });
proc.on('exit', () => process.exit(0));

let nextId = 1;
const pending = new Map();
let buf = '';
proc.stdout.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg); }
    } else if (msg.method && msg.id !== undefined) {
      log('↙ server request:', msg.method);
      sendRaw({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not handled' } });
    }
  }
});
function sendRaw(o) { proc.stdin.write(JSON.stringify(o) + '\n'); }
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve });
    sendRaw({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000).unref();
  });
}

async function main() {
  await call('initialize', { clientInfo: { name: 'agentlink-spike', title: 'AgentLink Spike', version: '0.0.1' } });

  // 1. thread/list 全量翻页
  let list = await call('thread/list', { cursor: null, limit: 100 });
  const items = list.result?.data ?? [];
  log('== thread/list 第一页:', items.length);
  items.slice(0, 8).forEach(t =>
    log('   ', t.id, '|', (t.preview || '').slice(0, 40), '|', JSON.stringify(t.environments?.[0]?.cwd || '')));
  log('   cursor?', JSON.stringify(list.result?.nextCursor ?? list.result?.cursor ?? null));

  // 2. 找一个旧会话（VS Code 来源，rollout 里的 id）
  const OLD_ID = '01a0b76e-241f-7210-a9b7-f2e847158616';
  const inList = items.find(t => t.id === OLD_ID);
  log('== 旧会话在列表里?', inList ? 'YES' : 'NO');

  // 3. 直接 resume 旧会话
  const resumed = await call('thread/resume', { threadId: OLD_ID });
  log('== resume result:', JSON.stringify(resumed.result ?? resumed.error).slice(0, 300));

  // 4. 读历史 turns，验证上下文完整
  if (!resumed.error) {
    const turns = await call('thread/turns/list', { threadId: OLD_ID, cursor: null, limit: 10 });
    const turnItems = turns.result?.data ?? turns.result?.items ?? turns.result ?? [];
    log('== turns/list:', Array.isArray(turnItems) ? turnItems.length + ' turns' : JSON.stringify(turns.result).slice(0, 200));
    if (Array.isArray(turnItems) && turnItems.length) {
      const t0 = turnItems[0];
      log('   first turn keys:', Object.keys(t0).join(','));
      const its = t0.items || [];
      log('   first turn items:', its.length);
      its.slice(0, 3).forEach(it => log('    -', it.type, JSON.stringify(it).slice(0, 140)));
    }
  }

  proc.kill(); process.exit(0);
}
main().catch(e => { log('[FATAL]', e.message); proc.kill(); process.exit(1); });
