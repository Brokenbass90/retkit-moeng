import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const coreSource = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const bridgeSource = fs.readFileSync(new URL('../src/retkit-moengage-v0.5.user.js', import.meta.url), 'utf8');


const sandbox = { console, globalThis: null, location: { hostname: 'not-moengage.invalid' }, TextEncoder, Uint8Array, DataView, Date, Math, Set, Map };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(bridgeSource, sandbox, { filename: 'retkit-moengage-v0.5.user.js' });
const bridgeCore = sandbox.__RetKitMoEngageBridgeCore;
assert.equal(typeof bridgeCore.buildStoredZip, 'function', 'ZIP builder should be available to regression tests');
const zip = bridgeCore.buildStoredZip([{ name: 'backup/EN/index.html', text: '<html lang="en">ok</html>' }]);
assert.equal(zip[0], 0x50, 'ZIP should start with P');
assert.equal(zip[1], 0x4b, 'ZIP should start with PK');
assert.ok(Buffer.from(zip).includes(Buffer.from('backup/EN/index.html')), 'ZIP should contain the locale index path');
assert.equal(bridgeCore.safeBackupName(' My / backup '), 'My-backup');

// Locale backup: a compact download button next to + Locale and a ZIP containing <name>/<locale>/index.html.
assert.match(bridgeSource, /backupLocalesButton/, 'v0.6.8 should define a locale backup toolbar button');
assert.match(bridgeSource, /downloadLocaleBackup/, 'v0.6.8 should implement locale backup download');
assert.match(bridgeSource, /buildStoredZip|createStoredZip/, 'locale backup should build a ZIP in-browser without an external dependency');
assert.match(bridgeSource, /index\.html/, 'locale backup should write an index.html per locale');
assert.match(bridgeSource, /readNativeLocaleHtmlFast/, 'locale backup should read every locale through the lightweight native reader');
assert.match(bridgeSource, /prompt\(/, 'locale backup should ask for a folder/archive name');

// Across-locales UI must expose match counts, not just how many locales matched.
const rowsStart = coreSource.indexOf('function renderMultiLocalePlanRows');
const rowsEnd = coreSource.indexOf('\n  function updateMultiLocaleRowState', rowsStart);
const rowsBody = coreSource.slice(rowsStart, rowsEnd);
assert.match(rowsBody, /totalMatches|selectedMatches/, 'Across locales should calculate selected match totals');
assert.match(rowsBody, /item\.count/, 'each locale chip should visibly use its exact match count');
assert.match(rowsBody, /Replace .*match/i, 'bulk action label should state how many matches will be replaced');

// Bulk replace must re-read each locale immediately before replacing so a stale scan snapshot cannot block it.
const applyStart = coreSource.indexOf('async function applyMultiLocaleReplace');
const applyEnd = coreSource.indexOf('\n  async function rollbackMultiLocaleReplace', applyStart) > 0
  ? coreSource.indexOf('\n  async function rollbackMultiLocaleReplace', applyStart)
  : coreSource.indexOf('\n  async function refreshLocaleManager', applyStart);
const applyBody = coreSource.slice(applyStart, applyEnd);
assert.match(applyBody, /readLocaleHtmlFast/, 'bulk apply should read fresh native HTML for every locale');
assert.doesNotMatch(applyBody, /expectedBefore/, 'bulk apply must not reject because the HTML changed after scan');
assert.doesNotMatch(applyBody, /verifyLocaleHtmlFast/, 'bulk apply should not perform a second full verification pass');
assert.match(applyBody, /replaceAllLiteral\(currentHtml|replaceAllLiteral\(freshHtml/, 'bulk apply should replace against the freshly read HTML');

// Locale creation now deliberately hands final confirmation to native MoEngage.
assert.match(bridgeSource, /handOffNativeLocaleAdd/, 'locale add should retain the native picker handoff');
const addStart = bridgeSource.indexOf('async function addNativeLocales');
const addEnd = bridgeSource.indexOf('\n  function findNativeRemoveLocaleControl', addStart);
const addBody = bridgeSource.slice(addStart, addEnd);
assert.doesNotMatch(addBody, /waitForOpenAddLocaleAction\(/, 'locale add should no longer depend on brittle footer-action discovery');

console.log('✓ RetKit v0.6.8 locale backup + counted fresh bulk replace contracts');
