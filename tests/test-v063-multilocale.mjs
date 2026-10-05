import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const coreSource = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const bridgeSource = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');

const sandbox = {
  console,
  globalThis: null,
  location: { hostname: 'not-moengage.invalid' },
  localStorage: { getItem: () => null, setItem: () => {} },
  setTimeout,
  clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(coreSource, sandbox, { filename: 'retkit-moengage-core.user.js' });

const core = sandbox.__RetKitMoEngageCore;
assert.ok(core, 'core should load outside MoEngage');
assert.equal(typeof core.buildLocaleReplacePlan, 'function', 'core should expose buildLocaleReplacePlan');

const plan = core.buildLocaleReplacePlan({
  EN: '<img src="old.png"><a href="old.png">x</a>',
  AR: '<img src="old.png">',
  FR: '<img src="other.png">',
}, 'old.png', 'new.png', ['EN', 'AR', 'FR']);
assert.deepEqual(JSON.parse(JSON.stringify(plan)), [
  { locale: 'EN', count: 2, changed: true, before: '<img src="old.png"><a href="old.png">x</a>', after: '<img src="new.png"><a href="new.png">x</a>' },
  { locale: 'AR', count: 1, changed: true, before: '<img src="old.png">', after: '<img src="new.png">' },
  { locale: 'FR', count: 0, changed: false, before: '<img src="other.png">', after: '<img src="other.png">' },
]);
assert.deepEqual(JSON.parse(JSON.stringify(core.summarizeLocaleReplacePlan(plan))), {
  localeCount: 3,
  matchedLocales: 2,
  totalMatches: 3,
  changedLocales: ['EN', 'AR'],
});

assert.match(bridgeSource, /setLocaleHtml:/, 'browser bridge API should expose setLocaleHtml');
assert.match(bridgeSource, /async function setNativeLocaleHtml\(/, 'bridge should have verified locale HTML writer');
assert.match(coreSource, /retkit-mo-multilocale-drawer/, 'advanced multi-locale drawer should exist');
assert.doesNotMatch(coreSource, /makeButton\('Scope/, 'find bar should not expose a separate Scope control');
assert.match(coreSource, /scheduleMultiLocaleAutoScan/, 'find bar should auto-scan locales');
assert.doesNotMatch(coreSource, /bar\.append\([^\n]*Bulk Images/, 'topbar must not gain a permanent Bulk Images button');
assert.match(bridgeSource, /nativeLocaleBarCache/, 'native locale bar should be cached while connected');
assert.match(bridgeSource, /addLocaleMenuRootFromNode/, 'add-locale options should be scoped to the newly mounted native popup');

console.log('✓ RetKit v0.6.6 multi-locale tools regressions');
