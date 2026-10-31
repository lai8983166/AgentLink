import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker } from './broker.mjs';

async function fixture(t, options = {}) {
  const b = await startBroker(options);
  t.after(() => b.close());
  const post = async (path, data) => {
    const r = await fetch(b.url + path, { method: 'POST', headers: { Authorization: 'Bearer ' + b.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'test', instanceId: 'original', ...data }) });
    return { status: r.status, body: await r.json() };
  };
  await post('/exchange', { status: 'idle', turnId: null, events: [{ seq: 1, type: 'session.connected', cwd: '/isolated-test' }] });
  return { b, post };
}

test('broker refuses missing credentials and browser-origin requests', async t => {
  const { b } = await fixture(t);
  assert.equal((await fetch(b.url + '/sessions')).status, 401);
  assert.equal((await fetch(b.url + '/sessions', { headers: { Authorization: 'Bearer ' + b.token, Origin: 'https://example.com' } })).status, 401);
});

test('lost exchange acknowledgement retries events and commands without duplicates', async t => {
  const { b, post } = await fixture(t);
  await post('/control', { id: 'one', kind: 'send', text: 'READY' });
  const exchange = { status: 'idle', events: [{ seq: 2, type: 'user.message', text: 'test' }] };
  assert.equal((await post('/exchange', exchange)).body.commands.length, 1);
  assert.equal((await post('/exchange', exchange)).body.commands.length, 1);
  assert.equal(b.sessions.get('test').events.length, 2);
  await post('/exchange', { status: 'running', turnId: 'turn-1', events: [{ seq: 3, type: 'command.queued', commandId: 'one' }] });
  assert.equal((await post('/exchange', { status: 'running', events: [] })).body.commands.length, 0);
  assert.equal((await post('/control', { id: 'one', kind: 'send', text: 'different' })).status, 409);
});

test('competing process and stale turn interrupt are rejected', async t => {
  const { post } = await fixture(t);
  assert.equal((await post('/exchange', { instanceId: 'competitor', events: [] })).status, 409);
  assert.equal((await post('/control', { kind: 'interrupt', turnId: 'old' })).status, 409);
});

test('approval accepts one decision and invalidates after native completion', async t => {
  const { b, post } = await fixture(t);
  const waiting = post('/approval/wait', { approvalId: 'a', tool: 'Bash', input: {} });
  while (!b.sessions.get('test').approvals.a) await new Promise(ok => setTimeout(ok, 5));
  assert.equal((await post('/approve', { approvalId: 'a', decision: 'allow' })).status, 200);
  assert.equal((await waiting).body.decision, 'allow');
  assert.equal((await post('/approve', { approvalId: 'a', decision: 'deny' })).status, 409);
  const second = post('/approval/wait', { approvalId: 'b', tool: 'Bash', input: {} });
  while (!b.sessions.get('test').approvals.b) await new Promise(ok => setTimeout(ok, 5));
  await post('/exchange', { status: 'idle', events: [{ seq: 2, type: 'approval.invalidate', approvalId: 'b' }] });
  assert.equal((await second).body.decision, null);
  assert.equal((await post('/approve', { approvalId: 'b', decision: 'allow' })).status, 409);
});

test('approval timeout returns to native flow', async t => {
  const { post } = await fixture(t, { approvalTimeoutMs: 30 });
  assert.equal((await post('/approval/wait', { approvalId: 'a' })).body.decision, null);
  assert.equal((await post('/approve', { approvalId: 'a', decision: 'allow' })).status, 409);
});

test('broker restart preserves instance, pending command and event deduplication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentlink-claude-broker-'));
  const path = join(dir, 'state.json');
  let b;
  try {
    b = await startBroker({ statePath: path });
    const post = data => fetch(b.url + '/exchange', { method: 'POST', headers: { Authorization: 'Bearer ' + b.token }, body: JSON.stringify(data) });
    const data = { sessionId: 's', instanceId: 'i', status: 'running', turnId: 't', events: [{ seq: 1, type: 'session.connected' }] };
    await post(data);
    b.sessions.get('s').commands.push({ id: 'pending', instanceId: 'i', kind: 'snapshot', state: 'pending' });
    const url = b.url, token = b.token;
    await b.close();
    b = await startBroker({ statePath: path });
    assert.equal(b.url, url);
    assert.equal(b.token, token);
    const reply = await (await post(data)).json();
    assert.equal(reply.commands.length, 1);
    assert.equal(b.sessions.get('s').events.length, 1);
  } finally { if (b) await b.close(); rmSync(dir, { recursive: true, force: true }); }
});
