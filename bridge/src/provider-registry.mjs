import { spawn } from 'node:child_process';
import { normalizeProviderStatus, assertProviderContract } from './providers/provider.mjs';
import { FakeProvider } from './providers/fake.mjs';
import { CodexProvider } from './providers/codex.mjs';
import { ClaudeProvider } from './providers/claude.mjs';

export function probeExecutable(command, args = ['--version'], timeoutMs = 1500) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let child;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child?.kill?.(); } catch {}
      resolve(result);
    };
    try {
      child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ detected: false, version: null, detail: error?.message || String(error) });
      return;
    }
    child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', (error) => finish({ detected: false, version: null, detail: error?.message || String(error) }));
    child.on('exit', (code) => finish(code === 0
      ? { detected: true, version: output.trim().split(/\r?\n/)[0] || null, detail: null }
      : { detected: false, version: null, detail: output.trim() || `exit ${code}` }));
    timer = setTimeout(() => finish({ detected: false, version: null, detail: 'Detection timed out' }), timeoutMs);
  });
}

export async function detectProviders() {
  const [codex, claude] = await Promise.all([probeExecutable('codex'), probeExecutable('claude')]);
  return [
    normalizeProviderStatus({ ...codex, authenticated: codex.detected ? 'unknown' : 'no' }, 'codex'),
    normalizeProviderStatus({ ...claude, authenticated: claude.detected ? 'unknown' : 'no' }, 'claude'),
  ];
}

export function createProviderRegistry(options = {}) {
  const providers = new Map();
  providers.set('codex', assertProviderContract(options.codexProvider || new CodexProvider(options.codexOptions)));
  providers.set('claude', assertProviderContract(options.claudeProvider || new ClaudeProvider(options.claudeOptions)));
  if (process.env.RETKIT_AI_PROVIDER === 'fake' || options.includeFake) providers.set('fake', assertProviderContract(options.fakeProvider || new FakeProvider(options.fakeOptions)));

  return {
    providers,
    get(id) { return providers.get(String(id)) || null; },
    set(id, provider) { providers.set(String(id), assertProviderContract(provider)); return provider; },
    async statuses() {
      if (options.detectProviders) return options.detectProviders();
      const ordered = ['codex', 'claude', ...(providers.has('fake') ? ['fake'] : [])];
      return Promise.all(ordered.map(async (id) => {
        const provider = providers.get(id);
        try { return await provider.detect(); }
        catch (error) { return normalizeProviderStatus({ detected: false, authenticated: 'unknown', detail: error?.message || String(error) }, id); }
      }));
    },
    async closeAll() {
      await Promise.all([...providers.values()].map((provider) => Promise.resolve(provider.close()).catch(() => {})));
    },
  };
}
