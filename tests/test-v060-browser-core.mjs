import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const distPath = new URL('../dist/retkit-moengage.user.js', import.meta.url);
const dist = fs.readFileSync(distPath, 'utf8');
const ctx = { console, globalThis: null, setTimeout, clearTimeout };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(dist, ctx, { filename: 'retkit-moengage.user.js' });

assert.ok(ctx.__RetKitAiProtocol, 'AI protocol should be exposed');
assert.equal(ctx.__RetKitAiProtocol.PROTOCOL_VERSION, 1);
assert.equal(ctx.__RetKitAiProtocol.BRIDGE_WS_URL, 'ws://127.0.0.1:43118/ws');
assert.equal(ctx.__RetKitAiProtocol.BRIDGE_HTTP_URL, 'http://127.0.0.1:43118');
assert.match(dist, /RetKit AI Workbench/);
assert.equal((dist.match(/const PROTOCOL_VERSION = 1/g) || []).length, 1);
const assembled = fs.readFileSync(new URL('../dist/retkit-moengage.user.js', import.meta.url), 'utf8');
assert.match(assembled, /retkit-ai-toggle/, 'assembled source should contain the AI workbench');
assert.equal(assembled, dist, 'assembled source and dist should be identical after build');

assert.throws(() => ctx.__RetKitAiProtocol.makeClientMessage('bogus'), /Unknown RetKit AI client message/);
assert.deepEqual(
  JSON.parse(JSON.stringify(ctx.__RetKitAiProtocol.makeClientMessage('hello', { workspaceId: 'w1' }))),
  { type: 'hello', protocol: 1, workspaceId: 'w1' },
);


const bridgeClientPath = new URL('../src/ai/client/bridge-client.js', import.meta.url);
if (fs.existsSync(bridgeClientPath)) {
  vm.runInContext(fs.readFileSync(bridgeClientPath, 'utf8'), ctx, { filename: 'bridge-client.js' });
}
const bridgeCore = ctx.__RetKitAiBridgeCore;
assert.ok(bridgeCore, 'bridge client core should be exposed');
assert.deepEqual(JSON.parse(JSON.stringify(bridgeCore.nextConnectionState('offline', 'connect'))), { status: 'connecting' });
assert.equal(bridgeCore.nextConnectionState('connecting', 'open').status, 'connected');
assert.equal(bridgeCore.nextConnectionState('connected', 'close').status, 'offline');
assert.equal(bridgeCore.nextConnectionState('connected', 'error').status, 'error');

console.log('✓ RetKit v0.6.0 browser protocol');
