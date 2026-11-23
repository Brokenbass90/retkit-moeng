// ==UserScript==
// @name         RetKit UCC Export
// @namespace    https://github.com/Brokenbass90/retkit-moeng
// @version      0.6.1
// @description  UCC: «⬇ ZIP письма» и мост в RetKit for MoEngage — открытое письмо (HTML + Subject всех локалей, отправитель) забирается кнопкой в MoEngage. В UCC только чтение.
// @match        https://ucc.iqoption.com/*
// @match        https://ucc.int.iqoption.com/*
// @match        https://dashboard-02.moengage.com/*
// @updateURL    https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/dist/retkit-ucc-export.user.js
// @downloadURL  https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/dist/retkit-ucc-export.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @sandbox      JavaScript
// @run-at       document-idle
// ==/UserScript==

/*
 * Зачем: перенос системных писем из UCC (в MoEngage и куда угодно) — это
 * «открыть письмо → в каждой локали Ctrl+A, Ctrl+C → скопировать тему →
 * посмотреть настройки». Тут то же самое одной кнопкой.
 *
 * Только чтение: скрипт делает те же GET-запросы, что и сама страница
 * (/api/email/templates/<id>, /api/email/senders/, /api/email/categories).
 * Ничего не сохраняет в UCC и не жмёт кнопки. Токен микросервиса (JWT) из
 * ответа в архив не попадает.
 *
 * Архив: <имя письма>/
 *          params.txt           — название, id, микросервис, отправитель, категория, локали
 *          subjects.txt         — тема каждой локали
 *          <локаль>/index.html  — код локали как в редакторе
 *          <локаль>/subject.txt
 */
(function () {
  'use strict';
  // Под Tampermonkey с @grant страница — unsafeWindow; в тестах — обычный window.
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (W.__retkitUccExport) return;
  const IS_UCC = /(^|\.)ucc(\.int)?\.iqoption\.com$/.test(location.host);

  // ─── ZIP без зависимостей (метод STORE) ───────────────────────────────────
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function makeZip(files) {
    const enc = new TextEncoder();
    const chunks = []; const central = []; let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const file of files) {
      const name = enc.encode(file.path);
      const data = typeof file.content === 'string' ? enc.encode(file.content) : file.content;
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), name, data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true); cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
      cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const centralSize = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  // ─── Данные письма ────────────────────────────────────────────────────────
  async function getJson(url) {
    const res = await (W.fetch || fetch)(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }
  function asList(value) {
    if (Array.isArray(value)) return value;
    for (const key of ['data', 'items', 'results', 'senders', 'categories']) if (Array.isArray(value?.[key])) return value[key];
    return [];
  }
  function describe(item) {
    if (!item) return '';
    const main = item.email || item.address || item.from || item.name || item.title || '';
    const extra = item.name && item.name !== main ? ` (${item.name})` : '';
    return `${main}${extra}`.trim() || JSON.stringify(item);
  }
  function safe(value, fallback) {
    const s = String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
    return s || fallback;
  }

  // Список отправителей: на части стендов /api/email/senders/ без параметров отвечает 400.
  async function getSenders(tpl) {
    for (const url of [`/api/email/senders/?brand_id=${tpl.brand_id}`, '/api/email/senders', '/api/email/senders/']) {
      try { const list = asList(await getJson(url)); if (list.length) return list; } catch {}
    }
    return [];
  }
  async function collect(id) {
    const tpl = await getJson(`/api/email/templates/${id}`);
    const [senders, categories] = await Promise.all([
      getSenders(tpl),
      getJson('/api/email/categories').then(asList).catch(() => []),
    ]);
    const sender = senders.find((s) => s.id === tpl.email_sender_id);
    const category = categories.find((c) => c.id === tpl.email_category_id);
    const locales = (tpl.locales || []).map((l) => ({
      code: l.locale?.short_name || l.locale?.name || String(l.locale_id),
      name: l.locale?.name || '',
      title: l.locale?.title || '',
      status: l.status?.name || String(l.status_id ?? ''),
      subject: l.subject || '',
      html: l.html_body || '',
    }));
    return {
      id: tpl.id,
      name: tpl.name || `template-${id}`,
      host: location.host,
      microservice: tpl.microservice_name || tpl.microservice?.Name || '',
      microserviceTitle: tpl.microservice?.Title || '',
      brandId: tpl.brand_id,
      sender: describe(sender) || (tpl.email_sender_id != null ? `id ${tpl.email_sender_id}` : ''),
      senderEmail: sender?.email || sender?.address || '',
      senderName: sender?.name && sender.name !== (sender.email || '') ? sender.name : '',
      category: describe(category) || (tpl.email_category_id != null ? `id ${tpl.email_category_id}` : ''),
      presetId: tpl.preset_id,
      status: tpl.status_id,
      updatedAt: tpl.updated_at,
      locales,
    };
  }

  function filesFor(mail) {
    const root = safe(mail.name, `template-${mail.id}`);
    const params = [
      `Name: ${mail.name}`,
      `Template ID: ${mail.id}`,
      `UCC: https://${mail.host}/email-templates/${mail.id}/edit`,
      `Microservice: ${mail.microservice}${mail.microserviceTitle && mail.microserviceTitle !== mail.microservice ? ` (${mail.microserviceTitle})` : ''}`,
      `Sender: ${mail.sender}`,
      `Category: ${mail.category}`,
      `Brand ID: ${mail.brandId ?? ''}`,
      `Preset ID: ${mail.presetId ?? '-'}`,
      `Updated: ${mail.updatedAt || ''}`,
      `Locales (${mail.locales.length}): ${mail.locales.map((l) => l.code.toUpperCase()).join(', ')}`,
      '',
      ...mail.locales.map((l) => `${l.code.toUpperCase()}\t${l.status}\t${l.subject}`),
      '',
    ].join('\n');
    const files = [
      { path: `${root}/params.txt`, content: params },
      { path: `${root}/subjects.txt`, content: mail.locales.map((l) => `${l.code}\t${l.subject}`).join('\n') + '\n' },
    ];
    for (const l of mail.locales) {
      const dir = `${root}/${safe(l.code, 'locale')}`;
      files.push({ path: `${dir}/index.html`, content: l.html });
      files.push({ path: `${dir}/subject.txt`, content: `${l.subject}\n` });
    }
    return { root, files };
  }

  async function exportZip(id) {
    const mail = await collect(id);
    const { root, files } = filesFor(mail);
    const url = URL.createObjectURL(makeZip(files));
    Object.assign(document.createElement('a'), { href: url, download: `${root}.zip` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    return { name: mail.name, locales: mail.locales.length };
  }

  // ─── Кнопка ───────────────────────────────────────────────────────────────
  const BUTTON_ID = 'retkit-ucc-export';
  function templateId() {
    const m = location.pathname.match(/\/email-templates\/(\d+)/);
    return m ? m[1] : null;
  }
  function sync() {
    const id = templateId();
    let button = document.getElementById(BUTTON_ID);
    if (!id) { button?.remove(); return; }
    if (button) { button.dataset.id = id; return; }
    button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.dataset.id = id;
    button.textContent = '⬇ ZIP письма';
    button.title = 'RetKit: скачать все локали письма (HTML + Subject) и параметры одним архивом. Только чтение.';
    Object.assign(button.style, {
      position: 'fixed', right: '20px', bottom: '20px', zIndex: 99999, padding: '10px 16px',
      borderRadius: '8px', border: 'none', background: '#3b5bfd', color: '#fff', font: '600 14px/1 sans-serif',
      cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,.25)',
    });
    button.addEventListener('click', async () => {
      const label = button.textContent;
      button.disabled = true; button.textContent = '⬇ собираю…';
      try {
        const r = await exportZip(button.dataset.id);
        button.textContent = `✓ ${r.locales} локалей`;
      } catch (error) {
        button.textContent = '✕ ошибка';
        alert(`RetKit UCC Export: ${error.message}`);
      } finally {
        setTimeout(() => { button.disabled = false; button.textContent = label; }, 2500);
      }
    });
    document.body.appendChild(button);
  }

  // ─── Мост в RetKit for MoEngage ───────────────────────────────────────────
  // Вкладки UCC и MoEngage — разные сайты. Связь — общее хранилище этого скрипта
  // в Tampermonkey (GM_setValue + GM_addValueChangeListener), оно одно на все вкладки.
  //   UCC: раз в 2 с пишет «присутствие» (какое письмо открыто), отвечает на запрос
  //        письма готовым заданием (футер заменён, локали сопоставлены). Только GET.
  //   MoEngage: публикует window.__RetKitUccLink — им пользуется RetKit for MoEngage
  //        (кнопка «⇄ UCC», зелёная, когда вкладка UCC с письмом на связи).
  const MAP = {
    // Зеркало tools/ucc-footer-map.json (тест следит, чтобы совпадали).
    replace: {
      '{{embedded.company_address}}': "{{ContentBlock['iq_company_address_text']}}",
      '{{embedded.risk_warning}}': "{{ContentBlock['iq_risk_warning_noreg_{LANG}']}}",
      '{{embedded.company_terms_link}}': "{{ContentBlock['iq_terms_noreg_url']}}",
      '{{embedded.domain}}/traderoom/': 'https://iqbroker.co/lp/multilink/asset?aff=7&amp;afftrack=mail_system&amp;retrack=system',
    },
    moengageLocales: { en: 'en_US', ar: 'ar_KW', es: 'es_ES', pt: 'pt_PT', th: 'th_TH', id: 'id_ID', vi: 'vi_VN', fr: 'fr_FR' },
    afterTerms: "<br><a data-msys-unsubscribe=\"1\" href=\"{{ContentBlock['iq_unsubscribe']}}\" style=\"color: #2ba6cb; text-decoration: none;\">Manage your preference here</a>",
  };
  const PLACEHOLDER_RE = /\{\{\s*[^{}]+?\s*\}\}/g;

  function applyFooter(html, code) {
    const lang = String(code || '').toUpperCase();
    let out = String(html || '');
    for (const [from, to] of Object.entries(MAP.replace)) if (to) out = out.split(from).join(to.split('{LANG}').join(lang));
    return addAfterTerms(out);
  }

  /** Отписка MoEngage — в самый низ футера: сразу после ссылки Terms (или перед </body>). Повторно не вставляется. */
  function addAfterTerms(html) {
    if (!MAP.afterTerms || html.includes("iq_unsubscribe")) return html;
    const at = html.indexOf("iq_terms_noreg_url");
    const close = at >= 0 ? html.indexOf('</a>', at) : -1;
    if (close >= 0) return html.slice(0, close + 4) + MAP.afterTerms + html.slice(close + 4);
    const body = html.lastIndexOf('</body>');
    return body >= 0 ? html.slice(0, body) + MAP.afterTerms + html.slice(body) : html + MAP.afterTerms;
  }

  /** Письмо (результат collect) → задание для MoEngage. */
  function transferFor(mail, { defaultFromEn = true } = {}) {
    const locales = []; const skipped = []; const empty = []; const placeholders = {};
    for (const l of mail.locales) {
      const code = String(l.code || '').toLowerCase();
      const mo = MAP.moengageLocales[code] || '';
      const html = applyFooter(l.html, code);
      if (!mo) { skipped.push(code.toUpperCase()); continue; }
      if (!String(l.html || '').trim()) { empty.push(code.toUpperCase()); continue; }
      for (const m of html.match(PLACEHOLDER_RE) || []) if (!/ContentBlock\[/.test(m)) placeholders[m] = (placeholders[m] || 0) + 1;
      locales.push({ ucc: code.toUpperCase(), mo, subject: l.subject, html });
    }
    // Default — запасная локаль MoEngage, без неё кампания не сохраняется. Берём EN.
    const en = locales.find((l) => l.ucc === 'EN');
    if (defaultFromEn && en) locales.unshift({ ...en, mo: 'Default' });
    return {
      id: mail.id, name: mail.name, host: mail.host, uccUrl: `https://${mail.host}/email-templates/${mail.id}/edit`,
      microservice: mail.microservice, sender: mail.sender, senderEmail: mail.senderEmail || '', senderName: mail.senderName || '',
      category: mail.category, locales, skipped, empty, placeholders,
      footerLeftovers: Object.keys(MAP.replace).filter((k) => locales.some((l) => l.html.includes(k))),
    };
  }

  const KEY = { pull: 'retkit.ucc.pull', reply: 'retkit.ucc.reply', push: 'retkit.ucc.push' };
  const gm = {
    get: (k, d) => { try { return GM_getValue(k, d); } catch { return d; } },
    set: (k, v) => { try { GM_setValue(k, v); return true; } catch { return false; } },
    on: (k, fn) => { try { GM_addValueChangeListener(k, (_n, _o, v, remote) => fn(v, remote)); return true; } catch { return false; } },
    keys: () => { try { return GM_listValues(); } catch { return []; } },
    del: (k) => { try { GM_deleteValue(k); } catch {} },
  };
  // Каждая вкладка UCC пишет своё присутствие в свой ключ: открыто несколько писем — видны все.
  const TAB = Math.random().toString(36).slice(2, 10);
  const PRESENCE_PREFIX = 'retkit.ucc.presence.';
  const MO_PREFIX = 'retkit.mo.presence.';
  // Фоновую вкладку браузер «усыпляет»: таймеры срабатывают раз в минуту. Поэтому вкладка считается
  // на связи 3 минуты после последнего сигнала; закрытая удаляет себя сама (pagehide), мусор чистится через 10 мин.
  const ALIVE_MS = 3 * 60 * 1000;
  const STALE_MS = 10 * 60 * 1000;
  const now = () => Date.now();

  function uccLink() {
    const metaCache = new Map(); // id → { name, microservice }
    async function heartbeat() {
      const id = templateId();
      if (!id) { gm.set(PRESENCE_PREFIX + TAB, { ts: now(), tab: TAB, host: location.host, id: null }); return; }
      let meta = metaCache.get(id);
      if (!meta) {
        meta = { name: '', microservice: '' };
        metaCache.set(id, meta);
        getJson(`/api/email/templates/${id}`).then((tpl) => {
          meta.name = tpl.name || ''; meta.microservice = tpl.microservice_name || tpl.microservice?.Name || '';
          meta.locales = (tpl.locales || []).length;
        }).catch(() => metaCache.delete(id));
      }
      gm.set(PRESENCE_PREFIX + TAB, { ts: now(), tab: TAB, host: location.host, id, name: meta.name, microservice: meta.microservice, locales: meta.locales || 0 });
    }
    gm.on(KEY.pull, async (req, remote) => {
      if (!remote || !req?.requestId || now() - (req.ts || 0) > 60000) return;
      const id = templateId();
      if (!id || (req.id && String(req.id) !== String(id)) || (req.host && req.host !== location.host)) return; // спрашивают не про наше письмо
      try {
        const mail = await collect(id);
        gm.set(KEY.reply, { requestId: req.requestId, ts: now(), transfer: transferFor(mail) });
      } catch (error) {
        gm.set(KEY.reply, { requestId: req.requestId, ts: now(), error: error?.message || String(error) });
      }
    });
    heartbeat();
    setInterval(heartbeat, 2000);
    try { document.addEventListener('visibilitychange', heartbeat); } catch {}
    try { W.addEventListener('pagehide', () => gm.del(PRESENCE_PREFIX + TAB)); } catch {}

    // Индикатор моста: к какой вкладке MoEngage натянут. Перенос запускается в RetKit (MoEngage).
    const PILL_ID = 'retkit-ucc-pill';
    function moTabs() {
      const list = [];
      for (const k of gm.keys()) {
        if (!String(k).startsWith(MO_PREFIX)) continue;
        const p = gm.get(k, null);
        const age = p ? now() - (p.ts || 0) : Infinity;
        if (age > STALE_MS) { gm.del(k); continue; }
        if (age < ALIVE_MS && p.editor) list.push(p);
      }
      return list;
    }
    function syncPill() {
      const id = templateId();
      let pill = document.getElementById(PILL_ID);
      if (!id) { pill?.remove(); return; }
      if (!pill) {
        pill = document.createElement('div');
        pill.id = PILL_ID;
        Object.assign(pill.style, {
          position: 'fixed', right: '20px', bottom: '64px', zIndex: 99999, padding: '8px 12px', borderRadius: '999px',
          background: '#0f1722', color: '#e6edf7', font: '600 12px/1 sans-serif', boxShadow: '0 4px 14px rgba(0,0,0,.25)',
          display: 'flex', alignItems: 'center', gap: '7px', maxWidth: '360px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        });
        document.body.appendChild(pill);
      }
      const tabs = moTabs();
      const dot = tabs.length ? '#22c55e' : '#64748b';
      const text = !tabs.length ? 'MoEngage: откройте письмо и RetKit' : `на связи с MoEngage${tabs.length > 1 ? ` (${tabs.length} вкладки)` : ''} — перенос: RetKit → «Перенести из UCC»`;
      pill.innerHTML = '';
      const d = document.createElement('span');
      Object.assign(d.style, { width: '8px', height: '8px', borderRadius: '50%', background: dot, flex: '0 0 8px' });
      const t = document.createElement('span'); t.textContent = `⇄ ${text}`;
      pill.append(d, t);
      pill.title = tabs.length
        ? `Мост RetKit на связи с:\n${tabs.map((x) => `• ${x.title || x.path}`).join('\n')}\nПеренос: в MoEngage → RetKit → чип «UCC».`
        : 'Откройте письмо в MoEngage и RetKit — мост появится здесь.';
    }
    syncPill();
    setInterval(syncPill, 2000);
  }

  function moengageLink() {
    const listeners = { presence: new Set(), push: new Set() };
    const pending = new Map();
    gm.on(KEY.reply, (r) => { const p = pending.get(r?.requestId); if (p) { pending.delete(r.requestId); r.error ? p.reject(new Error(r.error)) : p.resolve(r.transfer); } });
    function tabs() {
      const list = [];
      for (const k of gm.keys()) {
        if (!String(k).startsWith(PRESENCE_PREFIX)) continue;
        const p = gm.get(k, null);
        const ageMs = p ? now() - (p.ts || 0) : Infinity;
        if (ageMs > STALE_MS) { gm.del(k); continue; } // вкладку закрыли без pagehide
        if (ageMs < ALIVE_MS && p.id) list.push({ id: p.id, name: p.name || '', microservice: p.microservice || '', locales: p.locales || 0, host: p.host || '', tab: p.tab, ageMs });
      }
      // одно письмо в двух вкладках — одна строка
      const seen = new Set();
      return list.filter((x) => (seen.has(`${x.host}#${x.id}`) ? false : seen.add(`${x.host}#${x.id}`))).sort((a, b) => a.name.localeCompare(b.name));
    }
    let lastSig = '';
    setInterval(() => {
      const list = tabs();
      const sig = JSON.stringify(list.map((x) => [x.host, x.id, x.name]));
      if (sig === lastSig) return;
      lastSig = sig;
      for (const fn of listeners.presence) { try { fn(list); } catch {} }
    }, 2000);
    gm.on(KEY.push, (req, remote) => { if (remote && req?.transfer) for (const fn of listeners.push) { try { fn(req); } catch {} } });
    // Присутствие этой вкладки MoEngage — для индикатора в UCC.
    function moTitle() {
      const pick = (sel) => { try { return String(document.querySelector(sel)?.value || document.querySelector(sel)?.textContent || '').trim(); } catch { return ''; } };
      return pick('input[name*="campaign" i][name*="name" i]') || pick('[data-testid*="campaign-name" i]') || String(document.title || '').replace(/\s*[|·-]\s*MoEngage.*$/i, '').trim();
    }
    function moBeat() {
      // MoEngage меняет адрес через #, поэтому смотрим не на путь, а на вкладки локалей письма.
      let locale = '';
      try { locale = W.__RetKitMoEngageBridgeApi?.getNativeTabLocale?.() || ''; } catch {}
      // RetKit открыт (полноэкранный редактор письма) или видны вкладки локалей MoEngage.
      const editor = (Boolean(document.getElementById('retkit-mo-workspace')) || Boolean(locale)) && !/settings/i.test(location.href);
      gm.set(MO_PREFIX + TAB, { ts: now(), tab: TAB, title: moTitle(), path: location.pathname + location.hash, editor });
    }
    moBeat();
    setInterval(moBeat, 2000);
    try { document.addEventListener('visibilitychange', moBeat); } catch {}
    try { W.addEventListener('pagehide', () => gm.del(MO_PREFIX + TAB)); } catch {}
    W.__RetKitUccLink = {
      version: '0.6.1',
      /** Письма, открытые сейчас во вкладках UCC: [{ id, name, microservice, locales, host }]. */
      tabs,
      /** Совместимость: первое открытое письмо. */
      presence() {
        const list = tabs();
        const p = list[0];
        return { online: list.length > 0, count: list.length, id: p?.id || null, name: p?.name || '', microservice: p?.microservice || '', locales: p?.locales || 0, host: p?.host || '' };
      },
      /** Забрать задание переноса из открытой вкладки UCC. */
      pull({ id, host, timeoutMs = 20000 } = {}) {
        const requestId = `pull-${now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('UCC не ответил: откройте письмо в UCC (вкладка должна быть открыта)')); }, timeoutMs);
          pending.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
          if (!gm.set(KEY.pull, { requestId, ts: now(), id: id || null, host: host || null })) { clearTimeout(timer); pending.delete(requestId); reject(new Error('Хранилище Tampermonkey недоступно')); }
        });
      },
      onPresence(fn) { listeners.presence.add(fn); return () => listeners.presence.delete(fn); },
      onPush(fn) { listeners.push.add(fn); return () => listeners.push.delete(fn); },
    };
    try { W.dispatchEvent(new W.CustomEvent('retkit:ucc-link-ready')); } catch {}
  }

  W.__retkitUccExport = { collect, filesFor, makeZip, exportZip, transferFor, applyFooter, MAP };
  if (IS_UCC) {
    sync();
    setInterval(sync, 1000); // UCC — одностраничное приложение, адрес меняется без перезагрузки
    uccLink();
  } else if (/moengage\.com$/.test(location.host)) {
    moengageLink();
  }
})();

