import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/diagnostics/function-map.js', import.meta.url), 'utf8');
class MemoryStorage { constructor(){ this.map=new Map(); } getItem(k){ return this.map.has(k)?this.map.get(k):null; } setItem(k,v){ this.map.set(k,String(v)); } removeItem(k){ this.map.delete(k); } }
let now = 1_700_000_000_000;
const timers = [];
const sandbox = { console, URL, URLSearchParams, globalThis: null, location: { href: 'https://dashboard-02.moengage.com/v4/#/campaigns/64f1a2b3c4d5e6f708091a2b/edit', pathname: '/v4/campaigns/64f1a2b3c4d5e6f708091a2b/edit', hostname: 'dashboard-02.moengage.com' }, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'function-map.js' });
const api = sandbox.__RetKitFunctionMap;
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
assert.ok(api?.createFunctionMap, 'API exposed');

// Обезличивание
assert.equal(api.describeString('boss@company.com'), '<email>');
assert.equal(api.describeString('64f1a2b3c4d5e6f708091a2b'), '<id>');
assert.equal(api.describeString('pt-BR'), 'pt-BR', 'locale codes stay');
assert.equal(api.describeString('DRAFT'), '<enum DRAFT>');
assert.equal(api.describeString('welcome'), '<text len=7>', 'plain words are content, not enums');
assert.match(api.describeString('<table><tr><td>secret</td></tr></table>'), /^<html len=/);
const s = api.shape({ token: 'SECRET', subject: 'Привет клиент', locales: [{ code: 'en', html: '<p>x</p>' }], count: 3, on: true });
const text = JSON.stringify(s);
assert.ok(!text.includes('SECRET') && !text.includes('Привет'), 'no values in shapes');
assert.equal(s.token, '<hidden>');
assert.equal(s.locales['<array>'], 1);
assert.equal(s.locales.first.code, 'en');
same(api.shapeBody('email=me%40corp.com&csrf_token=abc', 'application/x-www-form-urlencoded'), { form: { email: '<email>', csrf_token: '<hidden>' } });
assert.equal(api.routeOf('/api/campaigns/64f1a2b3c4d5e6f708091a2b/locales/123456'), '/api/campaigns/:id/locales/:id');

// Карта: ручки, связь с нажатием, слияние форм, лимиты
const storage = new MemoryStorage();
const map = api.createFunctionMap({ storage, now: () => now });
map.noteAction('+ Add locale', 'button#addLocale');
now += 400;
map.noteRequest({ via: 'fetch', method: 'POST', url: 'https://dashboard-02.moengage.com/api/campaigns/64f1a2b3c4d5e6f708091a2b/locales?auth_token=X&lang=pt-BR', request: { json: { locale: 'pt-BR' } }, status: 200, response: { json: { ok: true } }, ms: 120 });
now += 10_000;
map.noteRequest({ via: 'fetch', method: 'POST', url: 'https://dashboard-02.moengage.com/api/campaigns/aaaaaaaaaaaaaaaaaaaaaaaa/locales', request: { json: { locale: 'de', copyFrom: 'en' } }, status: 422, response: { json: { error: '<text len=12>' } } });
map.noteRequest({ via: 'xhr', method: 'GET', url: 'http://127.0.0.1:43118/health', status: 200 });
map.noteRequest({ via: 'fetch', method: 'GET', url: 'https://cdn.moengage.com/app.js', status: 200 });
const exported = map.export();
const keys = Object.keys(exported.endpoints);
same(keys, ['POST dashboard-02.moengage.com/api/campaigns/:id/locales'], 'one endpoint; bridge and assets ignored');
const e = exported.endpoints[keys[0]];
assert.equal(e.count, 2);
same(e.statuses, { 200: 1, 422: 1 });
same(e.actions, ['+ Add locale'], 'request linked to the click that caused it');
assert.ok(e.request.json.locale && e.request.json.copyFrom, 'request shapes merged');
assert.ok(e.errorResponse, 'error response kept separately');
same(e.queryKeys, ['auth_token', 'lang'], 'query keys only, no values');
assert.ok(!JSON.stringify(exported).includes('auth_token=X'));
map.noteScreen('/v4/campaigns/:id/edit', [{ tag: 'button', label: 'Send test' }]);
assert.equal(map.summary().screens, 1);
assert.equal(map.summary().controls, 1);
assert.ok(storage.getItem('retkit-function-map-v1'), 'export flushes to storage');
map.clear();
same(map.summary(), { endpoints: 0, controls: 0, screens: 0 });

// Отчёт Logs содержит карту вторым разделом
const diag = fs.readFileSync(new URL('../src/diagnostics/incident-recorder.js', import.meta.url), 'utf8');
assert.match(diag, /functionality: root\.__RetKitFunctionMap\.export\(\)/);
assert.match(diag, /Functionality map/);
const build = fs.readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
assert.match(build, /function-map\.js/);
const dist = fs.readFileSync(new URL('../dist/retkit-moengage.user.js', import.meta.url), 'utf8');
assert.ok(dist.includes('__RetKitFunctionMap'), 'map is in the built userscript');

console.log('v0.8.0 function map: ok');
