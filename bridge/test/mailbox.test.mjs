import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeServer } from '../src/server.mjs';

const MO = 'https://dashboard-02.moengage.com';
const UCC = 'https://ucc.int.iqoption.com';

test('mailbox: команды и ответы между claude, ucc и mo; чужие origin — 403', async () => {
  const bridge = createBridgeServer({ host: '127.0.0.1', port: 0, detectProviders: false });
  const { port } = await bridge.start();
  const base = `http://127.0.0.1:${port}`;
  const post = (origin, body) => fetch(`${base}/mailbox/post`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    const sent = await post(MO, { from: 'claude', to: 'ucc', type: 'open', uccId: 15928 });
    assert.equal(sent.ok, true);
    const polled = await fetch(`${base}/mailbox/poll?to=ucc&after=0`, { headers: { Origin: UCC } }).then((r) => r.json());
    assert.equal(polled.messages[0].type, 'open');
    assert.equal(polled.messages[0].uccId, 15928);
    // long-poll просыпается от нового сообщения
    const waiting = fetch(`${base}/mailbox/poll?to=mo&after=${polled.lastId}&wait=5000`, { headers: { Origin: MO } }).then((r) => r.json());
    await post(UCC, { from: 'ucc', to: 'mo', type: 'transfer', uccId: 15928, transfer: { name: '2fa-code', locales: [] } });
    const woke = await waiting;
    assert.equal(woke.messages[0].transfer.name, '2fa-code');
    const latest = await fetch(`${base}/mailbox/latest?to=mo&type=transfer&uccId=15928`, { headers: { Origin: MO } }).then((r) => r.json());
    assert.equal(latest.message.uccId, 15928);
    const denied = await fetch(`${base}/mailbox/poll?to=ucc`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(denied.status, 403);
    const noOrigin = await fetch(`${base}/mailbox/poll?to=ucc`);
    assert.equal(noOrigin.status, 403);
    const pre = await fetch(`${base}/mailbox/post`, { method: 'OPTIONS', headers: { Origin: UCC } });
    assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
  } finally {
    await bridge.stop();
  }
});
