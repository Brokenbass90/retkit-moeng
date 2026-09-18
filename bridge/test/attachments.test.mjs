import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AttachmentStore, validateAttachmentMeta } from '../src/attachments.mjs';

test('attachment validation rejects unsupported and oversized files', () => {
  assert.equal(validateAttachmentMeta({ mime: 'image/png', size: 100, name: 'a.png' }).ok, true);
  assert.equal(validateAttachmentMeta({ mime: 'text/html', size: 100, name: 'email.html' }).ok, true);
  assert.equal(validateAttachmentMeta({ mime: 'application/json', size: 100, name: 'data.json' }).ok, true);
  assert.equal(validateAttachmentMeta({ mime: 'image/svg+xml', size: 100, name: 'x.svg' }).ok, false);
  assert.equal(validateAttachmentMeta({ mime: 'image/png', size: 13 * 1024 * 1024, name: 'huge.png' }).ok, false);
  assert.equal(validateAttachmentMeta({ mime: 'text/plain', size: 600 * 1024, name: 'huge.txt' }).ok, false);
});

test('attachment store removes expired temp files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'retkit-ai-test-'));
  let now = 1000;
  const store = new AttachmentStore({ rootDir: root, ttlMs: 100, now: () => now });
  const saved = await store.save({ sessionId: 's1', name: 'shot.png', mime: 'image/png', body: Buffer.from('abc') });
  await fs.stat(saved.path);
  now = 1200;
  const removed = await store.cleanupExpired();
  assert.equal(removed, 1);
  await assert.rejects(fs.stat(saved.path));
  await fs.rm(root, { recursive: true, force: true });
});
