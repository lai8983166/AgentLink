import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const statePath = process.argv[2];
if (!statePath) throw new Error('Usage: node verify-live.mjs <fixture-run/broker.json>');
const { url, token } = JSON.parse(readFileSync(statePath, 'utf8'));
const runDir = dirname(statePath);
const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
if (!run.fixtureUrl?.startsWith('http://127.0.0.1:') || !run.cwd.includes('claude-terminal-probe')) throw new Error('Only an isolated fixture run may be driven');
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const report = { cliPid: run.cliPid, sessionId: run.sessionId, checks: [] };
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
async function session() {
  const data = await (await fetch(url + '/sessions', { headers })).json();
  const s = data.sessions.find(s => s.sessionId === run.sessionId);
  assert(s, 'The exact fixture session must be registered');
  return s;
}
async function post(path, data) {
  const s = await session();
  const response = await fetch(url + path, { method: 'POST', headers, body: JSON.stringify({ sessionId: s.sessionId, instanceId: s.instanceId, ...data }) });
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}
async function until(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const s = await session(); const result = predicate(s); if (result) return result; await sleep(100); }
  throw new Error('Timed out waiting for fixture state');
}
async function send(text) { return post('/control', { id: randomUUID(), kind: 'send', text }); }
function record(name, data = {}) { report.checks.push({ name, ...data }); console.log(name + ': ' + JSON.stringify(data)); }
function save() { writeFileSync(join(runDir, 'verification.json'), JSON.stringify(report, null, 2)); }
try {
  const initial = await session();
  assert.equal(initial.metadata.surface, 'terminal');
  assert.equal(initial.metadata.isInteractive, true);
  process.kill(run.cliPid, 0);
  record('real-terminal', { pid: run.cliPid, sessionId: initial.sessionId });

  const baseline = initial.events.length;
  const first = await send('PROBE:READY');
  await until(s => s.commands.find(c => c.id === first.id && c.state === 'started'));
  await until(s => s.events.slice(baseline).find(e => e.type === 'turn.completed' && e.answer === 'READY'));
  const deltas = (await session()).events.slice(baseline).filter(e => e.type === 'assistant.delta');
  assert.equal(deltas.map(e => e.text).join(''), 'READY');
  assert(deltas.length > 1);
  record('remote-send-and-stream', { chunks: deltas.length });

  const approvalStart = Date.now();
  await send('PROBE:APPROVAL');
  const approval = await until(s => Object.values(s.approvals).find(a => a.state === 'pending'));
  await post('/approve', { approvalId: approval.id, decision: 'allow' });
  await until(s => s.events.find(e => e.type === 'turn.completed' && e.answer === 'APPROVAL_DONE' && e.receivedAt >= approvalStart), 20000);
  record('remote-native-tool-approval', { approvalId: approval.id });

  const queueStart = Date.now();
  await send('PROBE:LONG');
  await until(s => s.events.find(e => e.type === 'assistant.delta' && e.receivedAt >= queueStart));
  const second = await send('PROBE:SECOND');
  await until(s => s.commands.find(c => c.id === second.id && c.state === 'queued'));
  assert(!(await session()).commands.some(c => c.id === second.id && c.state === 'started'));
  if (process.argv.includes('--restart')) {
    const before = await session();
    const requestedAt = Date.now();
    writeFileSync(join(runDir, 'restart-broker.request'), 'restart fixture broker only\n');
    while (!existsSync(join(runDir, 'broker-restarted.json')) || JSON.parse(readFileSync(join(runDir, 'broker-restarted.json'), 'utf8')).at < requestedAt) {
      if (Date.now() - requestedAt > 10000) throw new Error('Fixture broker did not restart');
      await sleep(100);
    }
    await until(s => s.lastSeen >= JSON.parse(readFileSync(join(runDir, 'broker-restarted.json'), 'utf8')).at);
    assert.equal((await session()).instanceId, before.instanceId);
    assert.equal((await session()).turnId, before.turnId);
    assert.equal((await session()).status, 'running');
    process.kill(run.cliPid, 0);
    record('broker-restart-during-stream-original-process-survives');
  }
  await until(s => s.events.find(e => e.type === 'turn.completed' && e.answer === 'SECOND_READY' && e.receivedAt >= queueStart), 30000);
  const longText = (await session()).events.filter(e => e.type === 'assistant.delta' && e.receivedAt >= queueStart && e.text.startsWith('LONG_')).map(e => e.text).join('');
  assert.equal(longText, Array.from({ length: 100 }, (_, i) => 'LONG_' + i + ' ').join(''));
  record('busy-submit-waits-for-idle', { longChunks: 100 });

  const interruptStart = Date.now();
  await send('PROBE:LONG');
  await until(s => s.events.find(e => e.type === 'assistant.delta' && e.receivedAt >= interruptStart));
  const active = await session();
  const stop = await post('/control', { kind: 'interrupt', turnId: active.turnId });
  await until(s => s.commands.find(c => c.id === stop.id && c.state === 'interrupted'));
  assert.equal((await session()).turnId, null);
  assert.equal((await session()).status, 'idle');
  await sleep(300);
  const afterStop = await send('PROBE:READY');
  const outcome = await until(s => s.commands.find(c => c.id === afterStop.id && ['started', 'rejected'].includes(c.state)));
  record('interrupt-and-next-submit', { state: outcome.state, reason: outcome.reason ?? null });
  if (outcome.state === 'started') await until(s => s.status === 'idle');

  const snapshot = await post('/control', { kind: 'snapshot' });
  const state = await until(s => s.events.find(e => e.type === 'snapshot' && e.commandId === snapshot.id));
  assert(Array.isArray(state.messages));
  record('authoritative-history', { messages: state.messages.length });
  assert.equal((await session()).sessionId, initial.sessionId);
  process.kill(run.cliPid, 0);
  record('same-process-and-session-throughout');
  save();
} catch (error) {
  report.error = error.message;
  save();
  throw error;
}
