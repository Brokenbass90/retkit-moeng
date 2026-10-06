import assert from 'node:assert/strict';
import fs from 'node:fs';

const core = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');
const between = (src, from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} must exist`);
  return src.slice(a, b);
};

// Clicking a locale tab first saves the open locale; a failed save stops the switch.
const tabClick = between(bridge, "tab.addEventListener('click', async () => {", 'const wrap = document.createElement');
const flushAt = tabClick.indexOf('flushBeforeLocaleSwitch');
const switchAt = tabClick.indexOf('switchNativeLocale(locale)');
assert.ok(flushAt > 0 && switchAt > flushAt, 'flush runs before the native switch');
assert.match(tabClick, /flush\.ok === false[\s\S]*?return;/, 'failed flush keeps the user on the locale');

const flush = between(core, 'async function flushBeforeLocaleSwitch', 'function rebindNativeEditorFromMoEngage');
assert.match(flush, /clearTimeout\(STATE\.syncTimer\)/, 'pending idle sync is taken over');
assert.match(flush, /while \(STATE\.applying/, 'waits for an in-flight write');
assert.match(flush, /pushOverlayToNative\(true\)/, 'writes the edit now');
assert.match(flush, /locale_switch_blocked_unsaved/, 'blocked switch reaches Diagnostics');
assert.match(core, /flushBeforeLocaleSwitch: \(options\) => flushBeforeLocaleSwitch\(options\)/, 'exposed to the bridge');

// Rebind never silently drops an unsaved edit: it is stashed per locale and restored.
const rebind = between(core, 'function rebindNativeEditorFromMoEngage', 'function currentBridgeLocale');
const stashAt = rebind.indexOf('unsavedByLocale = {');
const overwriteAt = rebind.indexOf('overlay.setValue(next)');
assert.ok(stashAt > 0 && overwriteAt > stashAt, 'stash happens before the editor is overwritten');
assert.match(rebind, /locale\.unsaved\.restored/, 'coming back restores the stash');
assert.match(rebind, /scheduleNativeSync\(300\)/, 'restored edit is saved again');

console.log('✓ RetKit v0.8.5 locale switch saves first, never drops an unsaved edit');

// Slow MoEngage settle is not a rejection.
const commit = between(core, 'async function commitThroughFroala', 'function describeHtmlDifference');
assert.match(commit, /for \(let waited = 0; !ok && waited < 3000/, 'commit waits up to 3s more before calling it rejected');
assert.match(commit, /sync\.settled-late/, 'late settle is visible in Diagnostics');
console.log('✓ RetKit v0.8.5 slow MoEngage settle is not a rejection');
