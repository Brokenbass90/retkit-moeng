import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const ALLOWED_TEXT_MIME = new Set(['text/plain', 'text/html', 'text/css', 'text/javascript', 'application/javascript', 'application/json', 'text/markdown']);
export const MAX_IMAGE_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
export const MAX_ATTACHMENT_BYTES = MAX_IMAGE_ATTACHMENT_BYTES;
export const MAX_ATTACHMENTS_PER_TURN = 4;

const TEXT_EXTENSIONS = new Set(['.txt', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.md', '.markdown']);

function normalizeMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

function extensionOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

export function attachmentKind({ mime, name } = {}) {
  const normalized = normalizeMime(mime);
  if (ALLOWED_IMAGE_MIME.has(normalized)) return 'image';
  if (ALLOWED_TEXT_MIME.has(normalized) || TEXT_EXTENSIONS.has(extensionOf(name))) return 'text';
  return '';
}

export function validateAttachmentMeta({ mime, size, name } = {}) {
  const normalized = normalizeMime(mime);
  const bytes = Number(size || 0);
  const kind = attachmentKind({ mime: normalized, name });
  if (!kind) return { ok: false, reason: 'Unsupported attachment type' };
  if (bytes <= 0) return { ok: false, reason: 'Empty attachment' };
  const max = kind === 'image' ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_TEXT_ATTACHMENT_BYTES;
  if (bytes > max) return { ok: false, reason: kind === 'image' ? 'Attachment exceeds 12 MiB' : 'Text attachment exceeds 512 KiB' };
  return { ok: true, reason: '', mime: normalized || (kind === 'text' ? 'text/plain' : 'application/octet-stream'), kind };
}

function safeExtension(mime, name, kind) {
  if (kind === 'text') {
    const ext = extensionOf(name);
    if (TEXT_EXTENSIONS.has(ext)) return ext;
  }
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'text/plain': '.txt', 'text/html': '.html', 'text/css': '.css', 'text/javascript': '.js', 'application/javascript': '.js', 'application/json': '.json', 'text/markdown': '.md' })[mime] || (kind === 'text' ? '.txt' : '.bin');
}

export class AttachmentStore {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.join(os.tmpdir(), 'retkit-ai');
    this.ttlMs = Number(options.ttlMs) || 30 * 60 * 1000;
    this.now = options.now || (() => Date.now());
    this.items = new Map();
  }

  async save({ sessionId, name, mime, body }) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
    const valid = validateAttachmentMeta({ mime, size: buffer.length, name });
    if (!valid.ok) throw new Error(valid.reason);
    const id = crypto.randomUUID();
    const dir = path.join(this.rootDir, String(sessionId));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const filePath = path.join(dir, `${id}${safeExtension(valid.mime, name, valid.kind)}`);
    await fs.writeFile(filePath, buffer, { mode: 0o600 });
    const record = {
      attachmentId: id,
      sessionId: String(sessionId),
      name: String(name || (valid.kind === 'image' ? 'image' : 'file')),
      mime: valid.mime,
      kind: valid.kind,
      size: buffer.length,
      path: filePath,
      createdAt: this.now(),
    };
    this.items.set(id, record);
    return { ...record };
  }

  get(attachmentId, sessionId) {
    const item = this.items.get(String(attachmentId));
    if (!item || (sessionId && item.sessionId !== String(sessionId))) return null;
    if (this.now() - item.createdAt > this.ttlMs) return null;
    return { ...item };
  }

  resolveMany(ids, sessionId) {
    const list = Array.from(ids || []).slice(0, MAX_ATTACHMENTS_PER_TURN);
    return list.map((id) => this.get(id, sessionId)).filter(Boolean);
  }

  async cleanupExpired() {
    const cutoff = this.now() - this.ttlMs;
    let removed = 0;
    for (const [id, item] of [...this.items.entries()]) {
      if (item.createdAt > cutoff) continue;
      this.items.delete(id);
      await fs.rm(item.path, { force: true }).catch(() => {});
      removed += 1;
    }
    return removed;
  }

  async removeSession(sessionId) {
    const sid = String(sessionId);
    for (const [id, item] of [...this.items.entries()]) {
      if (item.sessionId === sid) this.items.delete(id);
    }
    await fs.rm(path.join(this.rootDir, sid), { recursive: true, force: true }).catch(() => {});
  }
}
