import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const bridgeSource = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');

function functionBody(source, name) {
  const startCandidates = [`async function ${name}`, `function ${name}`]
    .map((needle) => source.indexOf(needle))
    .filter((index) => index >= 0);
  assert.ok(startCandidates.length, `${name} should exist`);
  const start = Math.min(...startCandidates);
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `${name} should have a body`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not parse ${name}`);
}

// The live MoEngage DOM snapshot shows a stable native Test Campaign root and
// a stable data-testid on its locale dropdown. RetKit should prefer those over
// text/geometry inference.
const testSectionBody = functionBody(bridgeSource, 'findTestCampaignSection');
assert.match(testSectionBody, /\.test_email_wrapper[\s\S]*\.mds-test__wrapper/, 'Test Campaign should prefer its native wrapper selector');
assert.match(bridgeSource, /function findTestCampaignLocaleControl\(/, 'a dedicated native Test Campaign locale control helper should exist');
assert.match(bridgeSource, /test-campaign-variation-locale-dropdown/, 'locale selection should use the live MoEngage data-testid');

// The stable live-DOM selector remains the entry point; locale interaction
// strategy is covered by the v0.6.21 restore-working regression.
const selectBody = functionBody(bridgeSource, 'selectExplicitTestLocales');
assert.match(selectBody, /findTestCampaignLocaleControl/, 'test locale selection should use the dedicated live-DOM locator');

// Backup must catch locale discovery failures (the old one-click version called
// discovery before try/catch, which produced no diagnostic and no download).
const backupBody = functionBody(bridgeSource, 'downloadLocaleBackup');
const tryIndex = backupBody.indexOf('try {');
const discoveryIndex = backupBody.indexOf('discoverNativeLocalesDeep');
assert.ok(tryIndex >= 0 && discoveryIndex > tryIndex, 'backup locale discovery must run inside the protected try path');
assert.match(backupBody, /knownLocaleBackupFallback/, 'backup should fall back to the RetKit locale strip');
assert.match(backupBody, /showSaveFilePicker|createWritable/, 'Chrome backup should reserve a real save destination while the user click is active');
assert.match(backupBody, /diagIncident\('locale_backup_failed'/, 'backup failure must be visible in Diagnostics');

// Browser bridge diagnostics: failed native Test Campaign actions should create
// a real incident instead of only writing a transient workspace status.
assert.match(bridgeSource, /test_campaign_failed/, 'Send test failures should be retained in Diagnostics');

// Verify the live-DOM locale selector behavior without needing a browser DOM.
const sandbox = {
  console,
  globalThis: null,
  location: { hostname: 'not-moengage.invalid' },
  TextEncoder,
  Uint8Array,
  DataView,
  Date,
  Math,
  Set,
  Map,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(bridgeSource, sandbox, { filename: 'native-bridge.user.js' });
const bridgeCore = sandbox.__RetKitMoEngageBridgeCore;
assert.equal(typeof bridgeCore?.findTestCampaignLocaleControl, 'function');
const liveControl = { marker: 'live-locale-control' };
const fakeSection = {
  querySelector(selector) {
    if (selector === '[data-testid="test-campaign-variation-locale-dropdown"]') return liveControl;
    return null;
  },
};
assert.equal(bridgeCore.findTestCampaignLocaleControl(fakeSection), liveControl, 'live data-testid must win over heuristic lookup');

console.log('✓ RetKit v0.6.18 live MoEngage DOM repair contracts');
