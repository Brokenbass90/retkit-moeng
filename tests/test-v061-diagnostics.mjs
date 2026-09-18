import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/diagnostics/incident-recorder.js', import.meta.url), 'utf8');
class MemoryStorage { constructor(){ this.map=new Map(); } getItem(k){ return this.map.has(k)?this.map.get(k):null; } setItem(k,v){ this.map.set(k,String(v)); } removeItem(k){ this.map.delete(k); } }
let now = 1_700_000_000_000;
const sandbox = { console, globalThis: null, localStorage: new MemoryStorage(), Date: { now: () => now } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'incident-recorder.js' });
const api = sandbox.__RetKitDiagnostics;
assert.ok(api?.createRecorder);
const recorder = api.createRecorder({ storage: sandbox.localStorage, now: () => now, maxBreadcrumbs: 3, maxIncidents: 2, ttlMs: 1000, maxBytes: 100000 });
recorder.breadcrumb('editor.change', { revision: 1 });
recorder.breadcrumb('editor.change', { revision: 2 });
recorder.breadcrumb('editor.change', { revision: 3 });
recorder.breadcrumb('editor.change', { revision: 4 });
assert.equal(recorder.getBreadcrumbs().length, 3);
assert.equal(recorder.getSummary().count, 0, 'breadcrumbs are not persisted incidents');
recorder.incident('moengage_revert', 'reverted', { html: '<b>secret</b>', htmlLength: 13 });
let report = recorder.exportReport();
assert.equal(report.incidents.length, 1);
assert.equal(JSON.stringify(report).includes('<b>secret</b>'), false, 'HTML must be redacted by default');
recorder.incident('late_native_revert', 'reverted again', { nativeHtml: '<table>native secret</table>', localHtml: '<table>local secret</table>' });
report = recorder.exportReport();
assert.equal(JSON.stringify(report).includes('native secret'), false, 'nativeHtml must be redacted by default');
assert.equal(JSON.stringify(report).includes('local secret'), false, 'localHtml must be redacted by default');
assert.equal(report.incidents[0].context.length, 3);
recorder.incident('locale_missing', 'missing', {});
recorder.incident('preview_missing', 'missing preview', {});
assert.equal(recorder.getSummary().count, 2, 'incident ring is bounded');
now += 2000;
recorder.cleanup();
assert.equal(recorder.getSummary().count, 0, 'expired incidents are removed');


const dedupeStorage = new MemoryStorage();
now = 1_700_100_000_000;
const dedupe = api.createRecorder({
  storage: dedupeStorage,
  now: () => now,
  getLocation: () => '/campaigns/email/editor',
  maxIncidents: 25,
  ttlMs: 10_000,
  maxBytes: 100000,
  dedupeWindowMs: 5_000,
});
dedupe.incident('sync_exception', 'boom', { revision: 1 });
now += 500;
dedupe.incident('sync_exception', 'boom', { revision: 2 });
let deduped = dedupe.getIncidents();
assert.equal(deduped.length, 1, 'repeated incidents inside the dedupe window should collapse');
assert.equal(deduped[0].repeatCount, 2, 'collapsed incidents should retain a repeat counter');
assert.equal(deduped[0].page, '/campaigns/email/editor', 'incident should retain the page where it happened');
now += 6_000;
dedupe.incident('sync_exception', 'boom', { revision: 3 });
assert.equal(dedupe.getIncidents().length, 2, 'same incident outside the dedupe window should create a new record');

const dist = fs.readFileSync(new URL('../dist/retkit-moengage.user.js', import.meta.url), 'utf8');
assert.match(dist, /retkit-diagnostics-button/);
assert.match(dist, /Only anomalies are stored/);

console.log('✓ RetKit v0.6.1 diagnostics recorder');
