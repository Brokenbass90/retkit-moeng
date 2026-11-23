// RetKit UCC → MoEngage: задание из письма UCC и заливка в MoEngage через API RetKit (на фейках).
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../src/ucc/retkit-ucc-to-moengage.user.js', import.meta.url), 'utf8');
const mapFile = JSON.parse(fs.readFileSync(new URL('../tools/ucc-footer-map.json', import.meta.url), 'utf8'));

function load(host, extra = {}) {
  const store = {};
  const listeners = {};
  const nodes = [];
  const makeNode = () => {
    const n = { style: {}, dataset: {}, children: [], textContent: '', id: '', listeners: {},
      appendChild(c) { this.children.push(c); return c; }, append(...c) { this.children.push(...c); },
      addEventListener(t, f) { this.listeners[t] = f; }, remove() { n.removed = true; } };
    nodes.push(n); return n;
  };
  const sandbox = {
    location: { host, pathname: '/email-templates/15928/edit' },
    document: { getElementById: (id) => nodes.find((n) => n.id === id && !n.removed) || null, createElement: makeNode, body: makeNode() },
    GM_getValue: (k, d) => (k in store ? store[k] : d),
    GM_setValue: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); for (const f of listeners[k] || []) f(k, null, store[k], true); },
    GM_addValueChangeListener: (k, f) => { (listeners[k] ||= []).push(f); },
    setInterval: () => 0, setTimeout: (f) => { f(); return 0; }, console, Promise, JSON, Date, Math, alert: () => {},
    ...extra,
  };
  sandbox.unsafeWindow = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { api: sandbox.__retkitUccToMoengage, store, nodes, sandbox };
}

const tpl = {
  id: 15928, name: '2fa-code', email_sender_id: 1, email_category_id: 3, microservice_name: 'auth',
  microservice: { Name: 'auth', JWT: 'SECRET.JWT' },
  locales: [
    { locale: { short_name: 'en' }, subject: 'Your code', html_body: '<a href="{{embedded.domain}}/traderoom/">logo</a><p>{{code}}</p>{{embedded.risk_warning}}{{embedded.company_address}}<a href="{{embedded.company_terms_link}}">T</a>' },
    { locale: { short_name: 'pt' }, subject: 'Seu código', html_body: '<p>{{code}}</p>{{embedded.risk_warning}}' },
    { locale: { short_name: 'ru' }, subject: 'Ваш код', html_body: '<p>{{code}}</p>' },
    { locale: { short_name: 'fr' }, subject: 'Code', html_body: '   ' },
  ],
};

// 1. Карта в скрипте совпадает с tools/ucc-footer-map.json
{
  const { api } = load('example.com');
  assert.deepEqual(JSON.parse(JSON.stringify(api.MAP.replace)), mapFile.replace);
  assert.deepEqual(JSON.parse(JSON.stringify(api.MAP.moengageLocales)), mapFile.moengageLocales);
}

// 2. Задание: футер, локали, Default из EN, пропуски, без JWT
{
  const { api } = load('example.com');
  const t = api.buildTransfer(tpl, { senders: [{ id: 1, email: 'noreply@iqoption.com' }], host: 'ucc.int.iqoption.com' });
  assert.deepEqual([...t.locales.map((l) => l.mo)], ['Default', 'en_US', 'pt_PT']);
  assert.deepEqual([...t.skipped], ['RU']);
  assert.deepEqual([...t.empty], ['FR']);
  const en = t.locales[1].html;
  assert.match(en, /iq_risk_warning_noreg_EN/);
  assert.match(en, /iq_company_address_text/);
  assert.match(en, /iq_terms_noreg_url/);
  assert.match(en, /iqbroker\.co\/lp\/multilink/);
  assert.match(t.locales[2].html, /iq_risk_warning_noreg_PT/);
  assert.equal(t.footerLeftovers.length, 0);
  assert.deepEqual(Object.keys(t.placeholders), ['{{code}}']);
  assert.equal(t.senderEmail, 'noreply@iqoption.com');
  assert.ok(!JSON.stringify(t).includes('SECRET'), 'JWT не попадает в задание');
  assert.deepEqual([...api.missingLocales(t, ['EN', 'EN_US'])], ['pt_PT']);
}

// 3. MoEngage: задание → «Перенести» → добавление локали, HTML + Subject в каждую, статус done
{
  const htmls = {}; const subjects = {}; let active = 'EN'; let locales = ['EN', 'EN_US'];
  const bridge = {
    listLocales: async () => [...locales],
    addLocales: async (list) => { locales.push(...list.map((l) => l.toUpperCase())); return { ok: true }; },
    getActiveLocale: () => active,
    switchLocale: async (l) => { active = l === 'Default' ? 'EN' : l.toUpperCase(); return true; },
    setLocaleHtmlStable: async (l, html) => { htmls[active] = html; return { ok: true }; },
    setSubject: (s) => { subjects[active] = s; return true; },
    getSubject: () => subjects[active] || '',
    readSender: () => ({ found: true, fromEmail: 'noreply@iqoption.com' }),
  };
  const mo = load('dashboard-02.moengage.com', { __RetKitMoEngageBridgeApi: bridge });
  const { api } = load('example.com');
  const transfer = api.buildTransfer(tpl, { senders: [{ id: 1, email: 'noreply@iqoption.com' }] });
  const req = { requestId: 'r1', ts: Date.now(), transfer };
  await mo.api.side.run(req);
  assert.deepEqual(locales, ['EN', 'EN_US', 'PT_PT']);
  assert.match(htmls.EN, /noreg_EN/);
  assert.match(htmls.PT_PT, /noreg_PT/);
  assert.equal(subjects.EN_US, 'Your code');
  assert.equal(subjects.PT_PT, 'Seu código');
  assert.equal(active, 'EN', 'вернулись на исходную локаль');
  const st = mo.store['retkit.ucc2mo.status'];
  assert.equal(st.state, 'done');
  assert.equal(st.ok, 3);
  assert.equal(st.failed, 0);
}

// 4. Ошибка одной локали не останавливает остальные
{
  let active = 'EN'; const subjects = {};
  const bridge = {
    listLocales: async () => ['EN', 'EN_US', 'PT_PT'], addLocales: async () => ({ ok: true }), getActiveLocale: () => active,
    switchLocale: async (l) => { active = l === 'Default' ? 'EN' : l.toUpperCase(); return true; },
    setLocaleHtmlStable: async () => (active === 'PT_PT' ? { ok: false, reason: 'MoEngage did not keep the HTML' } : { ok: true }),
    setSubject: (s) => { subjects[active] = s; return true; }, getSubject: () => subjects[active] || '',
  };
  const mo = load('dashboard-02.moengage.com', { __RetKitMoEngageBridgeApi: bridge });
  const { api } = load('example.com');
  await mo.api.side.run({ requestId: 'r2', ts: Date.now(), transfer: api.buildTransfer(tpl, {}) });
  const st = mo.store['retkit.ucc2mo.status'];
  assert.equal(st.state, 'done');
  assert.equal(st.ok, 2);
  assert.equal(st.failed, 1);
  assert.ok(st.lines.some((l) => l.includes('pt_PT') && l.includes('did not keep')));
}

// 5. UCC: кнопка читает письмо (только GET) и кладёт задание в хранилище
{
  const calls = [];
  const responses = { '/api/email/templates/15928': tpl, '/api/email/senders/': [{ id: 1, email: 'noreply@iqoption.com' }], '/api/email/categories': [] };
  const ucc = load('ucc.int.iqoption.com', {
    fetch: async (url, opts) => { calls.push([url, opts?.method || 'GET']); return { ok: true, status: 200, json: async () => responses[url] }; },
  });
  const button = ucc.nodes.find((n) => n.id === 'retkit-ucc-to-mo');
  assert.ok(button, 'кнопка «→ MoEngage» на странице письма');
  await button.listeners.click();
  assert.ok(calls.every(([, m]) => m === 'GET'), 'в UCC только GET');
  const req = ucc.store['retkit.ucc2mo.request'];
  assert.equal(req.transfer.name, '2fa-code');
  assert.equal(req.transfer.locales.length, 3);
  assert.equal(ucc.store['retkit.ucc2mo.status'].state, 'sent');
}

console.log('✓ ucc → moengage: карта, задание, заливка локалей, ошибки по локали, кнопка UCC (только GET)');
