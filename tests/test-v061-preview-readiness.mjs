import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const sandbox = { console, globalThis: null, location: { hostname: 'not-moengage.invalid' } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'retkit-moengage-core.user.js' });
const core = sandbox.__RetKitMoEngageCore;
assert.deepEqual(JSON.parse(JSON.stringify(core.previewReadinessAction({ native: false, rendered: false }))), { open: false, mode: 'missing-editor' });
assert.deepEqual(JSON.parse(JSON.stringify(core.previewReadinessAction({ native: true, rendered: false }))), { open: true, mode: 'local-fallback' });
assert.deepEqual(JSON.parse(JSON.stringify(core.previewReadinessAction({ native: true, rendered: true }))), { open: true, mode: 'native-preview' });

assert.doesNotMatch(source, /MoEngage preview is not ready yet/);
assert.match(source, /showing local HTML preview/);

console.log('✓ RetKit v0.6.1 preview readiness');
