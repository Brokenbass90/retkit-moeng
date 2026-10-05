import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');
const sandbox = { console, globalThis: null, location: { hostname: 'not-moengage.invalid' } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'native-bridge.user.js' });
const core = sandbox.__RetKitMoEngageBridgeCore;
assert.ok(core);
assert.equal(core.addLocaleTriggerLabelMatches('+ Locale'), true);
assert.equal(core.addLocaleTriggerLabelMatches('Add locale'), true);
assert.equal(core.addLocaleTriggerLabelMatches('New Locale'), true);
assert.equal(core.addLocaleTriggerLabelMatches('Locales'), false);
assert.equal(core.canRemoveLocale('EN'), false);
assert.equal(core.canRemoveLocale('DEFAULT'), false);
assert.equal(core.canRemoveLocale('AR'), true);
assert.equal(core.canRemoveLocale('FR'), true);

const tools = fs.readFileSync(new URL('../bridge/src/tools/retkit-tools.mjs', import.meta.url), 'utf8');
assert.match(tools, /remove_locale/);
assert.match(source, /removeLocale:/, 'browser bridge API should expose removeLocale');

console.log('✓ RetKit v0.6.1 locale manager core');
