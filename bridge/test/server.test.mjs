import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeServer } from '../src/server.mjs';

test('health and websocket hello expose bridge ready', async () => {
  const bridge = createBridgeServer({ port: 0, host: '127.0.0.1', detectProviders: async () => [] });
  const address = await bridge.start();
  try {
    const health = await fetch(`http://127.0.0.1:${address.port}/health`).then(r => r.json());
    assert.deepEqual(health, { ok: true, version: '0.6.5', protocol: 1 });

    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws timeout')), 3000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, workspaceId: 'test' })));
      ws.addEventListener('message', (event) => {
        events.push(JSON.parse(event.data));
        if (events.some(x => x.type === 'bridge.ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.addEventListener('error', reject);
    });
    const ready = events.find(x => x.type === 'bridge.ready');
    assert.equal(ready.protocol, 1);
    assert.ok(ready.sessionSecret);
    ws.close();
  } finally {
    await bridge.stop();
  }
});

test('provider connect and chat stream route through bridge', async () => {
  const bridge = createBridgeServer({ port: 0, host: '127.0.0.1', detectProviders: async () => [], includeFake: true });
  const address = await bridge.start();
  try {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bridge chat timeout')), 3000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, workspaceId: 'chat-test' })));
      ws.addEventListener('message', (event) => {
        const value = JSON.parse(event.data);
        events.push(value);
        if (value.type === 'bridge.ready') ws.send(JSON.stringify({ type: 'provider.connect', protocol: 1, provider: 'fake' }));
        if (value.type === 'provider.connected') ws.send(JSON.stringify({ type: 'chat.send', protocol: 1, provider: 'fake', text: 'hello', context: { subject: 'S' }, attachmentIds: [] }));
        if (value.type === 'chat.done') { clearTimeout(timer); resolve(); }
      });
      ws.addEventListener('error', reject);
    });
    assert.ok(events.some((x) => x.type === 'provider.connected' && x.provider === 'fake'));
    assert.ok(events.some((x) => x.type === 'chat.delta' && /hello/i.test(x.text)));
    assert.ok(events.some((x) => x.type === 'chat.done' && x.provider === 'fake'));
    ws.close();
  } finally {
    await bridge.stop();
  }
});

test('internal MCP tool endpoint forwards to browser and waits for tool.result', async () => {
  const bridge = createBridgeServer({ port: 0, host: '127.0.0.1', detectProviders: async () => [] });
  const address = await bridge.start();
  try {
    let secret = '';
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, workspaceId: 'tool-test' })));
      ws.addEventListener('message', (event) => {
        const value = JSON.parse(event.data);
        if (value.type === 'bridge.ready') { secret = value.sessionSecret; resolve(); }
      });
      ws.addEventListener('error', reject);
    });
    ws.addEventListener('message', (event) => {
      const value = JSON.parse(event.data);
      if (value.type === 'tool.call') ws.send(JSON.stringify({ type: 'tool.result', protocol: 1, callId: value.callId, ok: true, result: { subject: 'From browser' } }));
    });
    const response = await fetch(`http://127.0.0.1:${address.port}/internal/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-retkit-session': secret },
      body: JSON.stringify({ tool: 'get_subject', args: {} }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result: { subject: 'From browser' } });
    ws.close();
  } finally {
    await bridge.stop();
  }
});
