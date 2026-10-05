import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sourcePath = new URL('../src/moengage/native-bridge.user.js', import.meta.url);
const source = fs.readFileSync(sourcePath, 'utf8');

const sandbox = { console, setTimeout, clearTimeout, globalThis: {} };
sandbox.globalThis.globalThis = sandbox.globalThis;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'native-bridge.user.js' });

const core = sandbox.globalThis.__RetKitMoEngageBridgeCore;
assert.ok(core, 'bridge core should be exposed');

// Locale filtering: RetKit controls like RK must never become a locale.
assert.deepEqual(
  Array.from(core.filterKnownLocales(['RK', 'EN', 'Default', 'AR', 'ES', 'XX', 'PT'])),
  ['EN', 'AR', 'ES', 'PT'],
);

// Native Default is English for the UI, and English is always first.
assert.equal(core.displayLocale('DEFAULT'), 'EN');
assert.equal(core.displayLocale('EN'), 'EN');
assert.deepEqual(
  Array.from(core.sortLocalesForUi(['AR', 'PT', 'EN', 'ES', 'VI', 'TH', 'ID', 'FR'])),
  ['EN', 'AR', 'ES', 'FR', 'ID', 'PT', 'TH', 'VI'],
);

// EN must be able to target either an explicit EN tab or MoEngage's Default tab.
assert.deepEqual(Array.from(core.localeAliases('EN')), ['EN', 'DEFAULT']);
assert.deepEqual(Array.from(core.localeAliases('DEFAULT')), ['DEFAULT', 'EN']);
assert.deepEqual(Array.from(core.localeAliases('AR')), ['AR']);

// RTL still remains conservative and only modifies Arabic text paths.
const rtl = core.transformRtlHtml(`
<table><tr><td style="text-align: left"><p style="text-align:left">مرحبا <b>بك</b></p><p style="text-align:left">English</p></td></tr></table>`);
assert.equal(rtl.paragraphCount, 1);
assert.equal(rtl.cellCount, 1);
assert.match(rtl.html, /<p[^>]*dir="rtl"[^>]*style="text-align:\s*right"[^>]*>مرحبا/);
assert.match(rtl.html, /<p style="text-align:left">English<\/p>/);

assert.match(source, /@version\s+\d+\.\d+\.\d+/);
assert.match(source, /function findNativeLocaleBar\(/);
assert.match(source, /function discoverNativeLocaleTabs\(/);
assert.match(source, /function findTestCampaignSection\(/);
assert.doesNotMatch(source, /rk-v050-popover[^\n]*MoEngage locales/, 'locale UI should no longer be a popover');

console.log('✓ RetKit locale/RTL bridge regressions');
