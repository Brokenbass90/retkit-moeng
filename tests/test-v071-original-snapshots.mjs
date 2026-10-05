import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/backup/original-snapshots.js', import.meta.url), 'utf8');
const sandbox = { TextEncoder, URL, Date };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const api = sandbox.__RetKitOriginals;
assert.ok(api, 'module must expose __RetKitOriginals');

// Campaign key: the 24-hex campaign id wins over wizard steps / query noise.
const id = '65a1b2c3d4e5f60718293a4b';
assert.equal(api.campaignKeyFromUrl(`https://dashboard-02.moengage.com/v4/#/email/${id}/edit?step=2`), `campaign:${id}`);
assert.equal(api.campaignKeyFromUrl(`https://dashboard-02.moengage.com/v4/#/email/${id.toUpperCase()}/content`), `campaign:${id}`);
assert.match(api.campaignKeyFromUrl('https://dashboard-02.moengage.com/x/y?z=1'), /^path:\/x\/y\?z=1/);

// Only the FIRST version is kept; later captures never overwrite it.
let clock = 1_000;
const store = api.createStore({ backend: api.memoryBackend(), now: () => clock, version: 't' });
const first = await store.captureIfMissing({ campaign: 'c1', locale: 'en', html: '<p>v1</p>' });
assert.equal(first.captured, true);
clock += 10;
const second = await store.captureIfMissing({ campaign: 'c1', locale: 'EN', html: '<p>v2</p>' });
assert.equal(second.captured, false, 'second capture for the same campaign+locale must not overwrite');
assert.equal((await store.get('c1', 'en')).html, '<p>v1</p>');
assert.equal(await store.get('c1', 'ar'), null, 'locales are independent');

// Empty HTML is never stored.
assert.equal((await store.captureIfMissing({ campaign: 'c1', locale: 'ar', html: '   ' })).captured, false);

// Concurrent captures for one key store exactly one snapshot.
const both = await Promise.all([
  store.captureIfMissing({ campaign: 'c2', locale: 'en', html: '<p>a</p>' }),
  store.captureIfMissing({ campaign: 'c2', locale: 'en', html: '<p>b</p>' }),
]);
assert.equal(both[0], both[1], 'second concurrent capture joins the first one');
assert.equal((await store.get('c2', 'en')).html, '<p>a</p>');

// Pruning: expired entries go, the in-use key is protected, caps are honoured.
const day = 24 * 60 * 60 * 1000;
const now = 100 * day;
const entries = [
  { key: 'old', lastSeenAt: now - 20 * day, bytes: 10 },
  { key: 'inuse', lastSeenAt: now - 30 * day, bytes: 10 },
  { key: 'a', lastSeenAt: now - 3 * day, bytes: 600 },
  { key: 'b', lastSeenAt: now - 2 * day, bytes: 600 },
  { key: 'c', lastSeenAt: now - 1 * day, bytes: 600 },
];
const limits = { ttlMs: 14 * day, maxEntries: 10, maxBytes: 1300 };
assert.deepEqual([...api.planPrune(entries, now, limits, 'inuse')].sort(), ['a', 'old']);
assert.deepEqual([...api.planPrune(entries, now, { ...limits, maxEntries: 2, maxBytes: 1e9 }, 'inuse')].sort(), ['a', 'b', 'old']);

// Restore hands exact original bytes to the next equivalent commit only.
const eq = (a, b) => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
api.pendingExactRestore = { html: '<p>orig</p>', at: Date.now() };
assert.equal(api.takeExactRestore('<p>other</p>', eq), null, 'unrelated commit does not consume the restore');
assert.equal(api.takeExactRestore('<p>\n  orig\n</p>', eq), '<p>orig</p>');
assert.equal(api.pendingExactRestore, null);

// captureBeforeCommit uses the bridge context, explicit locale wins.
api.store = store;
api.contextProvider = () => ({ campaign: 'c3', locale: 'EN' });
await api.captureBeforeCommit('<p>c3-en</p>');
await api.captureBeforeCommit('<p>c3-ar</p>', { locale: 'AR' });
assert.equal((await store.get('c3', 'en')).html, '<p>c3-en</p>');
assert.equal((await store.get('c3', 'ar')).html, '<p>c3-ar</p>');

// The core captures BEFORE it writes into MoEngage, and never in MoEngage localStorage.
const core = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const commitBody = core.slice(core.indexOf('async function commitThroughFroala'), core.indexOf('function getSourcePreviewFrame'));
assert.ok(commitBody.indexOf('captureBeforeCommit') < commitBody.indexOf('writeNativeEditorValue(native, next)'), 'snapshot must be taken before the first write');
assert.doesNotMatch(source, /localStorage\s*[.[]/, 'snapshots must not use MoEngage localStorage');
console.log('✓ original snapshots: first-version only, per locale, auto-prune, exact restore');
