// Claude Code mod host: all I/O uses official host methods, never Node APIs.
let identity = null;
let file = null;
let connection = null;
let turnId = null;
let status = 'unknown';
let permissionMode = null;
let inputBlocked = false;
let failedTurn = false;
let sequence = 0;
let outbox = [];
let pumping = false;
let acknowledged = 0;
let lastExchangeAt = null;
let connectionError = null;
const executed = new Set();
const remoteStops = new Set();
const activeTools = new Map();
const approvals = new Map();
const nativeInteractions = new Set();

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
  let value;
  try { value = JSON.parse(r.text); } catch { value = null; }
  if (!r.ok) {
    const code = value?.error?.code;
    if (code === 'PATH_NOT_ALLOWED') throw new Error('PATH_NOT_ALLOWED · 当前项目未加入后台 allowedRoots 白名单：' + identity.cwd + '；请添加该项目目录并重载 AgentLink 后台');
    throw new Error('AgentLink bridge HTTP ' + r.status + (code ? ' · ' + code : ''));
  }
  if (!value) throw new Error('AgentLink 后台响应无效');
  return value;
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
    const reply = await request($, '/exchange', { status, turnId, inputBlocked, permissionMode, events: batch,
      nativeInteraction: nativeInteractions.size ? 'Claude 正在等待提问或计划确认，请在电脑终端处理' : null });
    if (typeof reply.ack !== 'number') throw new Error('AgentLink 后台未返回注册确认');
    lastExchangeAt = await $.clock.now(); connectionError = null;
    acknowledged = Math.max(acknowledged, reply.ack ?? 0);
    for (const command of reply.commands ?? []) await execute($, command);
  } catch (error) {
    connectionError = String(error?.message ?? error);
    if (connection?.token) connectionError = connectionError.split(connection.token).join('[已隐藏]');
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
  on('command.run', { command: 'agentlink' }, async ($) => {
    if (!identity) return { text: 'AgentLink · 仅支持交互式终端' };
    await pump($);
    const now = await $.clock.now();
    const state = connectionError ? '未连接 · ' + connectionError : lastExchangeAt !== null && now - lastExchangeAt < 6000
      ? '已连接本机后台 · 注册已确认' : '正在核对本机后台连接';
    return { text: 'AgentLink · 原终端会话 ' + identity.sessionId + ' · 项目 ' + identity.cwd + ' · ' + state };
  });
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
    if (!e.agentId) { turnId = e.turnId; failedTurn = false; status = 'running'; emit('started', { turnId }); }
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
      turnId = null; status = failedTurn ? 'error' : e.isAborted ? 'idle' : 'done';
      emit('completed', { turnId: e.turnId, answer: e.answer, isAborted: e.isAborted, isError: failedTurn });
    }
    const result = await next(e);
    if (!e.agentId) await snapshot($);
    return result;
  });
  on('classic.StopFailure', async ($, e, next) => {
    failedTurn = true; status = 'error'; turnId = null;
    emit('failed', { message: String(e.error_details ?? e.error ?? 'Claude 本轮出错') });
    return next(e);
  });
  on('tool.check', async ($, e, next) => {
    if (e.tool_use_id) activeTools.set(e.tool_use_id, { name: e.tool, input: e.input, key: fingerprint(e.input) });
    return next(e);
  });
  on('classic.PermissionRequest', async ($, e, next) => {
    if (!identity || !connection) return next(e);
    if (/^(AskUserQuestion|ExitPlanMode|EnterPlanMode)$/.test(e.tool_name)) return next(e);
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
      let failures = 0;
      while (!next.signal.aborted && approvals.has(approvalId)) {
        let reply;
        try {
          reply = await request($, '/approval/wait', { approvalId });
          failures = 0;
        } catch (error) {
          // A local daemon restart does not end the native permission request.
          // Bound sleeps to the mod host budget, then retain the native dialog.
          if (++failures > 15) throw error;
          connection = await loadConnection($);
          await $.clock.sleep(100);
          continue;
        }
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
    if (/^(AskUserQuestion|ExitPlanMode|EnterPlanMode)$/.test(name)) nativeInteractions.add(itemId);
    const { tool, tool_use_id, agentId, ...input } = e;
    emit('tool', { itemId, name, input });
    try {
      const result = await next(e);
      emit('toolEnd', { itemId, isError: !!result.isError || !!result.deny,
        output: typeof result.result === 'string' ? result.result.slice(-8000) : result.deny ?? '' });
      return result;
    } finally {
      activeTools.delete(itemId);
      nativeInteractions.delete(itemId);
      for (const [approvalId, toolId] of approvals) if (toolId === itemId) {
        approvals.delete(approvalId); emit('approvalEnd', { approvalId });
      }
    }
  });
}
