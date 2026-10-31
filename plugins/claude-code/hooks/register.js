// Claude Code mod host: all I/O uses official host methods, never Node APIs.
let identity = null;
let file = null;
let connection = null;
let turnId = null;
let status = 'unknown';
let permissionMode = null;
let inputBlocked = false;
let sequence = 0;
let outbox = [];
let pumping = false;
let acknowledged = 0;
const executed = new Set();
const remoteStops = new Set();
const activeTools = new Map();
const approvals = new Map();

function emit(type, data) {
  if (identity) outbox.push({ seq: ++sequence, type, data });
}
function fingerprint(value) {
  if (Array.isArray(value)) return '[' + value.map(fingerprint).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + fingerprint(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
async function loadConnection($) {
  try {
    const c = JSON.parse(await $.fs.read(file));
    if (c.protocol !== 1 || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(c.url) || typeof c.token !== 'string' || c.token.length < 32) return null;
    return c;
  } catch { return null; }
}
async function request($, path, body) {
  if (!connection) throw new Error('AgentLink background unavailable');
  const r = await $.http.fetch(connection.url + path, { method: 'POST',
    headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...identity, ...body }) });
  if (!r.ok) throw new Error('AgentLink bridge HTTP ' + r.status);
  return JSON.parse(r.text);
}
async function snapshot($) {
  try {
    const rows = await $.session.messages();
    const messages = rows.slice(-200).map(m => ({ role: m.role, text: m.text.slice(-20000),
      toolUses: (m.toolUses ?? []).map(t => ({ id: t.id ?? t.tool_use_id, name: t.name ?? t.tool, input: t.input,
        isError: t.isError, text: typeof t.text === 'string' ? t.text.slice(-8000) : '' })) }));
    // Bounded repair snapshots; never replace a missing event with a new task.
    while (JSON.stringify(messages).length > 1000000 && messages.length) messages.shift();
    emit('snapshot', { messages });
  } catch { /* The next idle snapshot repairs a temporarily unavailable read. */ }
}
function commandResult(command, state, reason) { emit('command', { commandId: command.id, state, ...(reason ? { reason } : {}) }); }
async function execute($, command) {
  if (executed.has(command.id)) return;
  executed.add(command.id);
  try {
    if (command.kind === 'send') {
      commandResult(command, 'queued');
      $.prompt.submit({ text: command.text, asUser: true }).then(result => {
        if (result?.drop) {
          if (result.drop.includes('stopped and nobody')) inputBlocked = true;
          commandResult(command, 'rejected', result.drop);
        } else commandResult(command, 'started');
      }, error => commandResult(command, 'rejected', String(error)));
    } else if (command.kind === 'interrupt') {
      if (!turnId || command.turnId !== turnId) { commandResult(command, 'rejected', '当前轮次已改变，请刷新核对'); return; }
      const stopped = turnId;
      remoteStops.add(stopped);
      await $.turn.abort({ turnId: stopped });
      if (turnId === stopped) { turnId = null; status = 'idle'; }
      emit('interrupted', { turnId: stopped });
      commandResult(command, 'interrupted');
      await snapshot($);
    }
  } catch (error) { commandResult(command, 'rejected', String(error)); }
}
async function pump($) {
  if (!identity || pumping) return;
  pumping = true;
  const batch = outbox.splice(0, 256);
  try {
    if (!connection) connection = await loadConnection($);
    const reply = await request($, '/exchange', { status, turnId, inputBlocked, permissionMode, events: batch });
    acknowledged = Math.max(acknowledged, reply.ack ?? 0);
    for (const command of reply.commands ?? []) await execute($, command);
  } catch {
    outbox = batch.concat(outbox);
    // daemon may have restarted on a new random loopback port.
    connection = await loadConnection($);
    if (outbox.length > 4096) { outbox = []; emit('gap', {}); await snapshot($); }
  } finally { pumping = false; }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    if (!e.isInteractive || e.surface !== 'terminal') return next(e);
    file = await $.env.get('AGENTLINK_CLAUDE_BRIDGE_FILE');
    if (!file) {
      const home = await $.env.get('USERPROFILE') || await $.env.get('HOME');
      if (!home) return next(e);
      file = home.replace(/\\/g, '/') + '/.agentlink/claude-bridge.json';
    }
    const version = await $.session.version();
    identity = { protocol: 1, sessionId: await $.session.id(),
      instanceId: String(await $.clock.now()) + '-' + Math.random().toString(36).slice(2),
      cwd: e.cwd, version: version.version ?? version.base ?? 'unknown' };
    connection = await loadConnection($);
    emit('connected', {});
    await snapshot($);
    await $.command.register({ name: 'agentlink', description: 'Show AgentLink original-session connection', immediate: true });
    $.clock.every(500, async () => { await pump($); });
    $.clock.every(30000, async () => { if (!turnId) await snapshot($); });
    await pump($);
    return next(e);
  });
  on('command.run', { command: 'agentlink' }, async () => ({ text: identity
    ? 'AgentLink · 原终端会话 ' + identity.sessionId + (connection ? ' · 已配置本机后台' : ' · 等待本机后台启动')
    : 'AgentLink · 仅支持交互式终端' }));
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e);
    if (!result.drop) {
      if (e.origin?.kind === 'composer' || !e.origin) inputBlocked = false;
      emit('user', { text: result.text ?? e.text });
    }
    return result;
  });
  on('classic.UserPromptSubmit', async ($, e, next) => {
    permissionMode = e.permission_mode ?? permissionMode;
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) { turnId = e.turnId; status = 'running'; emit('started', { turnId }); }
    return next(e);
  });
  on('turn.step', async function* ($, e, next) {
    const stream = next(e);
    while (true) {
      const part = await stream.next();
      if (part.done) return part.value;
      if (part.value.kind === 'text' && !e.agentId) emit('text', { itemId: e.turnId + ':' + e.index, text: part.value.text });
      yield part.value;
    }
  });
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      inputBlocked = !!e.isAborted && !remoteStops.has(e.turnId);
      remoteStops.delete(e.turnId);
      turnId = null; status = e.isAborted ? 'idle' : 'done';
      emit('completed', { turnId: e.turnId, answer: e.answer, isAborted: e.isAborted });
    }
    const result = await next(e);
    if (!e.agentId) await snapshot($);
    return result;
  });
  on('classic.StopFailure', async ($, e, next) => {
    status = 'error'; turnId = null;
    emit('failed', { message: String(e.error ?? e.message ?? 'Claude 本轮出错') });
    return next(e);
  });
  on('tool.check', async ($, e, next) => {
    if (e.tool_use_id) activeTools.set(e.tool_use_id, { name: e.tool, input: e.input, key: fingerprint(e.input) });
    return next(e);
  });
  on('classic.PermissionRequest', async ($, e, next) => {
    if (!identity || !connection) return next(e);
    permissionMode = e.permission_mode ?? permissionMode;
    const matches = [...activeTools].filter(([, t]) => t.name === e.tool_name && t.key === fingerprint(e.tool_input));
    // Ambiguous concurrent identical tools keep their native permission dialog.
    if (matches.length !== 1) return next(e);
    const approvalId = identity.instanceId + ':approval:' + (++sequence);
    approvals.set(approvalId, matches[0][0]); status = 'waiting_approval';
    emit('approval', { approvalId, name: e.tool_name, input: e.tool_input });
    const requestSequence = sequence;
    // Register the request before opening the decision long poll.
    await pump($);
    try {
      // A timer may already be exchanging. Wait for registration acknowledgement
      // before asking for a decision; otherwise the server cannot identify it.
      for (let attempt = 0; acknowledged < requestSequence && attempt < 20; attempt++) {
        await $.clock.sleep(50);
        await pump($);
      }
      if (acknowledged < requestSequence) return next(e);
      while (!next.signal.aborted && approvals.has(approvalId)) {
        const reply = await request($, '/approval/wait', { approvalId });
        if (reply.decision === 'allow' || reply.decision === 'deny') return { decision: {
          behavior: reply.decision,
          ...(reply.decision === 'deny' ? { message: '用户在 AgentLink 拒绝了此操作' } : {}),
        } };
        if (reply.state !== 'pending') break;
      }
      return next(e);
    } catch { return next(e); }
    finally {
      approvals.delete(approvalId); emit('approvalEnd', { approvalId });
      if (status === 'waiting_approval' && !approvals.size) status = turnId ? 'running' : 'unknown';
    }
  });
  on('tool.call', async ($, e, next) => {
    const name = e.tool, itemId = e.tool_use_id;
    const { tool, tool_use_id, agentId, ...input } = e;
    emit('tool', { itemId, name, input });
    try {
      const result = await next(e);
      emit('toolEnd', { itemId, isError: !!result.isError || !!result.deny,
        output: typeof result.result === 'string' ? result.result.slice(-8000) : result.deny ?? '' });
      return result;
    } finally {
      activeTools.delete(itemId);
      for (const [approvalId, toolId] of approvals) if (toolId === itemId) {
        approvals.delete(approvalId); emit('approvalEnd', { approvalId });
      }
    }
  });
}
