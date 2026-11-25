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
      addEventListener(t, f) { this.listeners[t] = f; }, remove() { this.removed = true; this.isConnected = false; }, click() {},
      contains(x) { return x === this || this.children.some((c) => c && typeof c.contains === 'function' && c.contains(x)); } };
    nodes.push(n); return n;
  };
  const docListeners = {};
  return { nodes, document: { docListeners, addEventListener: (t, f) => { docListeners[t] = f; }, getElementById: (id) => nodes.find((n) => n.id === id && !n.removed) || null, createElement: make, createTextNode: (t) => ({ t }), body: make('body') } };
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
// 6. UCC INT → UCC PROD: окно переноса (откуда → куда, локали), задание, помощник в PROD
{
  const ed = { v: 'old', setValue(v) { this.v = v; }, getValue() { return this.v; } };
  const subj = { value: 'old subj', events: [], closest: () => ({ innerText: 'Subject' }), dispatchEvent(e) { this.events.push(e.type); } };
  class HTMLInputElement {}
  Object.defineProperty(HTMLInputElement.prototype, 'value', { set(v) { this._v = v; }, get() { return this._v; }, configurable: true });
  Object.setPrototypeOf(subj, HTMLInputElement.prototype);
  const prodTpl = { ...tpl, id: 4097, locales: tpl.locales.filter((l) => l.locale.short_name !== 'ru') };
  const prodResponses = { ...responses, '/api/email/templates/4097': prodTpl };
  const prodFetch = async (url, opts) => { calls.push(opts?.method || 'GET'); return { ok: url in prodResponses, status: 200, json: async () => JSON.parse(JSON.stringify(prodResponses[url])) }; };
  const confirms = [];
  const prod = tab('ucc.iqoption.com', '/email-templates/4097/edit', {
    fetch: prodFetch, ace: { edit: () => ed }, HTMLInputElement, Event: class { constructor(t) { this.type = t; } },
    confirm: (m) => { confirms.push(m); return true; },
  });
  let active = 'pt';
  const tabsEl = ['en', 'pt', 'fr'].map((c) => ({ innerText: c.toUpperCase(), click() { active = c; } }));
  prod.sandbox.document.querySelector = (q) => (q === '.ant-tabs-tab-active' ? { innerText: active.toUpperCase() } : q === '.ace_editor' ? {} : null);
  prod.sandbox.document.querySelectorAll = (q) => (q === 'input' ? [subj] : q === '.ant-tabs-tab' ? tabsEl : []);
  for (const f of prod.timers) await f();
  await tick(); await tick();
  for (const f of prod.timers) await f(); // второй сигнал — уже с именем письма

  // INT читает PROD через GM_xmlhttpRequest (другой сайт), только GET
  const xhrCalls = [];
  ucc.sandbox.GM_xmlhttpRequest = (o) => { xhrCalls.push(o); setTimeout(() => o.onload({ status: 200, responseText: JSON.stringify(prodTpl) }), 0); };
  const opened = [];
  ucc.sandbox.open = (u) => opened.push(u);
  for (const f of ucc.timers) await f();
  await tick(); await tick();
  ucc.dom.nodes.find((n) => n.id === 'retkit-ucc-pill' && !n.removed).onclick();
  const transferBtn = ucc.dom.nodes.filter((n) => typeof n.onclick === 'function').find((n) => n.children.some((c) => /Перенести в UCC PROD/.test(c.textContent || '')));
  assert.ok(transferBtn, 'в меню INT есть «⇄ Перенести в UCC PROD»');
  transferBtn.onclick();
  const input = ucc.dom.nodes.find((n) => n.tag === 'input' && !n.removed);
  assert.match(input.value, /ucc\.iqoption\.com\/email-templates\/4097\/edit/, 'цель подставилась из открытой вкладки PROD');
  for (let i = 0; i < 6; i += 1) await tick();
  assert.equal(xhrCalls[0].method, 'GET');
  const texts = ucc.dom.nodes.filter((n) => !n.removed).map((n) => n.textContent || '');
  assert.ok(texts.some((t) => /Перенесётся \(3\)/.test(t)), 'перенесётся 3 локали');
  assert.ok(texts.some((t) => /Нет в PROD \(1\)/.test(t)), 'RU нет в PROD — подсказка добавить «+»');
  const go = ucc.dom.nodes.find((n) => !n.removed && typeof n.onclick === 'function' && /Открыть письмо PROD и перенести/.test(n.textContent || ''));
  go.onclick();
  assert.equal(opened.length, 0, 'PROD уже открыт — новую вкладку не открываем');
  await tick(); await tick();

  // PROD: помощник
  for (const f of prod.timers) await f();
  const guide = () => prod.dom.nodes.find((n) => n.id === 'retkit-ucc-guide' && !n.removed);
  assert.ok(guide(), 'в PROD появился помощник переноса');
  const findBtn = (re) => prod.dom.nodes.filter((n) => !n.removed && typeof n.onclick === 'function').find((n) => re.test(n.textContent || ''));
  const before = calls.length;
  findBtn(/^1\. Вставить PT/).onclick();
  assert.equal(ed.v, tpl.locales[1].html_body, 'HTML PT вставлен как есть');
  assert.equal(subj._v, 'Seu código', 'Subject PT вставлен');
  assert.ok(subj.events.includes('input'));
  assert.equal(confirms.length, 1, 'PROD: одно подтверждение на весь перенос');
  findBtn(/^3\. Дальше: EN/).onclick();
  assert.equal(active, 'en', '«Дальше» переключает вкладку локали');
  await new Promise((r) => setTimeout(r, 450));
  findBtn(/^1\. Вставить EN/).onclick();
  assert.equal(confirms.length, 1, 'второй раз не спрашивает');
  assert.ok(calls.slice(before).every((m) => m === 'GET'), 'в UCC ничего не сохраняется');
}

// 7. Клик мимо окна закрывает его, клик внутри — нет
{
  const t2 = tab('ucc.int.iqoption.com', '/email-templates/15928/edit', { fetch });
  for (const f of t2.timers) await f();
  const pill = t2.dom.nodes.find((n) => n.id === 'retkit-ucc-pill' && !n.removed);
  pill.onclick();
  const menu = () => t2.dom.nodes.find((n) => n.id === 'retkit-ucc-menu' && !n.removed);
  const down = t2.dom.document.docListeners.mousedown;
  assert.ok(menu() && down, 'окно открыто, слушатель стоит');
  down({ target: menu().children[0] });
  assert.ok(menu(), 'клик внутри окна — не закрывает');
  down({ target: { outside: true } });
  assert.ok(!menu(), 'клик мимо окна — закрывает');
}

// 8. «⚡ Перенести всё»: создаёт недостающие локали (POST [{locale_id}]) и сохраняет код+тему (PUT), без register
{
  const db = { id: 777, name: 'fraud-2', locales: [{ id: 5001, locale_id: 2, locale: { short_name: 'en' }, subject: 'Old EN', html_body: '' }] };
  const reqs = [];
  const f = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    reqs.push({ method, url, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (url === '/api/init') return { ok: true, status: 200, json: async () => ({ locales: [{ id: 2, short_name: 'en' }, { id: 7, short_name: 'pt' }, { id: 9, short_name: 'de' }] }) };
    if (url === '/api/email/templates/777' && method === 'GET') return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(db)) };
    if (url === '/api/email/templates/777/locales' && method === 'POST') {
      for (const x of JSON.parse(opts.body)) db.locales.push({ id: 6000 + x.locale_id, locale_id: x.locale_id, locale: { short_name: x.locale_id === 7 ? 'pt' : 'de' }, subject: '', html_body: '' });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    const m = url.match(/^\/api\/email\/templates\/777\/locales\/(\d+)$/);
    if (m && method === 'PUT') { const rec = db.locales.find((l) => String(l.id) === m[1]); Object.assign(rec, JSON.parse(opts.body)); return { ok: true, status: 204, json: async () => ({}) }; }
    return { ok: false, status: 404, json: async () => ({ error: 'nf' }) };
  };
  const alerts = [];
  const t3 = tab('ucc.int.iqoption.com', '/email-templates/777/edit', { fetch: f, confirm: () => true, alert: (m) => alerts.push(m), location: { host: 'ucc.int.iqoption.com', pathname: '/email-templates/777/edit', reload() {} } });
  t3.sandbox.document.querySelector = () => null;
  t3.sandbox.document.querySelectorAll = () => [];
  store['retkit.ucc.u2u.jobs'] = { 'ucc.int.iqoption.com:777': { ts: Date.now(), from: { host: 'studio', label: 'студии', name: 'fraud-2' }, to: { host: 'ucc.int.iqoption.com', id: '777' }, done: {},
    locales: [{ code: 'en', subject: 'Contract terminated', html: '<p>EN</p>' }, { code: 'pt', subject: 'Seu contrato foi rescindido', html: '<p>PT</p>' }, { code: 'de', subject: '', html: '<p>DE</p>' }] } };
  for (const fn of t3.timers) await fn();
  const all = t3.dom.nodes.find((n) => !n.removed && typeof n.onclick === 'function' && /Перенести всё сразу/.test(n.textContent || ''));
  assert.ok(all, 'в помощнике есть «⚡ Перенести всё сразу»');
  await all.onclick();
  const post = reqs.find((r) => r.method === 'POST');
  assert.deepEqual(post.body, [{ locale_id: 7 }, { locale_id: 9 }], 'создаёт только недостающие PT и DE');
  const puts = reqs.filter((r) => r.method === 'PUT');
  assert.equal(puts.length, 3);
  assert.equal(db.locales.find((l) => l.locale.short_name === 'pt').subject, 'Seu contrato foi rescindido');
  assert.equal(db.locales.find((l) => l.locale.short_name === 'pt').html_body, '<p>PT</p>');
  assert.equal(db.locales.find((l) => l.locale.short_name === 'en').subject, 'Contract terminated');
  assert.ok(!reqs.some((r) => /register|status/.test(r.url)), 'Set as Ready не нажимает');
  assert.match(alerts.at(-1), /Сохранено: 3/);
}

// 9. Студия → MoEngage: окно показывает, что перенесётся и что сделать человеку; задание уходит во вкладку MoEngage
{
  store['retkit.mo.presence.motab1'] = { ts: Date.now(), tab: 'motab1', title: 'Fraud-2 (TEST)', campaign: 'abc123', locales: ['Default', 'EN_US', 'PT_PT'], editor: true };
  const studio = tab('localhost:3000', '/constructor', {
    RetKitStudioExport: {
      info: () => ({ mode: 'constructor', name: 'fraud-2', locales: ['en', 'pt', 'es', 'ru'] }),
      allLocales: async () => ({ name: 'fraud-2', locales: [
        { code: 'en', subject: 'Termination', html: '<p>{{code}}</p>{{embedded.risk_warning}}' },
        { code: 'pt', subject: 'Rescisão', html: '<p>PT</p>' },
        { code: 'es', subject: 'Rescisión', html: '<p>ES</p>' },
        { code: 'ru', subject: 'Расторжение', html: '<p>RU</p>' },
      ] }),
    },
  });
  for (const f of studio.timers) await f();
  assert.equal(typeof studio.sandbox.__retkitUccBridge.openMoFromStudio, 'function', 'мост студии умеет MoEngage');
  studio.sandbox.__retkitUccBridge.openMoFromStudio();
  for (let i = 0; i < 6; i += 1) await tick();
  const texts = studio.dom.nodes.filter((n) => !n.removed).map((n) => n.textContent || '');
  assert.ok(texts.some((t) => /Перенесётся \(3\)/.test(t)), 'Default+EN_US+PT_PT перенесутся');
  assert.ok(texts.some((t) => /Нет в этом письме MoEngage \(1\)/.test(t)) && texts.includes('es_ES'), 'ES: добавьте «+ Locale» в MoEngage');
  assert.ok(texts.some((t) => /пока нет \(1\)/.test(t)) && texts.includes('RU'), 'RU: в MoEngage такой локали нет — попросить завести');
  assert.ok(texts.some((t) => /не знает \(1\)/.test(t)), '{{code}} — плейсхолдер, который MoEngage не знает');
  const go = studio.dom.nodes.find((n) => !n.removed && typeof n.onclick === 'function' && /Залить в MoEngage/.test(n.textContent || ''));
  go.onclick();
  const pushed = store['retkit.ucc.push'];
  assert.equal(pushed.targetTab, 'motab1');
  assert.ok(pushed.transfer.locales.some((l) => l.mo === 'pt_PT' && l.subject === 'Rescisão'), 'тема локали едет в MoEngage');
  assert.ok(pushed.transfer.locales.find((l) => l.mo === 'en_US').html.includes("iq_risk_warning_noreg_EN"), 'футер — блоками MoEngage');
}

// 10. Пресеты UCC (/presets/<id>): студия → пресет INT по ссылке, задание, «⚡ Перенести всё» через /api/email/presets
{
  const db = { id: 121, name: 'fraud', locales: [{ id: 901, locale_id: 2, locale: { short_name: 'en' }, subject: '', html_body: '<p>old</p>' }] };
  const studio = tab('localhost:3000', '/workbench', {
    RetKitStudioExport: {
      info: () => ({ mode: 'code', name: 'fraud', locales: ['en', 'pt'] }),
      allLocales: async () => ({ name: 'fraud', locales: [{ code: 'en', subject: 'Hold', html: '<p>EN</p>' }, { code: 'pt', subject: 'Retido', html: '<p>PT</p>' }] }),
    },
  });
  const xhr = [];
  studio.sandbox.GM_xmlhttpRequest = (o) => { xhr.push(o); setTimeout(() => o.onload({ status: 200, responseText: JSON.stringify(db) }), 0); };
  const opened = [];
  studio.sandbox.open = (u) => opened.push(u);
  for (const f of studio.timers) await f();
  studio.sandbox.__retkitUccBridge.openFromStudio();
  const input = studio.dom.nodes.find((n) => n.tag === 'input' && !n.removed);
  input.value = 'https://ucc.int.iqoption.com/presets/121/edit';
  const intBtn = studio.dom.nodes.find((n) => !n.removed && typeof n.onclick === 'function' && n.textContent === 'INT');
  intBtn.onclick();
  for (let i = 0; i < 6; i += 1) await tick();
  assert.equal(xhr[0]?.url, 'https://ucc.int.iqoption.com/api/email/presets/121', 'пресет читается через /api/email/presets');
  const texts = studio.dom.nodes.filter((n) => !n.removed).map((n) => n.textContent || '');
  assert.ok(texts.some((t) => /пресет: «fraud»/.test(t)), 'окно понимает, что цель — пресет');
  const go = studio.dom.nodes.find((n) => !n.removed && typeof n.onclick === 'function' && /Открыть пресет INT и перенести/.test(n.textContent || ''));
  assert.ok(go, 'кнопка «Открыть пресет INT и перенести»');
  go.onclick();
  assert.equal(opened[0], 'https://ucc.int.iqoption.com/presets/121/edit');
  const job = store['retkit.ucc.u2u.jobs']['ucc.int.iqoption.com:preset:121'];
  assert.ok(job && job.to.kind === 'preset', 'задание лежит под ключом пресета');

  const reqs = [];
  const f = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    reqs.push({ method, url });
    if (url === '/api/init') return { ok: true, status: 200, json: async () => ({ locales: [{ id: 2, short_name: 'en' }, { id: 7, short_name: 'pt' }] }) };
    if (url === '/api/email/presets/121' && method === 'GET') return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(db)) };
    if (url === '/api/email/presets/121/locales' && method === 'POST') { for (const x of JSON.parse(opts.body)) db.locales.push({ id: 950 + x.locale_id, locale_id: x.locale_id, locale: { short_name: 'pt' }, subject: '', html_body: '' }); return { ok: true, status: 200, json: async () => ({}) }; }
    const m = url.match(/^\/api\/email\/presets\/121\/locales\/(\d+)$/);
    if (m && method === 'PUT') { Object.assign(db.locales.find((l) => String(l.id) === m[1]), JSON.parse(opts.body)); return { ok: true, status: 204, json: async () => ({}) }; }
    return { ok: false, status: 404, json: async () => ({ error: 'nf' }) };
  };
  const alerts = [];
  const p = tab('ucc.int.iqoption.com', '/presets/121/edit', { fetch: f, confirm: () => true, alert: (m) => alerts.push(m), location: { host: 'ucc.int.iqoption.com', pathname: '/presets/121/edit', reload() {} } });
  p.sandbox.document.querySelector = () => null;
  p.sandbox.document.querySelectorAll = () => [];
  for (const fn of p.timers) await fn();
  const all = p.dom.nodes.find((n) => !n.removed && typeof n.onclick === 'function' && /Перенести всё сразу/.test(n.textContent || ''));
  assert.ok(all, 'в пресете появился помощник переноса');
  await all.onclick();
  assert.ok(!reqs.some((r) => /templates/.test(r.url) && r.method !== 'GET'), 'в письма не пишет — только в пресет');
  assert.equal(db.locales.find((l) => l.locale.short_name === 'pt').html_body, '<p>PT</p>');
  assert.equal(db.locales.find((l) => l.locale.short_name === 'en').subject, 'Hold');
  assert.ok(!reqs.some((r) => /status|register/.test(r.url)), 'Set as Ready не нажимает');
  assert.match(alerts.at(-1), /Сохранено: 2/);
}

console.log('✓ ucc bridge: две вкладки через хранилище TM, присутствие, задание, перенос локалей + Subject + отправитель, ошибки по локали, только GET');
