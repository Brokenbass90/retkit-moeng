import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeProvider } from '../src/providers/fake.mjs';

test('fake provider follows deterministic streaming contract', async () => {
  const provider = new FakeProvider();
  const status = await provider.detect();
  assert.equal(status.detected, true);
  await provider.connect({ sessionId: 's1' });
  const events = [];
  for await (const event of provider.send({ text: 'hello', attachments: [] })) events.push(event);
  assert.equal(events[0].type, 'delta');
  assert.match(events[0].text, /hello/i);
  assert.equal(events.at(-1).type, 'done');
  await provider.cancel();
  await provider.close();
});

import { createProviderRegistry } from '../src/provider-registry.mjs';

test('provider registry exposes Codex and Claude adapters', () => {
  const registry = createProviderRegistry();
  assert.equal(registry.get('codex')?.id, 'codex');
  assert.equal(registry.get('claude')?.id, 'claude');
});

test('fake provider waits for tool result before completing tool turn', async () => {
  const provider = new FakeProvider({ toolCall: { callId: 'c1', tool: 'get_subject', args: {} } });
  await provider.connect({ sessionId: 's-tool' });
  const iterator = provider.send({ text: 'tool please' })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, 'delta');
  assert.equal((await iterator.next()).value.type, 'tool.call');
  const pending = iterator.next();
  const early = await Promise.race([pending.then(() => 'completed'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 20))]);
  assert.equal(early, 'waiting');
  assert.equal(await provider.provideToolResult('c1', { ok: true, result: { subject: 'Hello' } }), true);
  assert.equal((await pending).value.type, 'done');
});
