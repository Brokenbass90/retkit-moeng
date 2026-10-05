import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const bridgePath = new URL('../src/moengage/native-bridge.user.js', import.meta.url);
const bridgeSource = fs.readFileSync(bridgePath, 'utf8');
const bridgeSandbox = { console, setTimeout, clearTimeout, globalThis: {} };
bridgeSandbox.globalThis.globalThis = bridgeSandbox.globalThis;
vm.createContext(bridgeSandbox);
vm.runInContext(bridgeSource, bridgeSandbox, { filename: 'native-bridge.user.js' });
const bridge = bridgeSandbox.globalThis.__RetKitMoEngageBridgeCore;
assert.ok(bridge, 'bridge core should be exposed');

// EN is pinned first; all remaining locales use requested Z -> A order.
assert.deepEqual(
  Array.from(bridge.sortLocalesForUi(['AR', 'PT', 'EN', 'ES', 'VI', 'TH', 'ID', 'FR'])),
  ['EN', 'AR', 'ES', 'FR', 'ID', 'PT', 'TH', 'VI'],
);

// Rendered/editor HTML is authoritative. Native tab metadata can lag behind after a React remount.
assert.equal(
  bridge.resolveActiveLocale('<html lang="vi">', '<html lang="en">', 'EN'),
  'VI',
);
assert.equal(
  bridge.resolveActiveLocale('', '<html lang="ar">', 'EN'),
  'AR',
);
assert.equal(
  bridge.resolveActiveLocale('', '', 'FR'),
  'FR',
);

// Locale UI lives in its own row instead of being injected into the main toolbar.
assert.match(bridgeSource, /localeRow:\s*'retkit-mo-locale-row'/);
assert.match(bridgeSource, /bar\.insertAdjacentElement\('afterend',\s*row\)/);
assert.doesNotMatch(bridgeSource, /bar\.insertBefore\(strip,/);

// The bridge must not run a document-wide mutation observer that repeatedly scans all div/span nodes.
assert.doesNotMatch(bridgeSource, /new MutationObserver\(scheduleBridgeRefresh\)/);
assert.doesNotMatch(bridgeSource, /bridgeObserver\.observe\(document\.documentElement/);

console.log('✓ RetKit v0.5.4 bridge regressions');
