import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/retkit-moengage-v0.5.user.js', import.meta.url), 'utf8');
const sandbox = {
  console,
  globalThis: null,
  location: { hostname: 'not-moengage.invalid' },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'retkit-moengage-v0.5.user.js' });

const core = sandbox.__RetKitMoEngageBridgeCore;
assert.ok(core, 'MoEngage bridge core should be exposed');

assert.deepEqual(
  JSON.parse(JSON.stringify(core.normaliseAddableLocaleLabels(
    ['ES', 'AR', 'ID', 'PT', 'TH', 'TL', 'UR', 'VI', 'New Locale', 'Add', 'ZH'],
    ['EN', 'FR', 'AR'],
  ))),
  ['ES', 'ID', 'PT', 'TH', 'TL', 'UR', 'VI', 'ZH'],
  'available locale list should come from MoEngage labels and exclude locales already in the campaign',
);

assert.deepEqual(
  JSON.parse(JSON.stringify(core.localeAddSelectionPlan(
    ['EN', 'FR'],
    ['AR', 'ES', 'TL', 'UR'],
    ['TL', 'UR', 'FR', 'JA'],
  ))),
  { selected: ['TL', 'UR'], alreadyPresent: ['FR'], missing: ['JA'] },
);

assert.match(source, /retkit-mo-add-locale-button/, 'RetKit should expose an Add Locale control');
assert.match(source, /listAvailableLocales/, 'MoEngage bridge API should expose available locales');
assert.match(source, /addLocales/, 'MoEngage bridge API should expose native locale creation');

const tools = fs.readFileSync(new URL('../bridge/src/tools/retkit-tools.mjs', import.meta.url), 'utf8');
assert.match(tools, /list_available_locales/);
assert.match(tools, /add_locale/);

console.log('✓ RetKit v0.6.0 locale discovery/add');
