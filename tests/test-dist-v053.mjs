import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const distPath = new URL('../dist/retkit-moengage.user.js', import.meta.url);
const source = fs.readFileSync(distPath, 'utf8');

assert.match(source, /@version\s+0\.5\.9/);
assert.doesNotMatch(source, /^\/\/ @require\s+/m, 'installed userscript must be standalone');
assert.match(source, /__RetKitMoEngageCore/);
assert.match(source, /__RetKitMoEngageBridgeCore/);

const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval, globalThis: {} };
sandbox.globalThis.globalThis = sandbox.globalThis;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'retkit-moengage.user.js' });
assert.ok(sandbox.globalThis.__RetKitMoEngageCore, 'dist should include editor core');
assert.ok(sandbox.globalThis.__RetKitMoEngageBridgeCore, 'dist should include locale/RTL bridge');

console.log('✓ RetKit v0.5.4 standalone dist');
