import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLoopbackHost, isAllowedOrigin, createSessionSecret, sessionSecretMatches } from '../src/security.mjs';

test('bridge only permits loopback bind', () => {
  assert.equal(assertLoopbackHost('127.0.0.1'), '127.0.0.1');
  assert.throws(() => assertLoopbackHost('0.0.0.0'), /loopback/i);
});

test('origin and session secret validation', () => {
  assert.equal(isAllowedOrigin('https://dashboard-02.moengage.com'), true);
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin('https://evil.example'), false);
  const secret = createSessionSecret();
  assert.ok(secret.length >= 32);
  assert.equal(sessionSecretMatches(secret, secret), true);
  assert.equal(sessionSecretMatches(secret, `${secret}x`), false);
});
