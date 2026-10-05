import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const coreSource = fs.readFileSync('src/core/retkit-moengage-core.user.js', 'utf8');
const bridgeSource = fs.readFileSync('src/moengage/native-bridge.user.js', 'utf8');

// History/snapshot UI is intentionally removed; browser/editor undo is the fallback.
assert.doesNotMatch(coreSource, /makeButton\('History ▾'/, 'History toolbar button must be removed');
assert.doesNotMatch(coreSource, /historyPopover/, 'History popover code must be removed');
assert.doesNotMatch(coreSource, /snapshotStorageKey|readSnapshots|saveSnapshot/, 'persistent snapshot history must be removed');

// Locale backup must be explicitly styled and labelled, never an unstyled browser-default white square.
assert.match(bridgeSource, /#\$\{IDS\.backupLocalesButton\}\s*\{[^}]*height:\s*30px[^}]*display:\s*inline-flex/s, 'backup button should have explicit dimensions/layout');
assert.match(bridgeSource, /#\$\{IDS\.backupLocalesButton\}\s+svg\s*\{[^}]*width:/s, 'backup SVG must have explicit icon sizing');
assert.match(bridgeSource, /Backup ZIP|Download ZIP/, 'backup button should include a visible text label');

// Multi-locale progress should be inline/subtle, not a full-screen dimming overlay.
assert.doesNotMatch(coreSource, /#\$\{IDS\.multiLocaleLoading\}\s*\{[^}]*position:\s*absolute[^}]*inset:/s, 'multi-locale loader must not cover the workspace');
assert.match(coreSource, /drawer\.appendChild\(loading\)|drawer\.prepend\(loading\)|insertBefore\(loading/s, 'multi-locale loader should live inside the find/replace drawer');

// Native locale option activation should prefer the semantic row/label over a hidden checkbox input.
const sandbox = { globalThis: {}, console, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
vm.runInNewContext(bridgeSource, sandbox, { filename: 'native-bridge.user.js' });
const bridgeCore = sandbox.__RetKitMoEngageBridgeCore;
assert.equal(typeof bridgeCore?.localeAddActivationTarget, 'function', 'bridge core must expose localeAddActivationTarget');
const checkbox = { tagName: 'INPUT' };
const row = { tagName: 'LABEL' };
assert.equal(bridgeCore.localeAddActivationTarget({ control: checkbox, row }), row, 'locale add should prefer the row/label target');
assert.equal(bridgeCore.localeAddActivationTarget({ control: checkbox, row: null }), checkbox, 'checkbox remains a fallback');

console.log('✓ RetKit v0.6.10 history cleanup + subtle progress + locale activation contracts');
