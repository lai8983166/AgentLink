// Drives only a run.json created by claude-live-fixture.mjs, never user sessions.
import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const file = process.argv[2], dir = dirname(file);
const run = JSON.parse(readFileSync(file, 'utf8'));
assert(run.cwd.includes('claude-terminal-probe') && run.token === 'isolated-claude-phone-fixture' && run.fixtureUrl.startsWith('http://127.0.0.1:'), 'Fixture metadata required');
const id = 'claude:' + run.sessionId, headers = { Authorization: 'Bearer ' + run.token, 'Content-Type': 'application/json' };
const report = { sessionId: run.sessionId, cliPid: run.cliPid, checks: [] };
const record = name => { report.checks.push(name); console.log(name); };
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
async function api(path, body) {
  const r = await fetch(run.url + path, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const data = await r.json(); if (!r.ok) throw new Error(JSON.stringify(data)); return data;
}
const detail = () => api('/api/v1/sessions/' + id);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
await context.addInitScript(token => localStorage.setItem('agentlink-token', token), run.token);
let page = await context.newPage();
try {
  await page.goto(run.url + '/' + id);
  await expect(page.getByRole('textbox')).toBeEnabled({ timeout: 15000 });
  process.kill(run.cliPid, 0); record('installed-plugin-original-interactive-terminal');
  const send = async text => {
    await page.getByRole('textbox').fill(text); await page.getByRole('button', { name: '↑', exact: true }).click();
    await expect(page.getByRole('textbox')).toHaveValue('');
  };
  await send('PROBE:READY');
  await expect(page.getByText('READY', { exact: true }).last()).toBeVisible({ timeout: 15000 });
  record('mobile-browser-to-original-terminal-and-stream');
  await send('PROBE:APPROVAL');
  await expect(page.getByRole('button', { name: '批准', exact: true })).toBeVisible({ timeout: 15000 });
  writeFileSync(join(dir, 'restart.request'), 'restart isolated daemon during permission wait\n');
  await expect.poll(async () => existsSync(join(dir, 'restarted.json')), { timeout: 10000 }).toBe(true);
  await expect.poll(async () => (await detail()).session.terminal.connected, { timeout: 10000 }).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: '批准', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await expect(page.getByText('APPROVAL_DONE', { exact: true })).toBeVisible({ timeout: 15000 });
  record('mobile-approval-survives-daemon-restart-and-runs-native-tool');
  const device = randomUUID(); await api('/api/v1/native-push/devices', { id: device });
  await send('PROBE:LONG');
  await expect.poll(async () => (await detail()).session.status).toBe('running');
  await page.close();
  const restartRequestedAt = Date.now();
  writeFileSync(join(dir, 'restart.request'), 'restart isolated daemon only\n');
  const deadline = Date.now() + 12000;
  while (!existsSync(join(dir, 'restarted.json')) || JSON.parse(readFileSync(join(dir, 'restarted.json'))).at < restartRequestedAt) { if (Date.now() > deadline) throw new Error('Fixture restart failed'); await sleep(100); }
  await expect.poll(async () => (await detail()).session.terminal.connected, { timeout: 12000 }).toBe(true);
  process.kill(run.cliPid, 0); record('daemon-restart-reconnects-original-cli-on-new-port');
  let deliveries;
  await expect.poll(async () => { deliveries = (await api(`/api/v1/native-push/devices/${device}/inbox?wait=0`)).deliveries; return deliveries.length; }, { timeout: 30000 }).toBe(1);
  assert.equal(deliveries[0].notification.url, '/' + encodeURIComponent(id));
  record('closed-page-native-inbox-completion-and-original-deeplink');
  page = await context.newPage(); await page.goto(run.url + deliveries[0].notification.url);
  await expect(page.getByRole('textbox')).toBeEnabled();
  await send('PROBE:LONG');
  await expect(page.getByTitle('中断')).toBeEnabled({ timeout: 10000 });
  await page.getByTitle('中断').click();
  await expect.poll(async () => (await detail()).session.status).toBe('idle');
  await send('PROBE:SECOND');
  await expect(page.getByText('SECOND_READY', { exact: true })).toBeVisible({ timeout: 10000 });
  assert.equal((await detail()).session.terminal.originalSessionId, run.sessionId);
  process.kill(run.cliPid, 0); record('mobile-interrupt-and-followup-same-process-and-session');
  await page.screenshot({ path: join(dir, 'mobile-claude.png'), fullPage: true });
} catch (error) {
  report.error = error.message; await page.screenshot({ path: join(dir, 'failed.png') }).catch(() => {}); throw error;
} finally {
  writeFileSync(join(dir, 'verification.json'), JSON.stringify(report, null, 2)); await browser.close();
}
