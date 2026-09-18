import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mapClaudeEvent, buildClaudeArgs } from '../src/providers/claude.mjs';
import { createMcpRequestHandler } from '../src/mcp/stdio-server.mjs';

test('Claude stream-json maps text deltas and terminal result/session', () => {
  assert.deepEqual(mapClaudeEvent({
    type: 'stream_event',
    session_id: 's1',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
  }), { type: 'delta', text: 'Hel' });

  assert.deepEqual(mapClaudeEvent({
    type: 'result', subtype: 'success', session_id: 's1', result: 'Hello', usage: { input_tokens: 4, output_tokens: 2 },
  }), { type: 'done', sessionId: 's1', status: 'success', usage: { input_tokens: 4, output_tokens: 2 }, result: 'Hello' });
});

test('Claude args restrict built-in tools, load only RetKit MCP, and resume session', () => {
  const args = buildClaudeArgs({
    prompt: 'Inspect this email',
    sessionId: 'session-123',
    mcpConfigPath: '/tmp/retkit-mcp.json',
    attachmentDir: '/tmp/retkit-ai/session',
  });
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--include-partial-messages'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--mcp-config'));
  assert.ok(args.includes('/tmp/retkit-mcp.json'));
  assert.ok(args.includes('--tools'));
  assert.equal(args[args.indexOf('--tools') + 1], 'Read');
  assert.ok(args.includes('--allowedTools'));
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__retkit__*');
  assert.ok(args.includes('--resume'));
  assert.equal(args[args.indexOf('--resume') + 1], 'session-123');
  assert.ok(args.includes('--add-dir'));
  assert.equal(args[args.indexOf('--add-dir') + 1], '/tmp/retkit-ai/session');
});

test('MCP handler initializes, lists RetKit tools, and forwards a tool call to bridge', async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, secret: req.headers['x-retkit-session'], body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: { subject: 'Hello' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const handle = createMcpRequestHandler({ bridgeUrl: `http://127.0.0.1:${port}`, sessionSecret: 'secret-1' });
    const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.id, 1);
    assert.equal(init.result.serverInfo.name, 'retkit-ai');
    const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.ok(list.result.tools.some((tool) => tool.name === 'get_subject'));
    const call = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_subject', arguments: {} } });
    assert.deepEqual(JSON.parse(call.result.content[0].text), { subject: 'Hello' });
    assert.deepEqual(seen[0], { url: '/internal/tool', secret: 'secret-1', body: { tool: 'get_subject', args: {} } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
