import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const coreSource = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const bridgeSource = fs.readFileSync(new URL('../src/retkit-moengage-v0.5.user.js', import.meta.url), 'utf8');
const diagnosticsSource = fs.readFileSync(new URL('../src/diagnostics/incident-recorder.js', import.meta.url), 'utf8');
const distSource = fs.readFileSync(new URL('../dist/retkit-moengage.user.js', import.meta.url), 'utf8');

// 1) Core must not reference bridge-private helpers. This exact cross-IIFE leak
// broke Across locales at runtime with `getOverlayEditor is not defined`.
assert.doesNotMatch(coreSource, /\bgetOverlayEditor\b/, 'core must not reference bridge-private getOverlayEditor');
assert.match(coreSource, /captureEditorViewState[\s\S]*STATE\.overlayEditor/, 'viewport capture must use the core-owned overlay editor');

// The assembled userscript must preserve that isolation after build too.
const assembledCoreStart = distSource.indexOf('(function (root) {', distSource.indexOf('function sanitizeMeta'));
const assembledBridgeStart = distSource.lastIndexOf('(function (root) {');
const assembledCore = distSource.slice(assembledCoreStart, assembledBridgeStart);
assert.doesNotMatch(assembledCore, /\bgetOverlayEditor\b/, 'assembled core section must not depend on bridge-private helpers');

// 2) Backup is intentionally rolled back to the known-working one-click ZIP flow.
const backupStart = bridgeSource.indexOf('async function downloadLocaleBackup');
const backupEnd = bridgeSource.indexOf('\n  function workspaceStatus', backupStart);
const backupBody = bridgeSource.slice(backupStart, backupEnd);
assert.ok(backupStart >= 0 && backupEnd > backupStart, 'downloadLocaleBackup should exist');
assert.match(backupBody, /buildStoredZip\(entries\)/, 'backup should build the locale ZIP in-browser');
assert.match(backupBody, /link\.click\(\)/, 'backup should download in the same click flow');
assert.doesNotMatch(backupBody, /preparedLocaleBackup|Backup ready|click Download/, 'two-step prepared backup regression must stay removed');
assert.match(bridgeSource, /Backup ZIP/, 'backup control should have a clear text label');

// 2b) Stable locale writes must accept Froala-equivalent formatting rather than
// requiring byte-for-byte equality after MoEngage normalizes the HTML.
const stableStart = bridgeSource.indexOf('async function setNativeLocaleHtmlStable');
const stableEnd = bridgeSource.indexOf('\n  async function verifyNativeLocaleHtmlFast', stableStart);
const stableBody = bridgeSource.slice(stableStart, stableEnd);
assert.match(stableBody, /htmlEquivalentForSync|shouldSkipNativeCommit/, 'stable locale writer should compare semantic/equivalent HTML');
assert.doesNotMatch(stableBody, /getNativeEditorOutsideWorkspace\(\)\?\.getValue\?\.\(\) \|\| ''\) === next/, 'stable writer must not require exact byte equality after Froala normalization');

// 3) Native add handoff must not manufacture a red timeout failure.
const handoffStart = bridgeSource.indexOf('async function handOffNativeLocaleAdd');
const handoffEnd = bridgeSource.indexOf('\n  async function addNativeLocales', handoffStart);
const handoffBody = bridgeSource.slice(handoffStart, handoffEnd);
assert.ok(handoffStart >= 0 && handoffEnd > handoffStart, 'handOffNativeLocaleAdd should exist');
assert.doesNotMatch(handoffBody, /setTimeout\([^\n]*60000|locale_add_native_assist_incomplete|MoEngage did not add:/s, 'manual native add handoff must not time out into a false red error');
assert.match(handoffBody, /Refresh locales|not detected yet|still waiting/i, 'manual return should use a neutral refresh/pending message if the locale is not yet visible');

// 4) Diagnostics incidents must be scoped to the installed RetKit version so
// an old v0.6.13 incident cannot masquerade as a v0.6.17 failure.
assert.match(diagnosticsSource, /setVersion|versionKey|diagnostics-version/i, 'diagnostics recorder should track the active RetKit version');
assert.match(diagnosticsSource, /removeItem\?\.\(key\)|writeIncidents\(\[\]\)|clearIncidents/i, 'changing version should clear persisted incidents from the previous release');


const diagSandbox = { console, globalThis: null, location: { pathname: '/test' } };
diagSandbox.globalThis = diagSandbox;
vm.createContext(diagSandbox);
vm.runInContext(diagnosticsSource, diagSandbox, { filename: 'incident-recorder.js' });
const store = new Map();
const storage = {
  getItem: (key) => store.has(key) ? store.get(key) : null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
const recorder = diagSandbox.__RetKitDiagnostics.createRecorder({ storage, storageKey: 'incidents', versionKey: 'version' });
recorder.setVersion('0.6.15');
recorder.incident('old', 'old incident');
assert.equal(recorder.getSummary().count, 1);
recorder.setVersion('0.6.17');
assert.equal(recorder.getSummary().count, 0, 'installing a new RetKit version should drop persisted incidents from the previous version');

// 5) Existing sync no-op stability remains available in the assembled build.
const sandbox = { console, globalThis: null, location: { hostname: 'not-moengage.invalid' }, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(distSource, sandbox, { filename: 'retkit-moengage.user.js' });
assert.equal(typeof sandbox.__RetKitMoEngageCore?.shouldSkipNativeCommit, 'function');
assert.equal(sandbox.__RetKitMoEngageCore.shouldSkipNativeCommit({ localHtml: '<p>Same</p>', nativeHtml: '<p>Same</p>' }), true);

console.log('✓ RetKit v0.6.17 recovery runtime contracts');
