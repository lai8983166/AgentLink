import { expect, mock, test } from 'claude-code/testing';

function connected(on, config = {}) {
  const clock = mock.clock(on);
  mock.env(on, { AGENTLINK_CLAUDE_PROBE_URL: 'http://127.0.0.1:12345', AGENTLINK_CLAUDE_PROBE_TOKEN: 'test-only', ...config });
  const batches = [];
  const queued = [];
  on('session.start', () => ({ cwd: '/test' }));
  on('session.id', () => ({ value: 'original-session' }));
  on('session.version', () => ({ value: { base: '2.1.314' } }));
  on('command.register', () => ({ value: { command: 'agentlink-probe' } }));
  on('http.fetch', ($, e) => {
    const body = JSON.parse(e.init.body);
    batches.push({ path: e.url, ...body });
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(e.url.endsWith('/approval/wait') ? { decision: 'allow' } : { commands: queued.splice(0) }) } };
  });
  return { clock, batches, queued };
}

test('without explicit opt-in the plugin does not connect', async ($, on) => {
  mock.env(on, {});
  on('session.start', () => ({ cwd: '/test' }));
  const result = await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/test' });
  expect(result.cwd).toBe('/test');
  const info = await $.command.run({ command: 'agentlink-probe', args: '' });
  expect(info.text).toBe('AgentLink probe: disabled');
});

test('a non-loopback endpoint is refused before sending credentials', async ($, on) => {
  mock.env(on, { AGENTLINK_CLAUDE_PROBE_URL: 'https://example.com', AGENTLINK_CLAUDE_PROBE_TOKEN: 'secret' });
  on('session.start', () => ({ cwd: '/test' }));
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/test' });
  const info = await $.command.run({ command: 'agentlink-probe', args: '' });
  expect(info.text).toBe('AgentLink probe: disabled');
});

test('streaming output and final result are forwarded unchanged', async ($, on) => {
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'READY' };
    return { turnId: 't', index: 0, answer: 'READY', toolUses: [], stopReason: 'end_turn', usage: null };
  });
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'test', messageCount: 1 });
  const first = await stream.next();
  expect(first.value.text).toBe('READY');
  const last = await stream.next();
  expect(last.done).toBe(true);
  expect(last.value.answer).toBe('READY');
});

test('a failed native tool still returns its original result', async ($, on) => {
  on('tool.call', () => ({ result: 'native result', isError: true }));
  const result = await $.tool.call({ tool: 'Bash', command: 'false' });
  expect(result.result).toBe('native result');
  expect(result.isError).toBe(true);
});

test('a repeated command is submitted once to the original session', async ($, on) => {
  const { clock, batches, queued } = connected(on);
  const prompts = [];
  on('prompt.submit', ($, e) => { prompts.push(e.text); return { text: e.text }; });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/test' });
  queued.push({ id: 'same', kind: 'send', text: 'READY' });
  await clock.advance(250);
  queued.push({ id: 'same', kind: 'send', text: 'READY' });
  await clock.advance(500);
  expect(prompts).toEqual(['READY']);
  expect(batches.every(b => b.sessionId === 'original-session')).toBe(true);
  expect(batches.flatMap(b => b.events ?? []).some(e => e.type === 'command.result' && e.state === 'started')).toBe(true);
});

test('a rejected submit is not reported as started or retried', async ($, on) => {
  const { clock, batches, queued } = connected(on);
  on('prompt.submit', () => ({ drop: 'the session was stopped and nobody has sent input since' }));
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/test' });
  queued.push({ id: 'stopped', kind: 'send', text: 'READY' });
  await clock.advance(750);
  const result = batches.flatMap(b => b.events ?? []).find(e => e.type === 'command.result');
  expect(result.state).toBe('rejected');
  expect(result.reason).toContain('stopped');
});

test('stale interrupt cannot stop a newer turn', async ($, on) => {
  const { clock, batches, queued } = connected(on);
  let aborted = 0;
  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('turn.abort', () => { aborted++; return {}; });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/test' });
  await $.turn.start({ turnId: 'new' });
  queued.push({ id: 'old-stop', kind: 'interrupt', turnId: 'old' });
  await clock.advance(500);
  expect(aborted).toBe(0);
  expect(batches.flatMap(b => b.events ?? []).some(e => e.type === 'command.result' && e.reason === 'Turn changed')).toBe(true);
});

test('remote permission decision uses the native PermissionRequest schema', async ($, on) => {
  const { clock, batches } = connected(on, { AGENTLINK_CLAUDE_PROBE_APPROVALS: '1' });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/test' });
  const result = await $.classic.PermissionRequest({ session_id: 'original-session', transcript_path: '/test/log', cwd: '/test', hook_event_name: 'PermissionRequest', permission_mode: 'manual', tool_name: 'Bash', tool_input: { command: 'echo READY' } });
  expect(result.hookSpecificOutput.decision.behavior).toBe('allow');
  await clock.advance(250);
  expect(batches.flatMap(b => b.events ?? []).some(e => e.type === 'approval.closed')).toBe(true);
});
