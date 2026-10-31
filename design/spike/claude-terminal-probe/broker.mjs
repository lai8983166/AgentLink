import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Deliberately independent of the production daemon and its credentials.
export async function startBroker({ statePath, port = 0, approvalTimeoutMs = 15000 } = {}) {
  const saved = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  const token = saved?.token ?? randomBytes(32).toString('hex');
  const sessions = new Map(saved?.sessions?.map(s => [s.sessionId, s]) ?? []);
  const waiters = new Map();
  let lastSave = 0;
  let url;

  function save(force = true) {
    if (!statePath || (!force && Date.now() - lastSave < 1000)) return;
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    writeFileSync(statePath + '.tmp', JSON.stringify({ url, token, sessions: [...sessions.values()] }), { mode: 0o600 });
    renameSync(statePath + '.tmp', statePath);
    lastSave = Date.now();
  }
  function settle(approval, decision, state) {
    approval.state = state;
    const finish = waiters.get(approval.id);
    if (finish) finish(decision);
  }
  function auth(req) {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from('Bearer ' + token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  async function body(req) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 8 * 1024 * 1024) throw Object.assign(new Error('Body too large'), { status: 413 });
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }
  function current(data) {
    const s = sessions.get(data.sessionId);
    if (!s || s.instanceId !== data.instanceId) throw Object.assign(new Error('Session instance changed'), { status: 409 });
    return s;
  }
  function apply(s, e) {
    if (!Number.isSafeInteger(e.seq) || e.seq <= 0 || typeof e.type !== 'string') throw new Error('Invalid event');
    if (e.seq <= s.lastSeq) return;
    s.lastSeq = e.seq;
    s.events.push({ ...e, receivedAt: Date.now() });
    if (s.events.length > 5000) s.events.shift();
    if (e.type === 'session.connected') s.metadata = e;
    const c = s.commands.find(c => c.id === e.commandId);
    if (c && e.type === 'command.queued') c.state = 'queued';
    if (c && e.type === 'command.result') Object.assign(c, { state: e.state, reason: e.reason });
    if (c && e.type === 'snapshot') c.state = 'completed';
    if (e.type === 'approval.request') {
      s.approvals[e.approvalId] ??= { id: e.approvalId, tool: e.tool, input: e.input, state: 'pending' };
    }
    const a = s.approvals[e.approvalId];
    if (a && ['approval.closed', 'approval.invalidate'].includes(e.type) && a.state === 'pending') {
      settle(a, null, e.type === 'approval.invalidate' ? 'resolved_elsewhere' : 'expired');
    }
  }
  const server = http.createServer(async (req, res) => {
    function send(status, value) {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    }
    try {
      if (req.headers.origin || !auth(req)) return send(401, { error: 'Unauthorized' });
      if (req.method === 'GET' && req.url === '/sessions') {
        return send(200, { sessions: [...sessions.values()].map(s => ({ ...s, status: Date.now() - s.lastSeen > 5000 ? 'disconnected' : s.status })) });
      }
      if (req.method !== 'POST') return send(404, { error: 'Unknown route' });
      const data = await body(req);
      if (req.url === '/exchange') {
        if (typeof data.sessionId !== 'string' || typeof data.instanceId !== 'string' || !Array.isArray(data.events)) return send(400, { error: 'Invalid exchange' });
        let s = sessions.get(data.sessionId);
        if (s && s.instanceId !== data.instanceId) {
          // A still-live owner cannot be replaced by a late or competing client.
          if (Date.now() - s.lastSeen < 5000) return send(409, { error: 'Original session is still connected' });
          for (const a of Object.values(s.approvals)) if (a.state === 'pending') settle(a, null, 'expired');
          for (const c of s.commands) if (['pending', 'queued'].includes(c.state)) c.state = 'uncertain';
          s.instanceId = data.instanceId;
          s.lastSeq = 0;
        }
        if (!s) {
          s = { sessionId: data.sessionId, instanceId: data.instanceId, lastSeq: 0, events: [], commands: [], approvals: {} };
          sessions.set(data.sessionId, s);
        }
        for (const e of data.events) apply(s, e);
        s.status = data.status;
        s.turnId = data.turnId;
        s.lastSeen = Date.now();
        save(data.events.length > 0);
        return send(200, { commands: s.commands.filter(c => c.instanceId === s.instanceId && c.state === 'pending') });
      }
      const s = current(data);
      if (req.url === '/control') {
        if (Date.now() - s.lastSeen > 5000) return send(409, { error: 'Session disconnected' });
        if (!['send', 'interrupt', 'snapshot'].includes(data.kind)) return send(400, { error: 'Unsupported command' });
        if (data.kind === 'send' && (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 16000)) return send(400, { error: 'Invalid prompt' });
        if (data.kind === 'interrupt' && (!s.turnId || data.turnId !== s.turnId)) return send(409, { error: 'Turn changed' });
        const id = data.id ?? randomUUID();
        const previous = s.commands.find(c => c.id === id);
        if (previous) {
          if (previous.kind !== data.kind || previous.text !== data.text || previous.turnId !== data.turnId) return send(409, { error: 'Command ID reused with different content' });
          return send(200, previous);
        }
        const command = { id, instanceId: s.instanceId, kind: data.kind, text: data.text, turnId: data.turnId, state: 'pending' };
        s.commands.push(command);
        save();
        return send(202, command);
      }
      if (req.url === '/approval/wait') {
        const a = s.approvals[data.approvalId] ??= { id: data.approvalId, tool: data.tool, input: data.input, state: 'pending' };
        if (a.state !== 'pending') return send(200, { decision: a.state === 'submitted' ? a.decision : null });
        if (waiters.has(a.id)) return send(409, { error: 'Approval already waiting' });
        const decision = await new Promise(resolveDecision => {
          const finish = decision => {
            clearTimeout(timeout);
            waiters.delete(a.id);
            resolveDecision(decision);
          };
          const timeout = setTimeout(() => { a.state = 'expired'; finish(null); }, approvalTimeoutMs);
          waiters.set(a.id, finish);
          res.once('close', () => { if (waiters.get(a.id) === finish) { a.state = 'expired'; finish(null); } });
        });
        save();
        return send(200, { decision });
      }
      if (req.url === '/approve') {
        const a = s.approvals[data.approvalId];
        if (!a || a.state !== 'pending' || !waiters.has(a.id)) return send(409, { error: 'Approval no longer pending' });
        if (!['allow', 'deny'].includes(data.decision)) return send(400, { error: 'Unsupported decision' });
        a.decision = data.decision;
        settle(a, data.decision, 'submitted');
        save();
        return send(200, { state: 'submitted' });
      }
      return send(404, { error: 'Unknown route' });
    } catch (error) {
      send(error.status ?? 400, { error: error.message });
    }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port || (saved?.url ? Number(new URL(saved.url).port) : 0), '127.0.0.1', ok); });
  url = 'http://127.0.0.1:' + server.address().port;
  save();
  return { url, token, server, sessions, close: async () => {
    for (const finish of [...waiters.values()]) finish(null);
    save();
    server.closeAllConnections();
    await new Promise(ok => server.close(ok));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const statePath = process.argv[2];
  if (!statePath) throw new Error('Usage: node broker.mjs <private-state-file>');
  const broker = await startBroker({ statePath: resolve(statePath) });
  console.log('Local verification broker: ' + broker.url + '\nPrivate state: ' + resolve(statePath));
  const stop = async () => { await broker.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
