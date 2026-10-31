import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startBroker } from './broker.mjs';
import { startFixtureApi } from './fixture-api.mjs';

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run this fixture in a real terminal (TTY)');
const root = dirname(fileURLToPath(import.meta.url));
const runDir = join(root, '.local', 'run-' + Date.now());
const cwd = join(runDir, 'workspace');
const config = join(runDir, 'config');
mkdirSync(cwd, { recursive: true });
mkdirSync(config, { recursive: true });
writeFileSync(join(cwd, 'README.md'), 'Isolated AgentLink terminal verification. No production project files.\n');
writeFileSync(join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', numStartups: 1 }));
let broker = await startBroker({ statePath: join(runDir, 'broker.json') });
let restarting = false;
const restartFlag = join(runDir, 'restart-broker.request');
const watcher = setInterval(async () => {
  if (restarting || !existsSync(restartFlag)) return;
  restarting = true;
  unlinkSync(restartFlag);
  try {
    await broker.close();
    await new Promise(ok => setTimeout(ok, 1000));
    broker = await startBroker({ statePath: join(runDir, 'broker.json') });
    writeFileSync(join(runDir, 'broker-restarted.json'), JSON.stringify({ at: Date.now() }));
  } finally { restarting = false; }
}, 100);
const fixture = await startFixtureApi();
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ANTHROPIC_|CLAUDE_|AGENTLINK_CLAUDE_|DISABLE_)/i.test(key)));
Object.assign(env, {
  CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_API_KEY: 'agentlink-fixture-dummy-key',
  ANTHROPIC_BASE_URL: fixture.url,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  AGENTLINK_CLAUDE_PROBE_URL: broker.url,
  AGENTLINK_CLAUDE_PROBE_TOKEN: broker.token,
  AGENTLINK_CLAUDE_PROBE_APPROVALS: '1',
});
const sessionId = randomUUID();
const cli = process.env.AGENTLINK_CLAUDE_BINARY || (process.platform === 'win32' ? join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe') : 'claude');
const args = ['--plugin-dir', join(root, 'plugin'), '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'manual', '--session-id', sessionId, '--name', 'AgentLink isolated terminal probe', '--model', 'sonnet'];
console.log('Fixture only. Model requests stay on loopback; credentials and user settings are isolated.');
console.log('Run directory: ' + runDir + '\nExpected original session: ' + sessionId);
const child = spawn(cli, args, { cwd, env, stdio: 'inherit', windowsHide: true });
writeFileSync(join(runDir, 'run.json'), JSON.stringify({ cliPid: child.pid, sessionId, cwd, brokerState: join(runDir, 'broker.json'), fixtureUrl: fixture.url }, null, 2));
writeFileSync(join(root, '.local', 'latest.json'), JSON.stringify({ runDir }, null, 2));
const code = await new Promise((ok, fail) => { child.once('exit', ok); child.once('error', fail); });
clearInterval(watcher);
writeFileSync(join(runDir, 'fixture-stats.json'), JSON.stringify(fixture.stats, null, 2));
await broker.close();
await fixture.close();
process.exitCode = typeof code === 'number' ? code : 1;
