import { readFileSync } from 'node:fs';

const [file, action = 'list', sessionId, argument] = process.argv.slice(2);
if (!file) throw new Error('Usage: node control.mjs <private-state-file> list|events|send|interrupt|snapshot|allow|deny [session-id] [text|approval-id]');
const { url, token } = JSON.parse(readFileSync(file, 'utf8'));
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const response = await fetch(url + '/sessions', { headers });
if (!response.ok) throw new Error('Broker unavailable: ' + response.status);
const { sessions } = await response.json();
if (action === 'list') {
  console.log(JSON.stringify(sessions.map(({ events, commands, approvals, ...s }) => ({ ...s, commands, approvals })), null, 2));
} else {
  const session = sessions.find(s => s.sessionId === sessionId);
  if (!session) throw new Error('Specify an exact session ID from list');
  if (action === 'events') console.log(JSON.stringify(session.events, null, 2));
  else {
    const approval = ['allow', 'deny'].includes(action);
    const body = {
      sessionId, instanceId: session.instanceId,
      ...(approval ? { approvalId: argument, decision: action } : { kind: action, ...(action === 'send' ? { text: argument } : {}), ...(action === 'interrupt' ? { turnId: session.turnId } : {}) }),
    };
    const result = await fetch(url + (approval ? '/approve' : '/control'), { method: 'POST', headers, body: JSON.stringify(body) });
    console.log(JSON.stringify(await result.json(), null, 2));
    if (!result.ok) process.exitCode = 1;
  }
}
