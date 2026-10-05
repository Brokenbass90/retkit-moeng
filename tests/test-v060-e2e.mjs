import assert from 'node:assert/strict';
import { createBridgeServer } from '../bridge/src/server.mjs';
import fs from 'node:fs';

const rootPackage = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(rootPackage.scripts.bridge, 'npm --prefix bridge start');
assert.equal(rootPackage.scripts['bridge:test'], 'npm --prefix bridge test');
assert.equal(rootPackage.scripts.package, 'node scripts/package.mjs');
assert.match(rootPackage.scripts.check, /bridge:test/);

const bridge = createBridgeServer({
  port: 0,
  host: '127.0.0.1',
  includeFake: true,
  detectProviders: async () => [],
  fakeOptions: { toolCall: { callId: 'fake-call-1', tool: 'get_subject', args: {} } },
});
const address = await bridge.start();
const events = [];
try {
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Origin: 'https://dashboard-02.moengage.com' } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RetKit AI e2e timeout')), 3500);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, workspaceId: 'e2e' })));
    ws.addEventListener('error', reject);
    ws.addEventListener('message', (message) => {
      const event = JSON.parse(message.data);
      events.push(event);
      if (event.type === 'bridge.ready') ws.send(JSON.stringify({ type: 'provider.connect', protocol: 1, provider: 'fake' }));
      if (event.type === 'provider.connected') ws.send(JSON.stringify({ type: 'chat.send', protocol: 1, provider: 'fake', text: 'check subject', context: { subject: 'Hello' }, attachmentIds: [] }));
      if (event.type === 'tool.call') ws.send(JSON.stringify({ type: 'tool.result', protocol: 1, callId: event.callId, ok: true, result: { subject: 'Hello' } }));
      if (event.type === 'chat.done') { clearTimeout(timer); resolve(); }
    });
  });
  ws.close();

  const delta = events.findIndex((x) => x.type === 'chat.delta');
  const tool = events.findIndex((x) => x.type === 'tool.call');
  const done = events.findIndex((x) => x.type === 'chat.done');
  assert.ok(delta >= 0, 'assistant delta should stream');
  assert.ok(tool > delta, 'tool call should follow initial delta');
  assert.ok(done > tool, 'turn should finish after browser tool result');
  assert.equal(events.some((x) => x.type === 'bridge.error'), false, JSON.stringify(events.filter((x) => x.type === 'bridge.error')));
  console.log('✓ RetKit v0.6.0 fake-provider e2e');
} finally {
  await bridge.stop();
}
