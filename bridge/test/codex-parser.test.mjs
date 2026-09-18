import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlRpcClient, mapCodexMessageToProviderEvent, toolResultToRpcResponse, codexAccountAuth, buildCodexTurnInput } from '../src/providers/codex.mjs';

class FakeProcess {
  constructor() {
    this.handlers = new Map();
    this.stdout = { on: (name, fn) => this.handlers.set(`stdout:${name}`, fn) };
    this.stderr = { on: (name, fn) => this.handlers.set(`stderr:${name}`, fn) };
    this.stdin = { writes: [], write: (value) => { this.stdin.writes.push(String(value)); return true; } };
  }
  on(name, fn) { this.handlers.set(name, fn); }
  emitStdout(value) { this.handlers.get('stdout:data')?.(Buffer.from(value)); }
  emit(name, ...args) { this.handlers.get(name)?.(...args); }
  kill() {}
}

test('JsonlRpcClient parses fragmented JSONL and resolves out-of-order RPC ids', async () => {
  const process = new FakeProcess();
  const client = new JsonlRpcClient(process);
  const one = client.request('one', { a: 1 });
  const two = client.request('two', { b: 2 });
  const sent = process.stdin.writes.map((line) => JSON.parse(line));
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].id, sent[1].id);

  process.emitStdout(JSON.stringify({ id: sent[1].id, result: { value: 'second' } }).slice(0, 12));
  process.emitStdout(`${JSON.stringify({ id: sent[1].id, result: { value: 'second' } }).slice(12)}\n${JSON.stringify({ id: sent[0].id, result: { value: 'first' } })}\n`);

  assert.deepEqual(await two, { value: 'second' });
  assert.deepEqual(await one, { value: 'first' });
  client.close();
});

test('Codex dynamic tool request maps to a browser tool call and response keeps RPC id', () => {
  const request = {
    method: 'item/tool/call',
    id: 60,
    params: { threadId: 'thr_1', turnId: 'turn_1', callId: 'call_1', tool: 'get_subject', arguments: {} },
  };
  assert.deepEqual(mapCodexMessageToProviderEvent(request), {
    type: 'tool.call',
    rpcId: 60,
    callId: 'call_1',
    tool: 'get_subject',
    args: {},
    threadId: 'thr_1',
    turnId: 'turn_1',
  });

  assert.deepEqual(toolResultToRpcResponse(60, { ok: true, result: { subject: 'Hello' } }), {
    id: 60,
    result: {
      contentItems: [{ type: 'inputText', text: JSON.stringify({ subject: 'Hello' }) }],
      success: true,
    },
  });
  assert.deepEqual(toolResultToRpcResponse(60, { ok: false, error: { code: 'X', message: 'Nope' } }), {
    id: 60,
    result: {
      contentItems: [{ type: 'inputText', text: JSON.stringify({ error: { code: 'X', message: 'Nope' } }) }],
      success: false,
    },
  });
});

test('Codex notifications map streaming delta and completed turn', () => {
  assert.deepEqual(mapCodexMessageToProviderEvent({ method: 'item/agentMessage/delta', params: { delta: 'abc' } }), { type: 'delta', text: 'abc' });
  assert.deepEqual(mapCodexMessageToProviderEvent({ method: 'turn/completed', params: { turn: { id: 'turn_9', status: 'completed' } } }), { type: 'done', turnId: 'turn_9', status: 'completed', usage: null });
});


test('Codex account state distinguishes authenticated and auth-required', () => {
  assert.equal(codexAccountAuth({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true }), 'yes');
  assert.equal(codexAccountAuth({ account: null, requiresOpenaiAuth: true }), 'no');
  assert.equal(codexAccountAuth({ account: null, requiresOpenaiAuth: false }), 'unknown');
});


test('Codex turn input keeps images native and inlines text attachments', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'retkit-codex-attachment-'));
  try {
    const textPath = path.join(dir, 'email.html');
    await fs.writeFile(textPath, '<h1>Hello</h1>');
    const input = await buildCodexTurnInput('Review this', [
      { kind: 'image', path: '/tmp/shot.png', name: 'shot.png', mime: 'image/png' },
      { kind: 'text', path: textPath, name: 'email.html', mime: 'text/html' },
    ]);
    assert.deepEqual(input[0], { type: 'text', text: 'Review this' });
    assert.deepEqual(input[1], { type: 'localImage', path: '/tmp/shot.png' });
    assert.match(input[2].text, /Attached file email\.html/);
    assert.match(input[2].text, /<h1>Hello<\/h1>/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
