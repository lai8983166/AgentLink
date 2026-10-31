import { expect, mock, test } from 'claude-code/testing';

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
