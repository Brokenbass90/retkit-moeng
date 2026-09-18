import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const bridgePath = new URL('../src/retkit-moengage-v0.5.user.js', import.meta.url);
const bridgeSource = fs.readFileSync(bridgePath, 'utf8');
const corePath = new URL('../src/core/retkit-moengage-core.user.js', import.meta.url);
const coreSource = fs.readFileSync(corePath, 'utf8');

const sandbox = { console, setTimeout, clearTimeout, globalThis: {} };
sandbox.globalThis.globalThis = sandbox.globalThis;
vm.createContext(sandbox);
vm.runInContext(bridgeSource, sandbox, { filename: 'retkit-moengage-v0.5.user.js' });
const bridge = sandbox.globalThis.__RetKitMoEngageBridgeCore;
assert.ok(bridge, 'bridge core should be exposed');

// EN stays first, then locale codes are ordinary A -> Z.
assert.deepEqual(
  Array.from(bridge.sortLocalesForUi(['AR', 'PT', 'EN', 'ES', 'VI', 'TH', 'ID', 'FR'])),
  ['EN', 'AR', 'ES', 'FR', 'ID', 'PT', 'TH', 'VI'],
);

// RTL can be deliberately previewed/tested on any locale.
const forced = bridge.transformRtlHtml(
  '<table><tr><td style="text-align:left"><p style="text-align:left">Hello world</p></td></tr></table>',
  { allParagraphs: true },
);
assert.equal(forced.paragraphCount, 1);
assert.equal(forced.cellCount, 1);
assert.match(forced.html, /<p dir="rtl" style="text-align:\s*right">Hello world<\/p>/);
assert.match(forced.html, /<td dir="rtl" style="text-align:\s*right">/);

// Test preferences remember MoEngage's native Send via mode. Default is the
// useful arbitrary-address mode shown by MoEngage: Email ID (Non-registered users).
assert.deepEqual(
  JSON.parse(JSON.stringify(bridge.normaliseTestPreferences({
    email: ' qa@example.com ',
    locales: ['AR', 'DEFAULT'],
    personalise: true,
  }))),
  {
    email: 'qa@example.com',
    locales: ['AR', 'EN'],
    personalise: true,
    sendVia: 'Email ID (Non-registered users)',
  },
);
assert.equal(
  bridge.normaliseTestPreferences({ sendVia: 'Email ID (Registered users)' }).sendVia,
  'Email ID (Registered users)',
);

// Entity-decoded preview text must map to the complete encoded source text.
const html = '<p class="middle-title">Fast &amp; secure deposits &amp; withdrawals</p>';
const mapped = (() => {
  const sb = { console, setTimeout, clearTimeout, globalThis: {} };
  sb.globalThis.globalThis = sb.globalThis;
  vm.createContext(sb);
  vm.runInContext(coreSource, sb, { filename: 'retkit-moengage-core.user.js' });
  return sb.globalThis.__RetKitMoEngageCore.findRangeFromDescriptor(html, {
    tag: 'P',
    tagOccurrence: 0,
    pointText: 'Fast & secure deposits & withdrawals',
    pointTextOrdinal: 0,
    pointTextGlobalOccurrence: 0,
    pointParentTag: 'P',
    pointParentHasElementChildren: false,
    classes: ['middle-title'],
  });
})();
assert.ok(mapped);
assert.equal(html.slice(mapped.start, mapped.end), 'Fast &amp; secure deposits &amp; withdrawals');

// Product wiring for Subject and native Test Campaign Send via.
assert.match(bridgeSource, /function selectNativeSendVia\(/);
assert.match(bridgeSource, /data-send-via/);
assert.match(bridgeSource, /Email ID \(Non-registered users\)/);
assert.match(bridgeSource, /function findNativeSubjectInput\(/);
assert.match(bridgeSource, /document\.getElementById\(IDS\.testPopover\)\?\.contains\?\.\(element\)/);
assert.match(bridgeSource, /if \(isRetKitElement\(el\) \|\| localeBar/);
assert.match(bridgeSource, /@version\s+0\.6\.31/);
assert.match(coreSource, /@version\s+0\.6\.31/);

console.log('✓ RetKit v0.5.5 product regressions');
