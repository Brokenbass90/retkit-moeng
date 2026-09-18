import { normalizeProviderStatus } from './provider.mjs';

export class FakeProvider {
  constructor(options = {}) {
    this.id = 'fake';
    this.sessionId = null;
    this.cancelled = false;
    this.toolCall = options.toolCall || null;
    this.toolWaiters = new Map();
  }
  async detect() {
    return normalizeProviderStatus({ detected: true, authenticated: 'yes', version: 'test', detail: 'Deterministic fake provider' }, this.id);
  }
  async connect({ sessionId } = {}) {
    this.sessionId = sessionId || 'fake-session';
    this.cancelled = false;
    return { ok: true, sessionId: this.sessionId, authenticated: 'yes' };
  }
  async *send(turn = {}) {
    this.cancelled = false;
    const text = String(turn.text || '');
    yield { type: 'delta', text: `Fake AI received: ${text}` };
    if (this.toolCall && !this.cancelled) {
      const callId = String(this.toolCall.callId || 'fake-tool-call');
      yield { type: 'tool.call', ...this.toolCall, callId };
      await new Promise((resolve) => this.toolWaiters.set(callId, resolve));
      this.toolWaiters.delete(callId);
    }
    if (!this.cancelled) yield { type: 'done', sessionId: this.sessionId, usage: null };
  }
  async provideToolResult(callId, payload) {
    const resolve = this.toolWaiters.get(String(callId));
    if (!resolve) return false;
    resolve(payload);
    return true;
  }
  async cancel() {
    this.cancelled = true;
    for (const resolve of this.toolWaiters.values()) resolve({ ok: false, error: { code: 'CANCELLED', message: 'Cancelled' } });
    this.toolWaiters.clear();
  }
  async close() {
    await this.cancel();
    this.sessionId = null;
  }
}
