import { expect, mock, test } from 'claude-code/testing';

function host(on, url = 'http://127.0.0.1:12345', response) {
  const clock = mock.clock(on), packets = [], commands = [], submits = [];
  mock.env(on, { AGENTLINK_CLAUDE_BRIDGE_FILE: '/isolated/connection.json' });
  on('fs.read', () => ({ value: JSON.stringify({ protocol: 1, url, token: 'test-only-secret-32-characters-long' }) }));
  on('session.start', () => ({ cwd: '/isolated' }));
  on('session.id', () => ({ value: '12345678-1234-4234-8234-123456789abc' }));
  on('session.version', () => ({ value: { version: '2.1.314' } }));
  on('session.messages', () => ({ value: [] }));
  on('command.register', () => ({ value: { command: 'agentlink' } }));
  on('http.fetch', ($, e) => {
    const body = JSON.parse(e.init.body); packets.push({ path: e.url, ...body });
    if (response) return { value: response(body) };
    const value = e.url.endsWith('/approval/wait') ? { state: 'decided', decision: 'allow' }
      : { ack: body.events?.at(-1)?.seq ?? 0, commands: commands.splice(0) };
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(value) } };
  });
  return { clock, packets, commands, submits };
}
const START = { surface: 'terminal', isInteractive: true, cwd: '/isolated' };

test('SDK and headless processes never register as controllable terminals', async ($, on) => {
  on('session.start', () => ({ cwd: '/isolated' }));
  await $.session.start({ ...START, surface: null, isInteractive: false });
  const result = await $.command.run({ command: 'agentlink', args: '' });
  expect(result.text).toContain('仅支持交互式终端');
});
test('connection command requires a successful registration, shows whitelist denial and recovery', async ($, on) => {
  let rejected = true;
  host(on, 'http://127.0.0.1:12345', body => rejected
    ? { status: 409, ok: false, headers: {}, text: JSON.stringify({ error: { code: 'PATH_NOT_ALLOWED', message: 'not allowed' } }) }
    : { status: 200, ok: true, headers: {}, text: JSON.stringify({ ack: body.events?.at(-1)?.seq ?? 0, commands: [] }) });
  await $.session.start(START);
  const denied = await $.command.run({ command: 'agentlink', args: '' });
  expect(denied.text).toContain('PATH_NOT_ALLOWED'); expect(denied.text).toContain('allowedRoots');
  expect(denied.text).not.toContain('注册已确认');
  rejected = false;
  const connected = await $.command.run({ command: 'agentlink', args: '' });
  expect(connected.text).toContain('已连接本机后台 · 注册已确认');
});
test('missing registration acknowledgement is never reported as connected', async ($, on) => {
  host(on, 'http://127.0.0.1:12345', () => ({ status: 200, ok: true, headers: {}, text: '{}' }));
  await $.session.start(START);
  const result = await $.command.run({ command: 'agentlink', args: '' });
  expect(result.text).toContain('未返回注册确认'); expect(result.text).not.toContain('注册已确认');
});
test('connection file may only target numeric loopback, never a remote credential recipient', async ($, on) => {
  const { packets, clock } = host(on, 'https://example.com');
  await $.session.start(START); await clock.advance(500);
  expect(packets).toEqual([]);
});
test('pending send is submitted once and reports queued before started', async ($, on) => {
  const { commands, packets, clock, submits } = host(on);
  on('prompt.submit', ($, e) => { submits.push(e.text); return { text: e.text }; });
  await $.session.start(START);
  commands.push({ id: 'm1', kind: 'send', text: 'READY' }); await clock.advance(500);
  commands.push({ id: 'm1', kind: 'send', text: 'READY' }); await clock.advance(1000);
  expect(submits).toEqual(['READY']);
  const states = packets.flatMap(p => p.events ?? []).filter(e => e.type === 'command').map(e => e.data.state);
  expect(states).toEqual(['queued', 'started']);
});
test('native Esc blocks input, native composer submission clears the restriction', async ($, on) => {
  const { clock, packets } = host(on);
  on('turn.complete', () => ({ text: '' }));
  on('prompt.submit', ($, e) => ({ text: e.text }));
  await $.session.start(START);
  await $.turn.complete({ turnId: 't', answer: 'partial', durationMs: 1, isAborted: true, usage: null });
  await clock.advance(500);
  expect(packets.at(-1).inputBlocked).toBe(true);
  await $.prompt.submit({ text: 'continue', origin: { kind: 'composer' } });
  await clock.advance(500);
  expect(packets.at(-1).inputBlocked).toBe(false);
});
test('permission registration precedes wait, and mod response is flattened', async ($, on) => {
  const { packets } = host(on);
  on('tool.check', () => ({ decision: 'ask' }));
  await $.session.start(START);
  await $.tool.check({ tool: 'Bash', tool_use_id: 'tool1', input: { command: 'echo test' } });
  const result = await $.classic.PermissionRequest({ session_id: '12345678-1234-4234-8234-123456789abc', transcript_path: '/isolated/log', cwd: '/isolated', hook_event_name: 'PermissionRequest', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'echo test' } });
  expect(result.decision.behavior).toBe('allow');
  const wait = packets.findIndex(p => p.path.endsWith('/approval/wait'));
  expect(packets.slice(0, wait).flatMap(p => p.events ?? []).some(e => e.type === 'approval')).toBe(true);
});
test('stream chunks and final native result pass through unchanged', async ($, on) => {
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'READY' };
    return { turnId: 't', index: 0, answer: 'READY', toolUses: [], stopReason: 'end_turn', usage: null };
  });
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'test', messageCount: 1 });
  expect((await stream.next()).value.text).toBe('READY');
  expect((await stream.next()).value.answer).toBe('READY');
});
test('native API failure cannot be overwritten by a later turn.complete', async ($, on) => {
  const { packets, clock } = host(on);
  on('classic.StopFailure', () => ({}));
  on('turn.complete', () => ({ text: '' }));
  await $.session.start(START);
  await $.classic.StopFailure({ session_id: '12345678-1234-4234-8234-123456789abc', transcript_path: '/isolated/log', cwd: '/isolated', hook_event_name: 'StopFailure', error: 'unknown', error_details: 'Fixture API failure' });
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null });
  await clock.advance(500);
  expect(packets.at(-1).status).toBe('error');
  expect(packets.flatMap(p => p.events ?? []).find(e => e.type === 'completed').data.isError).toBe(true);
});
