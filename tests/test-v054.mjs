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

// Product rule in current build: English is pinned first, remaining locale codes are A -> Z.
assert.deepEqual(
  Array.from(bridge.sortLocalesForUi(['AR', 'PT', 'EN', 'ES', 'VI', 'TH', 'ID', 'FR'])),
  ['EN', 'AR', 'ES', 'FR', 'ID', 'PT', 'TH', 'VI'],
);

// RTL must still be available when MoEngage selected-state metadata lags,
// as long as the actually loaded HTML is Arabic.
assert.equal(
  bridge.shouldAllowRtlFix('FR', '<html lang="ar"><body><p>مرحبا</p></body></html>'),
  true,
);
assert.equal(
  bridge.shouldAllowRtlFix('FR', '<html lang="fr"><body><p>Bonjour</p></body></html>'),
  false,
);

// Test-send preferences support an explicit subset of locales.
assert.deepEqual(
  JSON.parse(JSON.stringify(bridge.normaliseTestPreferences({
    email: ' qa@example.com ',
    locales: ['AR', 'ES', 'AR', 'DEFAULT'],
    personalise: false,
  }))),
  { email: 'qa@example.com', locales: ['AR', 'ES', 'EN'], personalise: false, sendVia: 'Email ID (Non-registered users)' },
);

// v0.5.4 should keep RetKit mounted when native locale changes.
assert.match(bridgeSource, /rebindNativeEditorFromMoEngage/);
const rebindBlock = bridgeSource.slice(bridgeSource.indexOf('async function rebindWorkspaceAfterLocaleChange'), bridgeSource.indexOf('function setLocaleLoading'));
assert.doesNotMatch(rebindBlock, /close\?\.click\(\)/, 'locale switching must not close/reopen RetKit');
assert.match(bridgeSource, /localeLoading:\s*'retkit-mo-locale-loading'/);

// Locales and subject each get their own secondary row.
assert.match(bridgeSource, /subjectRow:\s*'retkit-mo-subject-row'/);
assert.match(bridgeSource, /subjectInput:\s*'retkit-mo-subject-input'/);
assert.match(bridgeSource, /function findNativeSubjectInput\(/);
assert.match(bridgeSource, /function syncSubjectFromMoEngage\(/);

// Test UI supports picking any subset rather than only current/all.
assert.match(bridgeSource, /data-test-locales/);
assert.match(bridgeSource, /function renderTestLocaleChoices\(/);
assert.match(bridgeSource, /async function selectExplicitTestLocales\(/);

// Save / Apply now are no longer top-level buttons; auto-apply remains the workflow.
assert.doesNotMatch(coreSource, /makeButton\('Save'/);
assert.doesNotMatch(coreSource, /makeButton\('Apply now'/);

assert.match(bridgeSource, /@version\s+0\.6\.31/);
assert.match(coreSource, /@version\s+0\.6\.31/);

console.log('✓ RetKit v0.5.4 product regressions');
