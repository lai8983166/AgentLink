// Run with Bun in a real terminal. Installs ONLY into an isolated Claude config.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createApp, websocket } from '../daemon/src/server.ts';
import { CodexBridge } from '../daemon/src/codex/bridge.ts';
import { FakeCodexServer } from '../daemon/src/testing/fake-codex.ts';
import { startClaudeTransport } from '../daemon/src/claude/transport.ts';
import { startFixtureApi } from '../design/spike/claude-terminal-probe/fixture-api.mjs';

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('A real terminal is required');
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(repo, 'design/spike/claude-terminal-probe/.local', 'integrated-' + Date.now());
const cwd = join(dir, 'workspace'), config = join(dir, 'config');
mkdirSync(cwd, { recursive: true }); mkdirSync(config, { recursive: true });
writeFileSync(join(cwd, 'README.md'), 'Isolated AgentLink integration fixture.\n');
writeFileSync(join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', numStartups: 1 }));
const token = 'isolated-claude-phone-fixture';
const fixtureApi = await startFixtureApi();
const sockets = new Set();
let current, bridgeServer;
async function build() {
  const bridge = new CodexBridge(new FakeCodexServer()); await bridge.start();
  current = createApp({ token, allowedRoots: [cwd], bridge, desktop: false, auditPath: join(dir, 'audit.db'),
    pushSender: async () => { throw new Error('External push forbidden in fixture'); } });
  await current.registry.start(); current.push.start();
  bridgeServer = startClaudeTransport(current.claude, join(dir, 'claude-bridge.json'));
}
async function dispose() {
  bridgeServer.stop(true); current.claude.close(); current.bridge.stop(); current.limitsRefresh.stop();
  await current.push.close(); current.controls.close(); current.audit.close();
}
await build();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req, server) => current.app.fetch(req, server), websocket: {
  ...websocket, open(ws) { sockets.add(ws); websocket.open?.(ws); },
  close(ws, code, reason) { sockets.delete(ws); websocket.close?.(ws, code, reason); },
} });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ANTHROPIC_|CLAUDE_|AGENTLINK_CLAUDE_|DISABLE_)/i.test(key)));
const binary = join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
Object.assign(env, { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'agentlink-fixture-dummy-key', ANTHROPIC_BASE_URL: fixtureApi.url,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
  AGENTLINK_CLAUDE_BRIDGE_FILE: join(dir, 'claude-bridge.json'), AGENTLINK_CLAUDE_BINARY: binary });
const install = spawnSync(process.execPath, [join(repo, 'plugins/install.mjs')], { cwd, env, stdio: 'inherit', windowsHide: true });
if (install.status !== 0) { await dispose(); server.stop(true); await fixtureApi.close(); process.exit(1); }
const sessionId = randomUUID();
const child = spawn(binary, ['--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'manual',
  '--session-id', sessionId, '--name', 'AgentLink isolated full integration', '--model', 'sonnet'], { cwd, env, stdio: 'inherit', windowsHide: true });
writeFileSync(join(dir, 'run.json'), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token, sessionId, cliPid: child.pid, cwd, fixtureUrl: fixtureApi.url }, null, 2));
console.log('INTEGRATION FIXTURE ONLY. No real account or model requests.\nRun metadata: ' + join(dir, 'run.json'));
let busy = false;
const timer = setInterval(async () => {
  if (busy || !existsSync(join(dir, 'restart.request'))) return;
  busy = true; unlinkSync(join(dir, 'restart.request'));
  try {
    await dispose(); await new Promise(r => setTimeout(r, 500)); await build();
    for (const socket of sockets) socket.close(1012, 'isolated fixture restart');
    writeFileSync(join(dir, 'restarted.json'), JSON.stringify({ at: Date.now() }));
  } finally { busy = false; }
}, 100);
const code = await new Promise((ok, fail) => { child.once('exit', ok); child.once('error', fail); });
clearInterval(timer); await dispose(); server.stop(true);
writeFileSync(join(dir, 'api-stats.json'), JSON.stringify(fixtureApi.stats, null, 2));
await fixtureApi.close(); process.exitCode = code ?? 1;
