// Runs inside Claude Code's mod host: no Node imports or global timers.
// Loading this plugin alone does nothing. A test launcher supplies both variables.
let endpoint = null;
let token = null;
let identity = null;
let turnId = null;
let status = 'idle';
let sequence = 0;
let outbox = [];
let pumping = false;
let remoteApprovals = false;
const commands = new Set();
const pendingApprovals = new Map();

function emit(type, data) {
  if (!identity) return;
  outbox.push({ seq: ++sequence, type, ...data });
}

async function request($, path, body) {
  const response = await $.http.fetch(endpoint + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...identity, ...body }),
  });
  if (!response.ok) throw new Error('Probe HTTP ' + response.status);
  return JSON.parse(response.text);
}

async function finishCommand($, command, result) {
  emit('command.result', { commandId: command.id, ...result });
}

async function execute($, command) {
  // Never re-run a command after a lost acknowledgement in this process.
  if (commands.has(command.id)) return;
  commands.add(command.id);
  if (command.kind === 'send') {
    emit('command.queued', { commandId: command.id });
    // Do not await from the pump: submit waits for idle / start of the turn.
    $.prompt.submit({ text: command.text, asUser: true }).then(
      result => finishCommand($, command, result?.drop
        ? { state: 'rejected', reason: result.drop }
        : { state: 'started' }),
      error => finishCommand($, command, { state: 'rejected', reason: String(error) }),
    );
  } else if (command.kind === 'interrupt') {
    // A stale interrupt must never cancel the next turn.
    if (!turnId || command.turnId !== turnId) {
      emit('command.result', { commandId: command.id, state: 'rejected', reason: 'Turn changed' });
      return;
    }
    await $.turn.abort({ turnId });
    emit('command.result', { commandId: command.id, state: 'interrupted' });
  } else if (command.kind === 'snapshot') {
    const messages = await $.session.messages();
    emit('snapshot', { commandId: command.id, messages, status, turnId });
  }
}

async function pump($) {
  if (!identity || pumping) return;
  pumping = true;
  const batch = outbox;
  outbox = [];
  try {
    const reply = await request($, '/exchange', { events: batch, status, turnId });
    for (const command of reply.commands ?? []) await execute($, command);
  } catch {
    // Same sequence numbers let the receiver deduplicate an ambiguous retry.
    outbox = batch.concat(outbox);
    // This is a probe: stop accepting controls if the receiver lost events.
    if (outbox.length > 4096) {
      identity = null;
      outbox = [];
      $.ui.status('AgentLink probe disconnected: event buffer exceeded');
    }
  } finally {
    pumping = false;
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const url = await $.env.get('AGENTLINK_CLAUDE_PROBE_URL');
    const key = await $.env.get('AGENTLINK_CLAUDE_PROBE_TOKEN');
    // No remote host / path / query may receive the verification credential.
    if (!url || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(url) || !key) return next(e);
    endpoint = url;
    token = key;
    remoteApprovals = await $.env.get('AGENTLINK_CLAUDE_PROBE_APPROVALS') === '1';
    identity = {
      sessionId: await $.session.id(),
      instanceId: String(await $.clock.now()) + '-' + Math.random().toString(36).slice(2),
    };
    emit('session.connected', {
      cwd: e.cwd, surface: e.surface, isInteractive: e.isInteractive,
      version: await $.session.version(), remoteApprovals,
    });
    await $.command.register({ name: 'agentlink-probe', description: 'Show this test session connection', immediate: true });
    $.clock.every(250, async () => { await pump($); });
    await pump($);
    return next(e);
  });

  on('command.run', { command: 'agentlink-probe' }, async () => ({
    text: identity ? 'AgentLink probe: original session ' + identity.sessionId : 'AgentLink probe: disabled',
  }));

  on('prompt.submit', async ($, e, next) => {
    emit('user.message', { text: e.text, origin: e.origin });
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    turnId = e.turnId;
    status = 'running';
    emit('turn.started', { turnId });
    return next(e);
  });
  on('turn.step', async function* ($, e, next) {
    const stream = next(e);
    while (true) {
      const piece = await stream.next();
      if (piece.done) return piece.value;
      if (piece.value.kind === 'text') {
        emit('assistant.delta', { turnId: e.turnId, index: e.index, text: piece.value.text });
      }
      yield piece.value;
    }
  });
  on('turn.complete', async ($, e, next) => {
    emit('turn.completed', { turnId: e.turnId, answer: e.answer, isAborted: e.isAborted, agentId: e.agentId });
    if (!e.agentId && e.turnId === turnId) {
      turnId = null;
      status = 'idle';
    }
    return next(e);
  });

  on('classic.PermissionRequest', async ($, e, next) => {
    if (!identity) return next(e);
    const approvalId = identity.instanceId + ':' + (++sequence);
    pendingApprovals.set(approvalId, e.tool_name);
    status = 'waiting_approval';
    emit('approval.request', { approvalId, tool: e.tool_name, input: e.tool_input, permissionMode: e.permission_mode });
    if (!remoteApprovals) return next(e);
    try {
      // The broker bounds this wait. Failure leaves the native prompt available.
      const reply = await request($, '/approval/wait', {
        approvalId, tool: e.tool_name, input: e.tool_input,
      });
      if (reply.decision === 'allow' || reply.decision === 'deny') {
        emit('approval.remote_decision', { approvalId, decision: reply.decision });
        return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: {
          behavior: reply.decision,
          ...(reply.decision === 'deny' ? { message: 'Declined from AgentLink verification tool' } : {}),
        } } };
      }
      return next(e);
    } catch {
      return next(e);
    } finally {
      pendingApprovals.delete(approvalId);
      emit('approval.closed', { approvalId });
      status = turnId ? 'running' : 'idle';
    }
  });
  on('tool.call', async ($, e, next) => {
    emit('tool.started', { tool: e.tool, agentId: e.agentId });
    try { return await next(e); }
    finally {
      // Native approval may win while the HTTP hook is waiting.
      for (const [id, tool] of pendingApprovals) {
        if (tool === e.tool) emit('approval.invalidate', { approvalId: id });
      }
      emit('tool.finished', { tool: e.tool });
    }
  });
}
