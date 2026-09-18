import { createBridgeServer } from './server.mjs';

const bridge = createBridgeServer({
  host: '127.0.0.1',
  port: Number(process.env.RETKIT_AI_PORT || 43118),
  includeFake: process.env.RETKIT_AI_PROVIDER === 'fake',
});

const address = await bridge.start();
console.log(`[RetKit AI] bridge v0.6.5 listening on http://127.0.0.1:${address.port}`);
console.log('[RetKit AI] open MoEngage and RetKit; credentials stay inside Codex/Claude Code.');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await bridge.stop();
    process.exit(0);
  });
}
