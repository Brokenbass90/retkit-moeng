// ==UserScript==
// @name         RetKit UCC Export
// @namespace    https://github.com/Brokenbass90/retkit-moeng
// @version      0.12.0
// @description  UCC: «⬇ ZIP письма» и мост в RetKit for MoEngage — открытое письмо (HTML + Subject всех локалей, отправитель) забирается кнопкой в MoEngage. В UCC только чтение.
// @match        https://ucc.iqoption.com/*
// @match        https://ucc.int.iqoption.com/*
// @match        https://dashboard-02.moengage.com/*
// @match        http://localhost:3000/*
// @match        http://127.0.0.1:3000/*
// @updateURL    https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/dist/retkit-ucc-export.user.js
// @downloadURL  https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/dist/retkit-ucc-export.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      ucc.iqoption.com
// @connect      ucc.int.iqoption.com
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
  // Студия RetKit (Retention Future) на своей машине: «Код» → перенос локалей в UCC.
  const IS_STUDIO = /^(localhost|127\.0\.0\.1):3000$/.test(location.host);

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
  // Раньше тут была отдельная кнопка «⬇ ZIP письма». Теперь всё в одной кнопке RetKit (см. uccLink):
  // ZIP, перенос в MoEngage, перенос в другое письмо UCC (INT ⇄ PROD). Старую кнопку убираем.
  function sync() { document.getElementById(BUTTON_ID)?.remove(); }

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
    afterTerms: "<br><a data-msys-unsubscribe=\"1\" href=\"{{ContentBlock['iq_unsubscribe']}}\" style=\"color: {BG}; text-decoration: none;\">Manage your preference here</a>",
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
    const snippet = MAP.afterTerms.split('{BG}').join(footerBg(html));
    const at = html.indexOf("iq_terms_noreg_url");
    const close = at >= 0 ? html.indexOf('</a>', at) : -1;
    if (close >= 0) return html.slice(0, close + 4) + snippet + html.slice(close + 4);
    const body = html.lastIndexOf('</body>');
    return body >= 0 ? html.slice(0, body) + snippet + html.slice(body) : html + snippet;
  }
  /** Цвет фона футера (последний background до адреса/Terms) — ссылкой этого цвета отписка «спрятана». */
  function footerBg(html) {
    const anchor = Math.max(html.indexOf("iq_company_address_text"), html.indexOf("iq_terms_noreg_url"));
    const part = anchor > 0 ? html.slice(0, anchor) : html;
    const all = [...part.matchAll(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)].map((m) => m[1].toLowerCase()).filter((c) => !/^#f{3}(f{3})?$/.test(c));
    return all.length ? all[all.length - 1] : '#ebeff6';
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

  const KEY = { pull: 'retkit.ucc.pull', reply: 'retkit.ucc.reply', push: 'retkit.ucc.push', status: 'retkit.ucc.status' };
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
    if (IS_UCC) {
      heartbeat();
      setInterval(heartbeat, 2000);
      try { document.addEventListener('visibilitychange', heartbeat); } catch {}
      try { W.addEventListener('pagehide', () => gm.del(PRESENCE_PREFIX + TAB)); } catch {}
    }

    // Кнопка моста в UCC: показывает, какие письма MoEngage открыты, и запускает перенос в выбранное.
    const PILL_ID = 'retkit-ucc-pill';
    const MENU_ID = 'retkit-ucc-menu';
    let activeRequest = '';
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
    const moLabel = (t) => `${t.title || 'письмо MoEngage'}${t.campaign ? ` · …${String(t.campaign).slice(-4)}` : ''}`;
    function el2(tag, css, text) { const n = document.createElement(tag); if (css) n.style.cssText = css; if (text != null) n.textContent = text; return n; }

    // ─── UCC ⇄ UCC (INT ⇄ PROD) ────────────────────────────────────────────────
    // Как работает (ничего не сохраняем в UCC — Save жмёт человек):
    //   1. В письме-источнике: RetKit ▾ → «Перенести в PROD/INT».
    //   2. Окно переноса: откуда → куда. Куда — открытая вкладка того же письма или ссылка/номер.
    //      Целевое письмо читаем (GET через GM_xmlhttpRequest — свой вход человека) и показываем,
    //      какие локали перенесутся, а каких в цели нет (их добавляют «+» в UCC).
    //   3. «Открыть и перенести» — в хранилище кладём задание для целевого письма и открываем его.
    //   4. Целевая вкладка сама показывает помощник: локаль за локалью «Вставить → Save → Дальше».
    const JOBS = 'retkit.ucc.u2u.jobs'; // { "<host>:<id>": задание }
    const GUIDE_ID = 'retkit-ucc-guide';
    const envName = (host) => (/\.int\./.test(host) ? 'INT' : 'PROD');
    const otherHost = (host) => (/\.int\./.test(host) ? host.replace('.int.', '.') : host.replace(/^ucc\./, 'ucc.int.'));
    const jobKey = (host, id) => `${host}:${id}`;
    const getJobs = () => gm.get(JOBS, {}) || {};
    const myJob = () => { const id = templateId(); return id ? getJobs()[jobKey(location.host, id)] || null : null; };
    function saveJob(job) {
      const all = getJobs();
      for (const [k, j] of Object.entries(all)) if (now() - (j.ts || 0) > 24 * 3600 * 1000) delete all[k];
      if (job) all[jobKey(job.to.host, job.to.id)] = job;
      gm.set(JOBS, all);
    }
    function dropJob(job) { const all = getJobs(); delete all[jobKey(job.to.host, job.to.id)]; gm.set(JOBS, all); }

    function uccTabs() {
      const list = [];
      for (const k of gm.keys()) {
        if (!String(k).startsWith(PRESENCE_PREFIX)) continue;
        const p = gm.get(k, null);
        if (!p || p.tab === TAB || !p.id) continue;
        if (now() - (p.ts || 0) < ALIVE_MS) list.push(p);
      }
      return list;
    }

    /** Чтение письма в другом UCC (другой сайт) — через Tampermonkey, с входом человека. Только GET. */
    function readOther(host, id) {
      if (host === location.host) return getJson(`/api/email/templates/${id}`);
      return new Promise((resolve, reject) => {
        const xhr = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : (typeof GM !== 'undefined' && GM.xmlHttpRequest);
        if (!xhr) { reject(new Error('Tampermonkey не дал доступ к другому UCC')); return; }
        xhr({
          method: 'GET', url: `https://${host}/api/email/templates/${id}`, headers: { Accept: 'application/json' },
          onload: (r) => {
            if (r.status === 401 || r.status === 403) { reject(new Error(`нет входа в UCC ${envName(host)} — откройте его и войдите`)); return; }
            if (r.status < 200 || r.status >= 300) { reject(new Error(`UCC ${envName(host)}: HTTP ${r.status}`)); return; }
            try { resolve(JSON.parse(r.responseText)); } catch { reject(new Error(`UCC ${envName(host)} ответил не JSON — возможно, нужен вход`)); }
          },
          onerror: () => reject(new Error(`UCC ${envName(host)} недоступен (VPN?)`)),
        });
      });
    }
    /** «https://ucc.iqoption.com/email-templates/4097/edit» или «4097» → { host, id } */
    function parseTarget(text, fallbackHost) {
      const s = String(text || '').trim();
      const m = s.match(/https?:\/\/([^/]+)\/email-templates\/(\d+)/);
      if (m) return { host: m[1], id: m[2] };
      if (/^\d+$/.test(s)) return { host: fallbackHost, id: s };
      return null;
    }
    const codesOf = (tpl) => (tpl.locales || []).map((l) => String(l.locale?.short_name || l.locale?.name || '').toLowerCase()).filter(Boolean);

    // ─── Окно переноса (в письме-источнике) ───────────────────────────────────
    /** Источник переноса: это письмо UCC (по умолчанию) или студия. */
    function uccSource() {
      const mine = metaCache.get(templateId()) || {};
      return {
        title: `Перенос ${envName(location.host)} → ${envName(otherHost(location.host))}`,
        fromLabel: `Откуда · UCC ${envName(location.host)}`,
        fromText: `${mine.name || `id ${templateId()}`}${mine.microservice ? ` · ${mine.microservice}` : ''} · ${mine.locales || '?'} лок.`,
        name: mine.name, microservice: mine.microservice,
        toHost: otherHost(location.host), anyEnv: false,
        collect: () => collect(templateId()),
        from: (src) => ({ host: location.host, label: envName(location.host), id: src.id, name: src.name, microservice: src.microservice }),
      };
    }
    function openTransfer(source = uccSource()) {
      document.getElementById(MENU_ID)?.remove();
      let toHost = source.toHost;
      const box = el2('div', 'position:fixed;right:20px;bottom:64px;z-index:99999;width:420px;max-height:75vh;overflow:auto;background:#0f1722;color:#e6edf7;border:1px solid #2a3647;border-radius:12px;box-shadow:0 18px 40px rgba(0,0,0,.45);font:12px/1.5 sans-serif;padding:14px 16px');
      box.id = MENU_ID;
      const head = el2('div', 'display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:14px', source.title);
      const x = el2('button', 'background:none;border:0;color:#8a98ad;font-size:16px;cursor:pointer', '×'); x.onclick = () => box.remove(); head.append(x);
      box.append(head);
      const mine = { name: source.name, microservice: source.microservice };
      const card = (label, text, color) => { const c = el2('div', `margin-top:8px;padding:8px 10px;border-radius:9px;background:#152030;border:1px solid ${color}`); c.append(el2('div', 'color:#8a98ad;font-size:11px;text-transform:uppercase', label), el2('div', 'font-weight:600', text)); return c; };
      box.append(card(source.fromLabel, source.fromText, '#334155'));
      box.append(el2('div', 'text-align:center;color:#64748b;font-size:16px;margin:2px 0', '↓'));
      const toCard = el2('div', 'padding:8px 10px;border-radius:9px;background:#152030;border:1px dashed #475569');
      const paints = [];
      const toLabel = el2('div', 'color:#8a98ad;font-size:11px;text-transform:uppercase', `Куда · UCC ${envName(toHost)}`);
      toCard.append(toLabel);
      if (source.anyEnv) {
        const envRow = el2('div', 'display:flex;gap:6px;margin-top:6px');
        for (const h of ['ucc.int.iqoption.com', 'ucc.iqoption.com']) {
          const b = el2('button', 'flex:1;padding:5px;border-radius:7px;border:1px solid #334155;cursor:pointer;font:600 12px sans-serif', envName(h));
          const paint = () => { b.style.background = toHost === h ? '#2563eb' : '#1e293b'; b.style.color = '#fff'; };
          b.onclick = () => { toHost = h; toLabel.textContent = `Куда · UCC ${envName(toHost)}`; for (const f of paints) f(); input.placeholder = `ссылка на письмо ${envName(toHost)} или его номер`; check(); };
          paints.push(paint); paint();
          envRow.append(b);
        }
        toCard.append(envRow);
      }
      const open = uccTabs().filter((t) => source.anyEnv || t.host === toHost);
      const same = open.find((t) => mine.name && t.name === mine.name && t.host === toHost && (t.microservice || '') === (mine.microservice || ''));
      const input = el2('input', 'width:100%;box-sizing:border-box;margin-top:6px;padding:7px 9px;border-radius:7px;border:1px solid #334155;background:#0b1220;color:#e6edf7;font:inherit');
      input.placeholder = `ссылка на письмо ${envName(toHost)} или его номер`;
      if (same) input.value = `https://${same.host}/email-templates/${same.id}/edit`;
      toCard.append(input);
      for (const t of open) {
        const b = el2('button', 'display:inline-block;margin:6px 6px 0 0;padding:4px 8px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#e6edf7;cursor:pointer;font:inherit', `открыто${source.anyEnv ? ` ${envName(t.host)}` : ''}: ${t.name || `id ${t.id}`}`);
        b.onclick = () => { toHost = t.host; toLabel.textContent = `Куда · UCC ${envName(toHost)}`; for (const f of paints) f(); input.value = `https://${t.host}/email-templates/${t.id}/edit`; check(); };
        toCard.append(b);
      }
      box.append(toCard);
      const result = el2('div', 'margin-top:10px');
      box.append(result);
      document.body.appendChild(box);

      let timer = 0;
      input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(check, 400); });
      async function check() {
        result.textContent = '';
        const target = parseTarget(input.value, toHost);
        if (!target) { if (input.value.trim()) result.append(el2('div', 'color:#fbbf24', 'Нужна ссылка вида …/email-templates/4097/edit или номер письма.')); return; }
        result.append(el2('div', 'color:#94a3b8', 'Читаю оба письма…'));
        try {
          const [src, dst] = await Promise.all([source.collect(), readOther(target.host, target.id)]);
          result.textContent = '';
          const dstCodes = codesOf(dst);
          const srcCodes = src.locales.map((l) => l.code.toLowerCase());
          const both = srcCodes.filter((c) => dstCodes.includes(c));
          const noTarget = srcCodes.filter((c) => !dstCodes.includes(c));
          const onlyTarget = dstCodes.filter((c) => !srcCodes.includes(c));
          const sameName = !src.name || dst.name === src.name;
          result.append(el2('div', `font-weight:600;color:${sameName ? '#86efac' : '#fbbf24'}`, `${sameName ? '✓' : '⚠'} ${envName(target.host)}: «${dst.name}» (${dst.microservice_name || '—'})${sameName ? '' : ' — имя не совпадает'}`));
          const legend = (list, color, title) => {
            if (!list.length) return;
            const row = el2('div', 'margin-top:6px');
            row.append(el2('div', 'color:#8a98ad', title));
            const chips = el2('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-top:3px');
            for (const c of list) chips.append(el2('span', `padding:2px 7px;border-radius:6px;background:${color}`, c.toUpperCase()));
            row.append(chips);
            result.append(row);
          };
          const hasSubjects = src.locales.some((l) => l.subject);
          legend(both, '#14532d', `Перенесётся (${both.length}): ${hasSubjects ? 'код + Subject' : 'код (тема остаётся как в UCC)'}`);
          legend(noTarget, '#7c2d12', `Нет в ${envName(target.host)} (${noTarget.length}): добавьте локаль «+» в целевом письме — потом перенесётся`);
          legend(onlyTarget, '#334155', `Есть только в ${envName(target.host)} (${onlyTarget.length}): не трогаем`);
          const go = el2('button', 'display:block;width:100%;margin-top:12px;padding:10px;border-radius:9px;border:0;background:#2563eb;color:#fff;font:600 13px sans-serif;cursor:pointer', `Открыть письмо ${envName(target.host)} и перенести →`);
          go.onclick = () => {
            saveJob({
              ts: now(),
              from: source.from(src),
              to: { host: target.host, id: String(target.id), name: dst.name },
              locales: src.locales.map((l) => ({ code: l.code.toLowerCase(), subject: l.subject, html: l.html })),
              done: {},
            });
            const tabOpen = open.find((t) => String(t.id) === String(target.id));
            if (tabOpen) { result.append(el2('div', 'margin-top:8px;color:#86efac', `Задание отправлено во вкладку ${envName(target.host)} — перейдите туда.`)); return; }
            W.open(`https://${target.host}/email-templates/${target.id}/edit`, '_blank');
            box.remove();
          };
          result.append(go);
          result.append(el2('div', 'margin-top:6px;color:#64748b', 'В UCC ничего не сохраняется само: в целевом письме помощник вставит код локали, Save нажимаете вы.'));
        } catch (error) {
          result.textContent = '';
          result.append(el2('div', 'color:#fecaca', `✕ ${error?.message || error}`));
        }
      }
      if (input.value) check();
    }

    // ─── Помощник в целевом письме ────────────────────────────────────────────
    function localeTabs() {
      return [...(document.querySelectorAll?.('.ant-tabs-tab') || [])]
        .map((el) => ({ el, code: String(el.innerText || el.textContent || '').trim().toLowerCase() }))
        .filter((t) => /^[a-z]{2,3}$/.test(t.code));
    }
    function activeLocale() {
      const t = document.querySelector?.('.ant-tabs-tab-active');
      return String(t?.innerText || t?.textContent || '').trim().toLowerCase();
    }
    function aceEditor() {
      const el = document.querySelector?.('.ace_editor');
      const ace = W.ace;
      if (!el || !ace?.edit) throw new Error('редактор кода UCC не найден');
      return ace.edit(el);
    }
    function subjectInput() {
      const inputs = [...(document.querySelectorAll?.('input') || [])];
      return inputs.find((i) => /subject/i.test(i.closest?.('div')?.innerText || '')) || null;
    }
    function setSubject(input, text) {
      const proto = W.HTMLInputElement?.prototype;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, text); else input.value = text;
      input.dispatchEvent(new W.Event('input', { bubbles: true }));
      input.dispatchEvent(new W.Event('change', { bubbles: true }));
    }
    /** Вставить в ОТКРЫТУЮ локаль её HTML и Subject из задания. Ничего не сохраняет. */
    function insertActive(job) {
      const code = activeLocale();
      const loc = job.locales.find((l) => l.code === code);
      if (!loc) throw new Error(`в письме-источнике нет локали ${code.toUpperCase() || '?'}`);
      if (envName(location.host) === 'PROD' && !job.prodOk) {
        if (!W.confirm?.(`Это PROD UCC. Переносим «${job.from.name}» из ${job.from.label || envName(job.from.host)}.\nКод вставляется в редактор, сохраняете вы кнопкой Save. Продолжить?`)) return null;
        job.prodOk = true;
      }
      const ed = aceEditor();
      ed.setValue(loc.html, -1);
      if (ed.getValue() !== loc.html) throw new Error('редактор не принял код');
      const subj = loc.subject ? subjectInput() : null;
      if (subj) setSubject(subj, loc.subject);
      job.done = { ...(job.done || {}), [code]: true };
      saveJob(job);
      return { code, subject: Boolean(subj) };
    }

    // ─── Перенос всего разом (API UCC, тот же, что у кнопок «+» и Save) ─────────
    // Из кода UCC (chunk 1384): addLocales = POST /api/email/templates/<id>/locales [{locale_id}],
    // сохранение локали = PUT /api/email/templates/<id>/locales/<запись локали> {subject, html_body}.
    // «Set as Ready» (register) НЕ делаем — это решение человека.
    async function sendJson(method, url, body) {
      const res = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.status === 403) throw new Error('UCC: нет прав (403)');
      if (res.status === 204) return {};
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok || data?.error || data?.errors) throw new Error(`UCC ${method} ${url.replace(/^.*\/api\//, '/api/')}: ${res.status} ${JSON.stringify(data?.error || data?.errors || '').slice(0, 200)}`);
      return data;
    }
    /** Каталог локалей UCC: короткий код → locale_id. Берём из /api/init, иначе из списка писем. */
    let localeCatalog = null;
    async function getLocaleCatalog() {
      if (localeCatalog) return localeCatalog;
      const map = {};
      const take = (arr) => { for (const x of arr || []) { const code = String(x?.short_name || x?.locale?.short_name || '').toLowerCase(); const id = x?.locale_id ?? (x?.short_name ? x?.id : undefined); if (code && id != null && map[code] == null) map[code] = id; } };
      const walk = (v, depth = 0) => {
        if (!v || depth > 4) return;
        if (Array.isArray(v)) { if (v.some((x) => x && (x.short_name || x.locale?.short_name))) take(v); else v.forEach((x) => walk(x, depth + 1)); return; }
        if (typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
      };
      try { walk(await getJson('/api/init')); } catch {}
      if (Object.keys(map).length < 10) {
        try {
          const list = await getJson('/api/email/templates?with=locales&page=1&perpage=100');
          for (const t of asList(list).concat(list?.templates || [])) take(t.locales);
        } catch {}
      }
      localeCatalog = map;
      return map;
    }
    async function autoTransferAll(job, report) {
      const id = templateId();
      const base = `/api/email/templates/${id}`;
      let tpl = await getJson(base);
      const have = new Map((tpl.locales || []).map((l) => [String(l.locale?.short_name || '').toLowerCase(), l]));
      const missing = job.locales.map((l) => l.code).filter((c) => !have.has(c));
      const catalog = missing.length ? await getLocaleCatalog() : {};
      const creatable = missing.filter((c) => catalog[c] != null);
      const unknown = missing.filter((c) => catalog[c] == null);
      const isProd = envName(location.host) === 'PROD';
      const plan = `${isProd ? '⚠ PROD UCC\n' : ''}Письмо «${tpl.name}»:\n` +
        `• создать локали (${creatable.length}): ${creatable.map((c) => c.toUpperCase()).join(', ') || '—'}\n` +
        `• залить код${job.locales.some((l) => l.subject) ? ' + тему' : ''} (${job.locales.length - unknown.length}): ${job.locales.filter((l) => !unknown.includes(l.code)).map((l) => l.code.toUpperCase()).join(', ')}\n` +
        (unknown.length ? `• нет в каталоге UCC (пропущу): ${unknown.map((c) => c.toUpperCase()).join(', ')}\n` : '') +
        `«Set as Ready» не нажимаю. Продолжить?`;
      if (!W.confirm?.(plan)) return null;
      if (creatable.length) {
        report(`Создаю локали: ${creatable.map((c) => c.toUpperCase()).join(', ')}…`);
        await sendJson('POST', `${base}/locales`, creatable.map((c) => ({ locale_id: catalog[c] })));
        tpl = await getJson(base);
      }
      const records = new Map((tpl.locales || []).map((l) => [String(l.locale?.short_name || '').toLowerCase(), l]));
      const res = { ok: [], failed: [], skipped: unknown.slice() };
      for (const l of job.locales) {
        const rec = records.get(l.code);
        if (!rec) { if (!res.skipped.includes(l.code)) res.skipped.push(l.code); continue; }
        report(`Заливаю ${l.code.toUpperCase()}… (${res.ok.length + res.failed.length + 1}/${job.locales.length})`);
        try {
          await sendJson('PUT', `${base}/locales/${rec.id}`, { subject: l.subject || rec.subject || '', html_body: l.html });
          res.ok.push(l.code);
          job.done = { ...(job.done || {}), [l.code]: true };
        } catch (error) { res.failed.push(`${l.code.toUpperCase()}: ${error.message}`); }
      }
      // Проверка: перечитать и сравнить
      try {
        const after = await getJson(base);
        for (const l of after.locales || []) {
          const c = String(l.locale?.short_name || '').toLowerCase();
          const src = job.locales.find((x) => x.code === c);
          if (src && res.ok.includes(c) && (l.html_body || '') !== src.html) { res.ok = res.ok.filter((x) => x !== c); res.failed.push(`${c.toUpperCase()}: UCC сохранил не тот HTML`); }
        }
      } catch {}
      saveJob(job);
      return res;
    }

    let guideNote = '';
    let guideSig = '';
    function renderGuide() {
      const job = myJob();
      let g = document.getElementById(GUIDE_ID);
      if (!job) { g?.remove(); guideSig = ''; return; }
      // Перерисовываем только когда что-то поменялось — иначе окно «мигает» под курсором.
      const sig = JSON.stringify([job.ts, job.done, activeLocale(), localeTabs().map((t) => t.code), guideNote]);
      if (g && g.isConnected !== false && sig === guideSig) return;
      guideSig = sig;
      if (!g) { g = el2('div', ''); g.id = GUIDE_ID; document.body.appendChild(g); }
      g.style.cssText = 'position:fixed;right:20px;bottom:64px;z-index:99998;width:400px;background:#0f1722;color:#e6edf7;border:2px solid #f59e0b;border-radius:12px;box-shadow:0 18px 40px rgba(0,0,0,.45);font:12px/1.5 sans-serif;padding:12px 14px';
      g.textContent = '';
      const targetCodes = localeTabs().map((t) => t.code);
      const todo = job.locales.filter((l) => targetCodes.length === 0 || targetCodes.includes(l.code));
      const missing = targetCodes.length ? job.locales.filter((l) => !targetCodes.includes(l.code)).map((l) => l.code) : [];
      const doneN = todo.filter((l) => job.done?.[l.code]).length;
      const act = activeLocale();
      const head = el2('div', 'display:flex;justify-content:space-between;align-items:center');
      head.append(el2('b', 'font-size:13px', `Перенос из ${job.from.label || envName(job.from.host)} · ${doneN}/${todo.length}`));
      const close = el2('button', 'background:none;border:0;color:#8a98ad;cursor:pointer;font:inherit', 'завершить ✕');
      close.onclick = () => { if (doneN === todo.length || W.confirm?.('Остановить перенос? Уже сохранённое останется.')) { dropJob(job); renderGuide(); } };
      head.append(close);
      g.append(head);
      g.append(el2('div', 'color:#94a3b8;margin:2px 0 8px', `«${job.from.name}» → это письмо${job.to.name && job.to.name !== job.from.name ? ' ⚠ имена разные' : ''}`));
      const chips = el2('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px');
      for (const l of todo) {
        const c = el2('button', `padding:3px 8px;border-radius:6px;border:${l.code === act ? '2px solid #60a5fa' : '1px solid transparent'};background:${job.done?.[l.code] ? '#14532d' : '#1e293b'};color:#e6edf7;cursor:pointer;font:inherit`, `${job.done?.[l.code] ? '✓ ' : ''}${l.code.toUpperCase()}`);
        c.onclick = () => { localeTabs().find((t) => t.code === l.code)?.el.click(); guideNote = ''; setTimeout(renderGuide, 400); };
        chips.append(c);
      }
      g.append(chips);
      const inJob = todo.some((l) => l.code === act);
      const steps = el2('div', 'background:#152030;border-radius:9px;padding:8px 10px');
      if (!inJob) {
        steps.append(el2('div', 'color:#fbbf24', act ? `Открыта ${act.toUpperCase()} — её нет в источнике. Выберите локаль выше.` : 'Выберите локаль выше.'));
      } else {
        const done = job.done?.[act];
        steps.append(el2('div', 'font-weight:600;margin-bottom:6px', `Локаль ${act.toUpperCase()}`));
        const ins = el2('button', `width:100%;padding:9px;border-radius:8px;border:0;background:${done ? '#334155' : '#2563eb'};color:#fff;font:600 13px sans-serif;cursor:pointer`, done ? `↻ Вставить ${act.toUpperCase()} ещё раз` : `1. Вставить ${act.toUpperCase()} (${job.locales.some((l) => l.subject) ? 'код + Subject' : 'код'})`);
        ins.onclick = () => {
          try { const r = insertActive(job); if (!r) return; const hasSubj = job.locales.find((l) => l.code === r.code)?.subject; guideNote = r.subject || !hasSubj ? '' : 'Поле Subject не найдено — тему вставьте вручную.'; }
          catch (error) { guideNote = `✕ ${error.message}`; }
          renderGuide();
        };
        steps.append(ins);
        steps.append(el2('div', `margin:6px 0;color:${done ? '#86efac' : '#64748b'}`, '2. Проверьте превью и нажмите Save в UCC'));
        const next = todo.find((l) => !job.done?.[l.code] && l.code !== act);
        const nb = el2('button', 'width:100%;padding:8px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#e6edf7;font:inherit;cursor:pointer', next ? `3. Дальше: ${next.code.toUpperCase()} →` : (doneN === todo.length ? '✓ Все локали вставлены — завершить' : '3. Дальше →'));
        nb.onclick = () => {
          if (!next) { if (doneN === todo.length) { dropJob(job); renderGuide(); } return; }
          localeTabs().find((t) => t.code === next.code)?.el.click();
          guideNote = ''; setTimeout(renderGuide, 400);
        };
        steps.append(nb);
      }
      const allBtn = el2('button', 'width:100%;margin-bottom:8px;padding:10px;border-radius:9px;border:0;background:#16a34a;color:#fff;font:700 13px sans-serif;cursor:pointer', `⚡ Перенести всё сразу (${todo.length + missing.length} лок.)`);
      allBtn.title = 'Создаст недостающие локали и сохранит в каждую код и тему. «Set as Ready» не нажимает.';
      allBtn.onclick = async () => {
        allBtn.disabled = true;
        try {
          const r = await autoTransferAll(job, (t) => { allBtn.textContent = t; });
          if (!r) { allBtn.disabled = false; renderGuide(); return; }
          const msg = `✓ Сохранено: ${r.ok.length}${r.failed.length ? `\n✕ Ошибки: ${r.failed.join('; ')}` : ''}${r.skipped.length ? `\nПропущено (нет в каталоге UCC): ${r.skipped.map((c) => c.toUpperCase()).join(', ')}` : ''}\n\nСтраница обновится, чтобы показать локали.`;
          W.alert?.(msg);
          if (!r.failed.length) dropJob(job);
          try { W.location.reload(); } catch {}
        } catch (error) { guideNote = `✕ ${error.message}`; allBtn.disabled = false; guideSig = ''; renderGuide(); }
      };
      g.append(allBtn);
      g.append(el2('div', 'color:#64748b;margin:2px 0 6px', 'или по одной локали:'));
      g.append(steps);
      if (guideNote) g.append(el2('div', `margin-top:6px;color:${guideNote.startsWith('✕') ? '#fecaca' : '#fbbf24'}`, guideNote));
      if (missing.length) g.append(el2('div', 'margin-top:8px;color:#fdba74', `Нет в этом письме: ${missing.map((c) => c.toUpperCase()).join(', ')} — их создаст «⚡ Перенести всё» (или добавьте «+» вручную).`));
    }
    gm.on(JOBS, () => renderGuide());

    function section(menu, title) { menu.append(el2('div', 'color:#7d8ba1;font-size:11px;text-transform:uppercase;margin:10px 0 4px', title)); }
    function itemButton(label, sub, onClick) {
      const b = el2('button', 'display:block;width:100%;text-align:left;background:#152030;border:1px solid #243246;color:#e6edf7;border-radius:9px;padding:8px 10px;margin-bottom:6px;cursor:pointer;font:inherit');
      b.append(el2('b', '', label));
      if (sub) b.append(el2('span', 'color:#8a98ad;margin-left:6px', sub));
      b.onclick = onClick;
      return b;
    }

    function openMenu() {
      document.getElementById(MENU_ID)?.remove();
      const menu = el2('div', 'position:fixed;right:20px;bottom:64px;z-index:99999;width:380px;max-height:70vh;overflow:auto;background:#0f1722;color:#e6edf7;border:1px solid #2a3647;border-radius:12px;box-shadow:0 18px 40px rgba(0,0,0,.45);font:12px/1.45 sans-serif;padding:12px 14px');
      menu.id = MENU_ID;
      const head = el2('div', 'display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:13px', `RetKit · UCC ${envName(location.host)}`);
      const x = el2('button', 'background:none;border:0;color:#8a98ad;font-size:16px;cursor:pointer', '×'); x.onclick = () => menu.remove(); head.append(x);
      menu.append(head);
      const out = el2('div', 'margin-top:8px;color:#cbd5e1;white-space:pre-wrap');

      section(menu, 'Это письмо');
      menu.append(itemButton('⬇ ZIP письма', 'все локали: HTML + Subject + параметры', async () => {
        out.textContent = 'Собираю ZIP…';
        try { const r = await exportZip(templateId()); out.textContent = `✓ ZIP: ${r.locales} локалей`; out.style.color = '#86efac'; }
        catch (error) { out.textContent = `✕ ${error.message}`; out.style.color = '#fecaca'; }
      }));
      const to = envName(otherHost(location.host));
      menu.append(itemButton(`⇄ Перенести в UCC ${to}`, `в то же письмо в ${to}: код + Subject по локалям`, () => openTransfer()));

      section(menu, '→ MoEngage');
      const mo = moTabs();
      if (!mo.length) menu.append(el2('div', 'color:#8a98ad', 'Нет открытых писем MoEngage (откройте письмо на шаге контента).'));
      for (const t of mo) menu.append(itemButton(moLabel(t), t.locales?.length ? `${t.locales.length} лок.: ${t.locales.join(', ')}` : '', () => send(t, menu)));
      menu.append(out);
      document.body.appendChild(menu);
    }

    function syncPill() {
      const id = templateId();
      let pill = document.getElementById(PILL_ID);
      if (!id) { pill?.remove(); document.getElementById(MENU_ID)?.remove(); return; }
      if (!pill) {
        pill = el2('button', 'position:fixed;right:20px;bottom:20px;z-index:99999;padding:10px 16px;border-radius:999px;border:0;font:600 13px/1 sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25);display:flex;align-items:center;gap:7px;cursor:pointer;max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis');
        pill.id = PILL_ID; pill.type = 'button';
        pill.onclick = () => (document.getElementById(MENU_ID) ? document.getElementById(MENU_ID).remove() : openMenu());
        document.body.appendChild(pill);
      }
      const links = moTabs().length;
      const job = myJob();
      pill.style.background = job ? '#b45309' : links ? '#15803d' : '#3b5bfd';
      pill.style.color = '#fff';
      pill.textContent = '';
      const d = el2('span', `width:8px;height:8px;border-radius:50%;flex:0 0 8px;background:${links ? '#4ade80' : '#cbd5e1'}`);
      pill.append(d, document.createTextNode(job ? `RetKit ▾ · перенос из ${job.from.label || envName(job.from.host)}` : `RetKit ▾${links ? ` · MoEngage: ${links}` : ''}`));
      renderGuide();
      pill.title = 'RetKit: ZIP письма, перенос в MoEngage, перенос в другое письмо UCC';
    }
    // Клик мимо окна (и мимо кнопки) — окно закрывается.
    try {
      document.addEventListener('mousedown', (e) => {
        const menu = document.getElementById(MENU_ID);
        if (!menu) return;
        const pill = document.getElementById(PILL_ID);
        const t = e.target;
        if (menu.contains?.(t) || pill?.contains?.(t)) return;
        menu.remove();
      }, true);
    } catch {}
    if (IS_STUDIO) {
      // Студия: кнопка «→ UCC» во вкладке «Код», когда студия отдаёт локали письма.
      const studioApi = () => W.RetKitStudioExport;
      function studioSource() {
        const info = studioApi()?.info?.() || {};
        return {
          title: 'Перенос из студии → UCC',
          fromLabel: 'Откуда · студия RetKit (Код)',
          fromText: `${info.name || 'письмо'} · ${(info.locales || []).length} лок.: ${(info.locales || []).map((c) => c.toUpperCase()).join(', ')}`,
          name: info.name || '', microservice: '',
          toHost: 'ucc.int.iqoption.com', anyEnv: true,
          collect: async () => {
            const r = await studioApi().allLocales();
            return { id: 'studio', name: r.name || info.name || '', microservice: '', locales: r.locales.map((l) => ({ code: String(l.code).toLowerCase(), subject: l.subject || '', html: l.html })) };
          },
          from: (src) => ({ host: 'studio', label: 'студии', id: 'studio', name: src.name, microservice: '' }),
        };
      }
      function syncStudio() {
        let b = document.getElementById(PILL_ID);
        const api = studioApi();
        if (!api) { b?.remove(); return; } // не «Код» (или старая студия)
        const info = api.info?.() || { locales: [] };
        const n = (info.locales || []).length;
        if (!b) {
          b = el2('button', 'position:fixed;right:20px;bottom:20px;z-index:99999;padding:10px 16px;border-radius:999px;border:0;background:#3b5bfd;color:#fff;font:600 13px/1 sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer');
          b.id = PILL_ID; b.type = 'button';
          b.title = 'RetKit: перенести локали этого письма в письмо UCC (INT или PROD)';
          b.onclick = () => {
            if (document.getElementById(MENU_ID)) { document.getElementById(MENU_ID).remove(); return; }
            if (!(studioApi()?.info?.()?.locales || []).length) { W.alert?.('RetKit → UCC: откройте письмо с локалями (из базы или HTML + папка локалей) — тогда его можно перенести в UCC.'); return; }
            openTransfer(studioSource());
          };
          document.body.appendChild(b);
        }
        b.textContent = n ? `→ UCC · ${n} лок.` : '→ UCC';
        b.style.opacity = n ? '1' : '.6';
      }
      syncStudio();
      setInterval(syncStudio, 2000);
      return;
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
    gm.on(KEY.push, (req, remote) => { if (remote && req?.transfer && (!req.targetTab || req.targetTab === TAB)) for (const fn of listeners.push) { try { fn(req); } catch {} } });
    // Присутствие этой вкладки MoEngage — для индикатора в UCC.
    function moTitle() {
      const pick = (sel) => { try { return String(document.querySelector(sel)?.value || document.querySelector(sel)?.textContent || '').trim(); } catch { return ''; } };
      return pick('input[name*="campaign" i][name*="name" i]') || pick('[data-testid*="campaign-name" i]') || String(document.title || '').replace(/\s*[|·-]\s*MoEngage.*$/i, '').trim();
    }
    let moLocales = []; let moLocalesAt = 0;
    function moBeat() {
      // RetKit открыт (полноэкранный редактор письма) или видны вкладки локалей MoEngage.
      let locale = '';
      const a = W.__RetKitMoEngageBridgeApi;
      try { locale = a?.getNativeTabLocale?.() || ''; } catch {}
      const editor = (Boolean(document.getElementById('retkit-mo-workspace')) || Boolean(locale)) && !/settings/i.test(String(location.href || ''));
      if (editor && a?.listLocales && now() - moLocalesAt > 15000) {
        moLocalesAt = now();
        Promise.resolve(a.listLocales()).then((l) => { moLocales = Array.isArray(l) ? l.map(String) : []; }).catch(() => {});
      }
      const campaign = (String(location.href || '').match(/[0-9a-f]{24}/i) || [''])[0];
      gm.set(MO_PREFIX + TAB, { ts: now(), tab: TAB, title: moTitle(), campaign, locales: moLocales, path: location.pathname + location.hash, editor });
    }
    moBeat();
    setInterval(moBeat, 2000);
    try { document.addEventListener('visibilitychange', moBeat); } catch {}
    try { W.addEventListener('pagehide', () => gm.del(MO_PREFIX + TAB)); } catch {}
    W.__RetKitUccLink = {
      version: '0.12.0',
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
      /** Ход переноса, начатого из UCC, — кнопка UCC показывает его. */
      reportStatus(requestId, patch) { gm.set(KEY.status, { ...patch, requestId, ts: now() }); },
    };
    try { W.dispatchEvent(new W.CustomEvent('retkit:ucc-link-ready')); } catch {}
  }

  // ─── Конвейер: команды из почтового ящика RetKit bridge (127.0.0.1:43118) ──
  // claude → ucc { type:'open', uccId }: открыть письмо (переход по адресу), затем
  //   ucc → mo     { type:'transfer', uccId, host, transfer }  — код для заливки,
  //   ucc → claude { type:'summary', uccId, ... }               — короткая сводка без HTML.
  // В UCC — только GET. Если bridge не запущен, цикл тихо ждёт.
  const MAILBOX = 'http://127.0.0.1:43118/mailbox';
  const PENDING_KEY = 'retkit.ucc.mailbox.pending';
  async function mbPost(to, body) {
    const res = await (W.fetch || fetch)(`${MAILBOX}/post`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'ucc', to, ...body }) });
    if (!res.ok) throw new Error(`mailbox HTTP ${res.status}`);
    return res.json();
  }
  function summaryOf(t) {
    return {
      uccId: t.id, host: t.host, name: t.name, microservice: t.microservice, sender: t.sender, senderEmail: t.senderEmail, senderName: t.senderName,
      locales: t.locales.map((l) => ({ ucc: l.ucc, mo: l.mo, subject: l.subject, bytes: l.html.length })),
      skipped: t.skipped, empty: t.empty, placeholders: Object.keys(t.placeholders || {}), footerLeftovers: t.footerLeftovers,
    };
  }
  async function exportFor(cmd) {
    try {
      const mail = await collect(cmd.uccId);
      const transfer = transferFor(mail);
      await mbPost('mo', { type: 'transfer', uccId: String(transfer.id), host: transfer.host, transfer });
      await mbPost('claude', { type: 'summary', cmd: cmd.id, ...summaryOf(transfer) });
    } catch (error) {
      try { await mbPost('claude', { type: 'error', cmd: cmd.id, uccId: cmd.uccId, error: error?.message || String(error) }); } catch {}
    }
  }
  function uccMailbox() {
    let after = 0;
    let started = false;
    async function handle(cmd) {
      if (cmd.type !== 'open' || !cmd.uccId) return;
      // Без перехода: письмо читается через API UCC по номеру с любой страницы UCC.
      // (Перезагрузка страницы запускает вход UCC, который ломает адрес.)
      await exportFor(cmd);
    }
    const AFTER_KEY = 'retkit.ucc.mailbox.after';
    const saveAfter = (v) => { try { sessionStorage.setItem(AFTER_KEY, String(v)); } catch {} };
    async function loop() {
      // Номер последней обработанной команды переживает переход на другое письмо:
      // команды, пришедшие во время перезагрузки, не теряются.
      try { after = Number(sessionStorage.getItem(AFTER_KEY) || 0); started = after > 0; } catch {}
      for (;;) {
        try {
          const url = `${MAILBOX}/poll?to=ucc&after=${after}&wait=${started ? 25000 : 0}`;
          const res = await (W.fetch || fetch)(url);
          const data = await res.json();
          if (!started || (data.lastId || 0) < after) { after = data.lastId || 0; saveAfter(after); started = true; continue; } // новая вкладка или перезапуск bridge — старые команды не выполняем
          for (const m of data.messages || []) {
            after = Math.max(after, m.id); saveAfter(after);
            if (m.from !== 'claude') continue;
            if (m.type === 'status') { await mbPost('claude', { type: 'status', cmd: m.id, url: location.href, templateId: templateId(), version: '0.12.0' }).catch(() => {}); continue; }
            await handle(m);
          }
        } catch {
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
    // Команда пришла до перехода на нужное письмо — выполнить после загрузки (и доложить, если не вышло).
    try {
      const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
      if (pending) {
        sessionStorage.removeItem(PENDING_KEY);
        const started = Date.now();
        const wait = () => {
          if (String(templateId()) === String(pending.uccId)) { exportFor(pending); return; }
          if (Date.now() - started > 30000) { mbPost('claude', { type: 'error', cmd: pending.id, uccId: pending.uccId, error: `UCC не открыл письмо ${pending.uccId}: сейчас ${location.href}` }).catch(() => {}); return; }
          setTimeout(wait, 500);
        };
        setTimeout(wait, 1000);
      }
    } catch {}
    mbPost('claude', { type: 'ready', url: location.href, templateId: templateId(), version: '0.12.0' }).catch(() => {});
    loop();
  }

  W.__retkitUccExport = { collect, filesFor, makeZip, exportZip, transferFor, applyFooter, summaryOf, MAP };
  if (IS_UCC) {
    sync();
    setInterval(sync, 1000); // UCC — одностраничное приложение, адрес меняется без перезагрузки
    uccLink();
    if (typeof sessionStorage !== "undefined") uccMailbox(); // в тестах (vm) ящика нет
  } else if (IS_STUDIO) {
    uccLink();
  } else if (/moengage\.com$/.test(location.host)) {
    moengageLink();
  }
})();

