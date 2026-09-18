import test from 'node:test';
import assert from 'node:assert/strict';
import { validateClientMessage, PROTOCOL_VERSION } from '../src/protocol.mjs';

test('protocol accepts known v1 client message', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.deepEqual(validateClientMessage({ type: 'hello', protocol: 1, workspaceId: 'w1' }), { type: 'hello', protocol: 1, workspaceId: 'w1' });
});

test('protocol rejects mismatch and unknown type', () => {
  assert.throws(() => validateClientMessage({ type: 'hello', protocol: 99 }), /protocol mismatch/i);
  assert.throws(() => validateClientMessage({ type: 'explode', protocol: 1 }), /unknown/i);
});
