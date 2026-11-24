// Мост UCC → MoEngage: скрипт RetKit UCC Export на двух «вкладках» с общим хранилищем
// Tampermonkey + модуль ucc-import в RetKit for MoEngage (на фейках MoEngage).
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const uccSrc = fs.readFileSync(new URL('../src/ucc/retkit-ucc-export.user.js', import.meta.url), 'utf8');
const importSrc = fs.readFileSync(new URL('../src/moengage/ucc-import.js', import.meta.url), 'utf8');
const mapFile = JSON.parse(fs.readFileSync(new URL('../tools/ucc-footer-map.json', import.meta.url), 'utf8'));
const tick = () => new Promise((r) => setTimeout(r, 0));

// Общее хранилище GM: слушатели получают remote=true, если писала другая вкладка.
const store = {};
const listeners = [];
function gmFor(tab) {
  return {
    GM_getValue: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
    GM_setValue: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); for (const l of listeners) if (l.k === k) setTimeout(() => l.fn(k, null, JSON.parse(JSON.stringify(v)), l.tab !== tab), 0); },
    GM_addValueChangeListener: (k, fn) => { listeners.push({ k, fn, tab }); },
    GM_listValues: () => Object.keys(store),
    GM_deleteValue: (k) => { delete store[k]; },
  };
}
function fakeDom() {
  const nodes = [];
  const make = (tag) => {
    const n = { tag, style: {}, dataset: {}, children: [], textContent: '', id: '', listeners: {}, isConnected: true,
      appendChild(c) { this.children.push(c); return c; }, append(...c) { this.children.push(...c); }, insertBefore(c) { this.children.push(c); },
      addEventListener(t, f) { this.listeners[t] = f; }, remove() { this.removed = true; this.isConnected = false; }, click() {} };
    nodes.push(n); return n;
  };
  return { nodes, document: { getElementById: (id) => nodes.find((n) => n.id === id && !n.removed) || null, createElement: make, createTextNode: (t) => ({ t }), body: make('body') } };
}
function tab(host, pathname, extra = {}) {
  const dom = fakeDom();
  const timers = [];
  const sandbox = {
    location: { host, pathname }, ...dom, ...gmFor(host),
    setInterval: (f) => { timers.push(f); return timers.length; }, setTimeout, clearTimeout, console, Promise, JSON, Date, Math,
    TextEncoder, Blob, URL, Uint8Array, Uint32Array, DataView, ArrayBuffer, alert: () => {},
    CustomEvent: class { constructor(t) { this.type = t; } }, dispatchEvent() {}, addEventListener() {},
    ...extra,
  };
  sandbox.window = sandbox; sandbox.unsafeWindow = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(uccSrc, sandbox);
  return { sandbox, dom, timers };
}

const tpl = {
  id: 15928, name: '2fa-code', email_sender_id: 1, email_category_id: 3, microservice_name: 'auth',
  microservice: { Name: 'auth', JWT: 'SECRET.JWT' },
  locales: [
    { locale: { short_name: 'en' }, subject: 'Your code', html_body: '<a href="{{embedded.domain}}/traderoom/">l</a><p>{{code}}</p>{{embedded.risk_warning}}{{embedded.company_address}}<a href="{{embedded.company_terms_link}}">T</a>' },
    { locale: { short_name: 'pt' }, subject: 'Seu código', html_body: '<p>{{code}}</p>{{embedded.risk_warning}}' },
    { locale: { short_name: 'ru' }, subject: 'Ваш код', html_body: '<p>{{code}}</p>' },
    { locale: { short_name: 'fr' }, subject: 'Code', html_body: ' ' },
  ],
};
const calls = [];
const responses = { '/api/email/templates/15928': tpl, '/api/email/senders/': [{ id: 1, email: 'noreply@iqoption.com', name: 'IQ Option' }], '/api/email/categories': [] };
const fetch = async (url, opts) => { calls.push(opts?.method || 'GET'); return { ok: url in responses, status: 200, json: async () => JSON.parse(JSON.stringify(responses[url])) }; };

// 1. Вкладка UCC: кнопки, присутствие, карта = tools/ucc-footer-map.json
const ucc = tab('ucc.int.iqoption.com', '/email-templates/15928/edit', { fetch });
const exp = ucc.sandbox.__retkitUccExport;
assert.deepEqual(JSON.parse(JSON.stringify(exp.MAP)), { replace: mapFile.replace, moengageLocales: mapFile.moengageLocales, afterTerms: mapFile.afterTerms });
assert.ok(ucc.dom.nodes.find((n) => n.id === 'retkit-ucc-pill'), 'одна кнопка RetKit');
assert.ok(!ucc.dom.nodes.find((n) => n.id === 'retkit-ucc-export' && !n.removed), 'отдельной кнопки ZIP больше нет');
await tick(); await tick();
for (const f of ucc.timers) await f();
const presence = Object.entries(store).filter(([k]) => k.startsWith('retkit.ucc.presence.')).map(([, v]) => v);
assert.equal(presence.length, 1);
assert.equal(presence[0].name, '2fa-code');
assert.equal(presence[0].microservice, 'auth');

// 2. Задание: футер, локали, Default из EN, пропуски, без JWT
const mail = await exp.collect(15928);
const t = exp.transferFor(mail);
assert.deepEqual([...t.locales.map((l) => l.mo)], ['Default', 'en_US', 'pt_PT']);
assert.deepEqual([...t.skipped], ['RU']);
assert.deepEqual([...t.empty], ['FR']);
assert.match(t.locales[1].html, /iq_risk_warning_noreg_EN.*iq_company_address_text/s);
assert.match(t.locales[1].html, /iqbroker\.co\/lp\/multilink/);
assert.match(t.locales[1].html, /iq_terms_noreg_url'\]\}\}">T<\/a><br><a data-msys-unsubscribe="1" href="\{\{ContentBlock\['iq_unsubscribe'\]\}\}"/, 'отписка сразу после Terms');
assert.match(t.locales[2].html, /iq_unsubscribe'\]\}\}"[^>]*>Manage your preference here<\/a><\/body>|iq_unsubscribe/, 'без Terms — перед </body>');
assert.equal(exp.applyFooter(t.locales[1].html, 'en').split('iq_unsubscribe').length, 2, 'не вставляется повторно');
assert.match(t.locales[2].html, /iq_risk_warning_noreg_PT/);
assert.equal(t.footerLeftovers.length, 0);
assert.equal(t.senderEmail, 'noreply@iqoption.com');
assert.ok(!JSON.stringify(t).includes('SECRET'), 'JWT не попадает в задание');

// 3. Вкладка MoEngage: RetKit (фейк API) + мост; кнопка ⇄ UCC забирает письмо и переносит
let active = 'EN'; let locales = ['EN', 'EN_US']; const htmls = {}; const subjects = {}; let addCalls = 0;
const bridgeApi = {
  listLocales: async () => [...locales],
  addLocales: async () => { addCalls += 1; return { ok: true }; },
  getActiveLocale: () => active,
  switchLocale: async (l) => { active = /^default$/i.test(l) ? 'EN' : l.toUpperCase(); return true; },
  setLocaleHtmlStable: async (l, html) => { htmls[active] = html; return { ok: true }; },
  setSubject: (s) => { subjects[active] = s; return true; },
  getSubject: () => subjects[active] || '',
  readSender: () => ({ found: true, fromEmail: 'promo@iqoption.com', senderName: 'IQ' }),
};
const mo = tab('dashboard-02.moengage.com', '/v4/campaigns/x', { __RetKitMoEngageBridgeApi: bridgeApi, __RetKitMoEngageCore: { flushBeforeLocaleSwitch: () => ({ ok: true }), setMultiLocaleBusy() {} } });
vm.runInContext(importSrc, mo.sandbox);
const imp = mo.sandbox.__RetKitUccImport;
const st = imp.status();
assert.equal(st.ready, true, st.line);
assert.match(st.line, /2fa-code · auth · INT/);

const planned = await imp.agent({});
assert.deepEqual([...planned.plan.missing], ['pt_PT']);
assert.deepEqual(locales, ['EN', 'EN_US'], 'план ничего не меняет');

// Вторая вкладка UCC с другим письмом: агенту предлагают выбрать, по id берётся нужное.
responses['/api/email/templates/777'] = { ...tpl, id: 777, name: 'mail-changing_email', microservice_name: 'core' };
const ucc2 = tab('ucc.int.iqoption.com', '/email-templates/777/edit', { fetch });
await tick(); await tick();
for (const f of ucc2.timers) await f();
const two = imp.status();
assert.equal(two.tabs.length, 2, two.line);
assert.match(two.line, /открыто писем 2/);
const choose = await imp.agent({});
assert.equal(choose.choose.length, 2);
const picked = await imp.agent({ id: 777 });
assert.equal(picked.plan.name, 'mail-changing_email');

// pt_PT нет в письме: мост локали НЕ создаёт, пишет только в существующие
const done = await imp.agent({ apply: true, id: 15928 });
assert.equal(addCalls, 0, 'локали через меню MoEngage не добавляются');
assert.equal(done.written, 2, done.lines.join('\n'));
assert.equal(done.failed, 1);
assert.ok(done.results.some((r) => r.locale === 'pt_PT' && !r.ok));
assert.deepEqual(locales, ['EN', 'EN_US']);
assert.match(htmls.EN, /noreg_EN/);
assert.match(htmls.EN, /data-msys-unsubscribe="1"[^>]*style="color: #[0-9a-f]{3,6};/, 'отписка цветом фона');
assert.equal(subjects.EN_US, 'Your code');
assert.equal(active, 'EN', 'вернулись на исходную локаль');
assert.ok(calls.every((m) => m === 'GET'), 'в UCC только GET');

// Есть все локали → всё переносится
locales.push('PT_PT');
const full = await imp.agent({ apply: true, id: 15928 });
assert.equal(full.ok, true, full.lines.join('\n'));
assert.equal(full.written, 3);
assert.match(htmls.PT_PT, /noreg_PT/);
assert.equal(subjects.PT_PT, 'Seu código');

// Вкладка не переключилась → в чужую локаль не пишем
const before = htmls.EN;
bridgeApi.switchLocale = async () => true; // «переключилась», но active остаётся
active = 'EN';
const guard = await imp.agent({ apply: true, id: 15928 });
assert.ok(guard.results.some((r) => r.locale === 'pt_PT' && !r.ok && /не открылась вкладка/.test(r.reason)));
bridgeApi.switchLocale = async (l) => { active = /^default$/i.test(l) ? 'EN' : l.toUpperCase(); return true; };

// MoEngage переключил вкладку, но switch вернул false (как в живом пилоте 23.11) → пишем, вкладка верная
bridgeApi.switchLocale = async (l) => { active = /^default$/i.test(l) ? 'EN' : l.toUpperCase(); return false; };
const falsy = await imp.agent({ apply: true, id: 15928 });
assert.equal(falsy.ok, true, falsy.lines.join('\n'));
bridgeApi.switchLocale = async (l) => { active = /^default$/i.test(l) ? 'EN' : l.toUpperCase(); return true; };

// 4. Ошибка одной локали не останавливает остальные
bridgeApi.setLocaleHtmlStable = async () => (active === 'PT_PT' ? { ok: false, reason: 'MoEngage did not keep the HTML' } : { ok: true });
const partial = await imp.agent({ apply: true, id: 15928 });
assert.equal(partial.written, 2);
assert.equal(partial.failed, 1);
assert.ok(partial.lines.some((l) => l.includes('pt_PT') && l.includes('did not keep')));

// 5. Агент через agent-relay: ucc_status в статусе
// 6. UCC INT → UCC PROD: вкладка PROD получает письмо и вставляет в ОТКРЫТУЮ локаль (без сохранения)
{
  const ed = { v: 'old', setValue(v) { this.v = v; }, getValue() { return this.v; } };
  const subj = { value: 'old subj', events: [], closest: () => ({ innerText: 'Subject' }), dispatchEvent(e) { this.events.push(e.type); } };
  class HTMLInputElement {}
  Object.defineProperty(HTMLInputElement.prototype, 'value', { set(v) { this._v = v; }, get() { return this._v; }, configurable: true });
  const prodResponses = { ...responses, '/api/email/templates/4097': { ...tpl, id: 4097 } };
  const prodFetch = async (url, opts) => { calls.push(opts?.method || 'GET'); return { ok: url in prodResponses, status: 200, json: async () => JSON.parse(JSON.stringify(prodResponses[url])) }; };
  const confirms = [];
  const prod = tab('ucc.iqoption.com', '/email-templates/4097/edit', {
    fetch: prodFetch, ace: { edit: () => ed }, HTMLInputElement, Event: class { constructor(t) { this.type = t; } },
    confirm: (m) => { confirms.push(m); return true; },
  });
  prod.sandbox.document.querySelector = (q) => (q === '.ant-tabs-tab-active' ? { innerText: 'PT' } : q === '.ace_editor' ? {} : null);
  prod.sandbox.document.querySelectorAll = (q) => (q === 'input' ? [subj] : []);
  Object.setPrototypeOf(subj, HTMLInputElement.prototype);
  for (const f of prod.timers) await f();
  await tick(); await tick();
  for (const f of ucc.timers) await f();
  // INT видит PROD-вкладку в своём меню и отправляет
  const intPresence = Object.values(store).filter((v) => v && v.host === 'ucc.iqoption.com' && v.id);
  assert.equal(intPresence.length, 1, 'INT видит вкладку PROD');
  const pill = ucc.dom.nodes.find((n) => n.id === 'retkit-ucc-pill' && !n.removed);
  pill.onclick();
  const prodItem = ucc.dom.nodes.filter((n) => typeof n.onclick === 'function').find((n) => n.children.some((c) => /^PROD:/.test(c.textContent || '')));
  assert.ok(prodItem, 'в меню INT есть пункт «PROD: …»');
  await prodItem.onclick();
  await tick(); await tick(); await tick();
  const insert = prod.dom.nodes.filter((n) => typeof n.onclick === 'function').find((n) => n.children.some((c) => /Вставить в открытую локаль PT/.test(c.textContent || '')));
  assert.ok(insert, 'на PROD появилось «Вставить в открытую локаль PT»');
  const before = calls.length;
  insert.onclick();
  assert.equal(ed.v, tpl.locales[1].html_body, 'HTML PT вставлен как есть (без замены футера)');
  assert.equal(subj._v, 'Seu código', 'Subject PT вставлен');
  assert.ok(subj.events.includes('input'), 'React узнал о новой теме');
  assert.equal(confirms.length, 1, 'на PROD спрашивает подтверждение');
  assert.ok(calls.slice(before).every((m) => m === 'GET'), 'ничего не сохраняет');
}

console.log('✓ ucc bridge: две вкладки через хранилище TM, присутствие, задание, перенос локалей + Subject + отправитель, ошибки по локали, только GET');
