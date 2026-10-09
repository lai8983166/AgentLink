// Read-only compatibility probe of a synthetic old thread, in an isolated CODEX_HOME.
// Usage: node design/spike/resume-permissions-probe.mjs <codex.exe>
// Never connects to desktop IPC or starts a model turn.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'al-resume-probe-'));
const threadId = randomUUID();
const turnId = randomUUID();
const at = new Date().toISOString();
const day = at.slice(0, 10).split('-');
const directory = join(root, 'sessions', ...day);
mkdirSync(directory, { recursive: true });
writeFileSync(join(root, 'config.toml'), 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n[projects.' + JSON.stringify(root) + ']\ntrust_level = "trusted"\n');
const records = [
  { type: 'session_meta', payload: { id: threadId, timestamp: at, cwd: root, originator: 'codex_vscode', cli_version: '0.160.0', source: 'vscode', model_provider: 'openai', base_instructions: { text: 'Isolated compatibility fixture. Do not execute tools.' } } },
  { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId, model_context_window: 272000 } },
  { type: 'turn_context', payload: { turn_id: turnId, cwd: root, approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' }, permission_profile: { type: 'disabled' }, model: 'gpt-5.4', summary: 'auto', effort: 'medium' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic history; no real model task.' }] } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic history; no real model task.', images: [], local_images: [], text_elements: [] } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'Synthetic response.' } },
];
writeFileSync(join(directory, `rollout-${at.replaceAll(':', '-')}-${threadId}.jsonl`), records.map((r) => JSON.stringify({ timestamp: at, ...r })).join('\n') + '\n');
const proc = spawn(process.argv[2], ['app-server'], { env: { ...process.env, CODEX_HOME: root }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let nextId = 0;
const pending = new Map();
let errors = '';
proc.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-2000); });
createInterface({ input: proc.stdout }).on('line', (line) => {
  const response = JSON.parse(line);
  const entry = pending.get(response.id);
  if (!entry) return;
  pending.delete(response.id); clearTimeout(entry.timer);
  response.error ? entry.reject(new Error(response.error.message)) : entry.resolve(response.result);
});
function call(method, params) {
  return new Promise((resolveCall, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
try {
  await call('initialize', { clientInfo: { name: 'agentlink_isolated_resume_probe', version: '0.1.0' } });
  proc.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const resumed = await call('thread/resume', { threadId, ...(process.argv[3] === 'explicit' ? { sandbox: 'danger-full-access' } : {}) });
  assert.equal(resumed.thread.id, threadId);
  assert.equal(resumed.approvalPolicy, 'never');
  assert.ok(resumed.thread.turns?.flatMap((t) => t.items ?? []).length > 0);
  if (process.argv[3] === 'explicit') assert.equal(resumed.sandbox.type, 'dangerFullAccess');
  console.log(JSON.stringify({ sameThread: resumed.thread.id === threadId, approvalPolicy: resumed.approvalPolicy, sandbox: resumed.sandbox, historyItems: resumed.thread.turns?.flatMap((t) => t.items ?? []).length }));
} catch (e) { console.error(e.message, errors); process.exitCode = 1; }
finally {
  if (process.platform === 'win32' && proc.exitCode === null) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else proc.kill();
  await new Promise((r) => { if (proc.exitCode !== null) r(); else proc.once('exit', r); });
  for (const entry of pending.values()) clearTimeout(entry.timer);
  if (resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith('al-resume-probe-')) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
