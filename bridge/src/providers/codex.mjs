import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { normalizeProviderStatus } from './provider.mjs';
import { codexDynamicTools } from '../tools/retkit-tools.mjs';

function errorMessage(value) {
  if (value instanceof Error) return value.message;
  return String(value || 'Unknown Codex error');
}

export class JsonlRpcClient extends EventEmitter {
  constructor(processHandle) {
    super();
    this.process = processHandle;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    processHandle.stdout?.on?.('data', (chunk) => this.#onData(chunk));
    processHandle.stderr?.on?.('data', (chunk) => this.emit('stderr', chunk.toString()));
    processHandle.on?.('error', (error) => this.#failAll(error));
    processHandle.on?.('exit', (code, signal) => this.#failAll(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})`)));
  }

  #onData(chunk) {
    this.buffer += chunk.toString();
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const raw = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!raw) continue;
      let message;
      try { message = JSON.parse(raw); }
      catch (error) { this.emit('protocolError', new Error(`Invalid Codex JSONL: ${errorMessage(error)}`), raw); continue; }
      if (message && Object.hasOwn(message, 'id') && !message.method) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error?.message || JSON.stringify(message.error)));
          else pending.resolve(message.result);
          continue;
        }
      }
      this.emit('message', message);
    }
  }

  #write(value) {
    if (this.closed) throw new Error('Codex RPC client is closed');
    this.process.stdin?.write?.(`${JSON.stringify(value)}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
    try { this.#write({ method, id, params }); }
    catch (error) { this.pending.delete(id); return Promise.reject(error); }
    return promise;
  }

  notify(method, params = {}) { this.#write({ method, params }); }
  respond(id, result) { this.#write({ id, result }); }
  respondError(id, code, message) { this.#write({ id, error: { code, message: String(message || code) } }); }

  #failAll(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emit('closed', error);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error('Codex RPC client closed'));
    this.pending.clear();
    try { this.process.kill?.(); } catch {}
  }
}

export function mapCodexMessageToProviderEvent(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.method === 'item/agentMessage/delta') {
    const text = String(message.params?.delta || '');
    return text ? { type: 'delta', text } : null;
  }
  if (message.method === 'item/tool/call' && Object.hasOwn(message, 'id')) {
    return {
      type: 'tool.call',
      rpcId: message.id,
      callId: String(message.params?.callId || ''),
      tool: String(message.params?.tool || ''),
      args: message.params?.arguments && typeof message.params.arguments === 'object' ? message.params.arguments : {},
      threadId: String(message.params?.threadId || ''),
      turnId: String(message.params?.turnId || ''),
    };
  }
  if (message.method === 'turn/completed') {
    const turn = message.params?.turn || {};
    return {
      type: 'done',
      turnId: String(turn.id || message.params?.turnId || ''),
      status: String(turn.status || 'completed'),
      usage: turn.tokenUsage || turn.usage || null,
    };
  }
  return null;
}

export function codexAccountAuth(accountResult = {}) {
  if (accountResult?.account) return 'yes';
  if (accountResult?.requiresOpenaiAuth === true) return 'no';
  return 'unknown';
}

export function toolResultToRpcResponse(rpcId, payload = {}) {
  const success = payload.ok !== false;
  const value = success ? payload.result : { error: payload.error || { code: 'TOOL_ERROR', message: 'Tool failed' } };
  return {
    id: rpcId,
    result: {
      contentItems: [
        { type: 'inputText', text: JSON.stringify(value ?? null) },
        ...(success && payload.imageDataUrl ? [{ type: 'inputImage', imageUrl: payload.imageDataUrl }] : []),
      ],
      success,
    },
  };
}

class AsyncEventQueue {
  constructor() { this.items = []; this.waiters = []; this.closed = false; }
  push(value) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.items.push(value);
  }
  end() {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()({ value: undefined, done: true });
  }
  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  [Symbol.asyncIterator]() { return this; }
}

async function probeVersion(spawnImpl, command) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try { child = spawnImpl(command, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ detected: false, version: null, detail: errorMessage(error) }); return; }
    const timer = setTimeout(() => { try { child.kill?.(); } catch {} resolve({ detected: false, version: null, detail: 'Detection timed out' }); }, 1800);
    child.stdout?.on?.('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on?.('data', (chunk) => { stderr += chunk.toString(); });
    child.on?.('error', (error) => { clearTimeout(timer); resolve({ detected: false, version: null, detail: errorMessage(error) }); });
    child.on?.('exit', (code) => {
      clearTimeout(timer);
      const text = `${stdout}\n${stderr}`.trim();
      resolve(code === 0
        ? { detected: true, version: text.split(/\r?\n/)[0] || null, detail: null }
        : { detected: false, version: null, detail: text || `exit ${code}` });
    });
  });
}


export async function buildCodexTurnInput(text, attachments = []) {
  const input = [{ type: 'text', text: String(text || '') }];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!attachment?.path) continue;
    const kind = String(attachment.kind || (String(attachment.mime || '').startsWith('image/') ? 'image' : 'text'));
    if (kind === 'image') {
      input.push({ type: 'localImage', path: String(attachment.path) });
      continue;
    }
    try {
      const content = await fs.readFile(String(attachment.path), 'utf8');
      input.push({ type: 'text', text: `Attached file ${String(attachment.name || 'file')} (${String(attachment.mime || 'text/plain')}):\n\n${content}` });
    } catch (error) {
      input.push({ type: 'text', text: `Attached file ${String(attachment.name || 'file')} could not be read: ${errorMessage(error)}` });
    }
  }
  return input;
}

export class CodexProvider {
  constructor(options = {}) {
    this.id = 'codex';
    this.command = options.command || 'codex';
    this.spawn = options.spawnImpl || nodeSpawn;
    this.cwd = options.cwd || path.join(os.tmpdir(), 'retkit-ai-codex');
    this.rpc = null;
    this.process = null;
    this.threadId = null;
    this.currentTurnId = null;
    this.queue = null;
    this.pendingToolRpc = new Map();
    this.authenticated = 'unknown';
    this.version = null;
  }

  async detect() {
    const result = await probeVersion(this.spawn, this.command);
    this.version = result.version;
    return normalizeProviderStatus({ ...result, authenticated: result.detected ? this.authenticated : 'no' }, this.id);
  }

  async connect() {
    if (this.rpc && this.threadId) return { ok: true, sessionId: this.threadId, authenticated: this.authenticated };
    await fs.mkdir(this.cwd, { recursive: true });
    this.process = this.spawn(this.command, ['app-server'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.rpc = new JsonlRpcClient(this.process);
    this.rpc.on('message', (message) => this.#onRpcMessage(message));
    this.rpc.on('closed', () => { this.queue?.end(); this.queue = null; });

    await this.rpc.request('initialize', {
      clientInfo: { name: 'retkit_ai', title: 'RetKit AI Workbench', version: '0.7.4' },
      capabilities: { experimentalApi: true },
    });
    this.rpc.notify('initialized', {});

    try {
      const account = await this.rpc.request('account/read', { refreshToken: false });
      this.authenticated = codexAccountAuth(account);
    } catch {
      this.authenticated = 'unknown';
    }
    if (this.authenticated === 'no') throw new Error('Codex authentication required');

    const response = await this.rpc.request('thread/start', {
      cwd: this.cwd,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'readOnly',
      dynamicTools: codexDynamicTools(),
    });
    this.threadId = String(response?.thread?.id || response?.id || '');
    if (!this.threadId) throw new Error('Codex app-server did not return a thread id');
    return { ok: true, sessionId: this.threadId, authenticated: this.authenticated };
  }

  #onRpcMessage(message) {
    const event = mapCodexMessageToProviderEvent(message);
    if (!event) return;
    if (event.type === 'tool.call') this.pendingToolRpc.set(event.callId, event.rpcId);
    if (event.type === 'done') this.currentTurnId = null;
    this.queue?.push(event);
  }

  async *send(turn = {}) {
    if (!this.rpc || !this.threadId) await this.connect();
    if (this.queue) throw new Error('Codex turn already active');
    this.queue = new AsyncEventQueue();
    const queue = this.queue;
    const input = await buildCodexTurnInput(turn.text, turn.attachments);
    const response = await this.rpc.request('turn/start', { threadId: this.threadId, input });
    this.currentTurnId = String(response?.turn?.id || response?.id || '');
    try {
      for await (const event of queue) {
        yield event;
        if (event.type === 'done') break;
      }
    } finally {
      if (this.queue === queue) this.queue = null;
      queue.end();
    }
  }

  async provideToolResult(callId, payload) {
    const rpcId = this.pendingToolRpc.get(String(callId));
    if (rpcId == null) throw new Error(`Unknown Codex tool call: ${callId}`);
    this.pendingToolRpc.delete(String(callId));
    // A rendered preview PNG goes to Codex as an image, not only as a path.
    let enriched = payload;
    const png = payload?.ok !== false && payload?.result?.supported && typeof payload.result.path === 'string' && payload.result.path.endsWith('.png') ? payload.result.path : '';
    if (png) {
      try { enriched = { ...payload, imageDataUrl: `data:image/png;base64,${(await fs.readFile(png)).toString('base64')}` }; } catch {}
    }
    const response = toolResultToRpcResponse(rpcId, enriched);
    this.rpc.respond(response.id, response.result);
    return true;
  }

  async cancel() {
    if (!this.rpc || !this.threadId || !this.currentTurnId) return false;
    await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.currentTurnId });
    return true;
  }

  async close() {
    this.queue?.end();
    this.queue = null;
    this.pendingToolRpc.clear();
    this.rpc?.close();
    this.rpc = null;
    this.process = null;
    this.threadId = null;
    this.currentTurnId = null;
  }
}
