// 阶段3：审批流真触发 —— untrusted 策略 + 命令执行 → requestApproval → accept
import { spawn } from 'node:child_process';

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const proc = spawn('codex', ['app-server'], { shell: true });
proc.on('exit', () => process.exit(0));

let nextId = 1;
const pending = new Map();
const serverRequests = [];
let threadId = null;

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
    } else if (msg.method) {
      if (msg.id !== undefined) {
        log('↙ SERVER REQUEST:', msg.method);
        serverRequests.push(msg);
      } else if (!/mcpServer/.test(msg.method)) {
        log('  evt:', msg.method, JSON.stringify(msg.params).slice(0, 150));
      }
    }
  }
});
function sendRaw(o) { proc.stdin.write(JSON.stringify(o) + '\n'); }
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve });
    sendRaw({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 40000).unref();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  await call('initialize', { clientInfo: { name: 'agentlink-spike', title: 'AgentLink Spike', version: '0.0.1' } });

  const start = await call('thread/start', {
    cwd: process.cwd() + '\\scratch',
    sandbox: 'workspace-write',
    approvalPolicy: 'untrusted',   // 每条命令都要审批
  });
  threadId = start.result?.thread?.id;
  log('== thread:', threadId);

  await call('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Run this exact shell command and tell me its output: node --version' }],
  });

  // 等审批请求到达
  log('== 等待审批请求 ...');
  let req = null;
  for (let k = 0; k < 60 && !req; k++) {
    req = serverRequests.find(r => /requestApproval/.test(r.method));
    await sleep(1000);
  }
  if (!req) { log('!! 没等到审批请求，收到的是:', serverRequests.map(r => r.method).join(', ') || '无'); proc.kill(); process.exit(1); }

  log('== 审批请求全文:');
  console.log(JSON.stringify(req.params, null, 1).slice(0, 1200));

  // 回复：acceptForSession（对应 UI 的"本会话不再询问"）
  sendRaw({ jsonrpc: '2.0', id: req.id, result: { decision: 'acceptForSession' } });
  log('== 已回复 acceptForSession，观察后续事件 ...');
  await sleep(20000);

  log('== 全部 server requests:', serverRequests.map(r => r.method).join(', '));
  proc.kill(); process.exit(0);
}
main().catch(e => { log('[FATAL]', e.message); proc.kill(); process.exit(1); });
