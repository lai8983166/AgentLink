import http from 'node:http';

// Deterministic loopback-only Anthropic Messages fixture. Never forwards a request.
export async function startFixtureApi() {
  const stats = { requests: 0, toolResults: [] };
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url?.includes('count_tokens')) { res.setHeader('Content-Type', 'application/json'); res.end('{"input_tokens":100}'); return; }
    if (!req.url?.startsWith('/v1/messages')) { res.writeHead(404); res.end(); return; }
    stats.requests++;
    const last = [...(data.messages ?? [])].reverse().find(m => m.role === 'user');
    const blocks = typeof last?.content === 'string' ? [{ type: 'text', text: last.content }] : last?.content ?? [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const results = blocks.filter(b => b.type === 'tool_result');
    for (const r of results) stats.toolResults.push({ id: r.tool_use_id, isError: !!r.is_error });
    const tool = text.includes('PROBE:APPROVAL') && results.length === 0;
    const long = text.includes('PROBE:LONG') && results.length === 0;
    const answer = tool ? 'Requesting harmless test command.' : results.length ? 'APPROVAL_DONE' : text.includes('PROBE:SECOND') ? 'SECOND_READY' : 'READY';
    const content = [{ type: 'text', text: answer }];
    if (tool) content.push({ type: 'tool_use', id: 'toolu_probe_' + stats.requests, name: 'Bash', input: { command: 'node -e "console.log(\'AGENTLINK_PROBE_APPROVED\')"', description: 'Print the isolated AgentLink verification marker' } });
    const message = { id: 'msg_probe_' + stats.requests, type: 'message', role: 'assistant', model: data.model, content, stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
    if (!data.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const event = (type, value) => { if (!res.destroyed) res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n'); };
    event('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    const pieces = long ? Array.from({ length: 100 }, (_, i) => 'LONG_' + i + ' ') : answer.match(/.{1,4}/g);
    let i = 0;
    const timer = setInterval(() => {
      if (i < pieces.length) { event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: pieces[i++] } }); return; }
      clearInterval(timer);
      event('content_block_stop', { index: 0 });
      if (tool) {
        const b = content[1];
        event('content_block_start', { index: 1, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
        event('content_block_stop', { index: 1 });
      }
      event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
      event('message_stop', {});
      res.end();
    }, long ? 200 : 80);
    res.once('close', () => clearInterval(timer));
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  return { url: 'http://127.0.0.1:' + server.address().port, stats, close: async () => {
    server.closeAllConnections();
    await new Promise(ok => server.close(ok));
  } };
}
