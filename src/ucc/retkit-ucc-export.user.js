// ==UserScript==
// @name         RetKit UCC Export
// @namespace    https://github.com/Brokenbass90/retkit-moeng
// @version      0.9.1
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
// @connect      127.0.0.1
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
    heartbeat();
    setInterval(heartbeat, 2000);
    try { document.addEventListener('visibilitychange', heartbeat); } catch {}
    try { W.addEventListener('pagehide', () => gm.del(PRESENCE_PREFIX + TAB)); } catch {}

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

    // ─── UCC ⇄ UCC (INT ⇄ PROD): другие вкладки UCC и то, что пришло в эту ─────
    const U2U = 'retkit.ucc.u2u';
    const INCOMING_KEY = 'retkit.ucc.incoming';
    const envName = (host) => (/\.int\./.test(host) ? 'INT' : 'PROD');
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
    let incoming = null;
    try { incoming = JSON.parse(sessionStorage.getItem(INCOMING_KEY) || 'null'); } catch {}
    const saveIncoming = () => { try { incoming ? sessionStorage.setItem(INCOMING_KEY, JSON.stringify(incoming)) : sessionStorage.removeItem(INCOMING_KEY); } catch {} };

    function activeLocale() {
      const t = document.querySelector?.('.ant-tabs-tab-active');
      return String(t?.innerText || t?.textContent || '').trim().toLowerCase();
    }
    function aceEditor() {
      const el = document.querySelector?.('.ace_editor');
      const ace = W.ace;
      if (!el || !ace?.edit) throw new Error('редактор кода UCC не найден — откройте письмо');
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
    /** Вставить в ОТКРЫТУЮ локаль письма UCC её HTML и Subject из пришедшего письма. Ничего не сохраняет. */
    function insertActive() {
      if (!incoming) throw new Error('ничего не пришло');
      const code = activeLocale();
      const loc = incoming.locales.find((l) => l.code.toLowerCase() === code);
      if (!loc) throw new Error(`в пришедшем письме нет локали ${code.toUpperCase() || '?'}`);
      if (envName(location.host) === 'PROD' && !W.confirm?.(`Это PROD UCC. Вставить ${code.toUpperCase()} из «${incoming.from.name}» (${envName(incoming.from.host)}) в редактор?\nСохранение — только вашей кнопкой Save.`)) return null;
      const ed = aceEditor();
      ed.setValue(loc.html, -1);
      if (ed.getValue() !== loc.html) throw new Error('редактор не принял код');
      const subj = subjectInput();
      if (subj) setSubject(subj, loc.subject);
      incoming.done = { ...(incoming.done || {}), [code]: true };
      saveIncoming();
      return { code, subject: Boolean(subj) };
    }

    gm.on(U2U, (msg, remote) => {
      if (!remote || !msg || msg.targetTab !== TAB || now() - (msg.ts || 0) > 120000) return;
      incoming = { from: msg.from, locales: msg.locales, ts: msg.ts, done: {} };
      saveIncoming();
      openMenu();
    });

    async function sendToUcc(target, out) {
      out.textContent = 'Читаю письмо…';
      try {
        const mail = await collect(templateId());
        gm.set(U2U, {
          ts: now(), targetTab: target.tab,
          from: { host: location.host, id: mail.id, name: mail.name, microservice: mail.microservice },
          locales: mail.locales.map((l) => ({ code: l.code, subject: l.subject, html: l.html })),
        });
        out.textContent = `Отправлено в ${envName(target.host)} «${target.name || target.id}». Там откроется окно — вставляйте по локалям и сохраняйте в UCC.`;
        out.style.color = '#86efac';
      } catch (error) {
        out.textContent = `Ошибка: ${error?.message || error}`;
        out.style.color = '#fecaca';
      }
    }

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

      // Пришло из другого UCC — вставка по локалям.
      if (incoming) {
        const cur = metaCache.get(templateId()) || {};
        section(menu, `Пришло из UCC ${envName(incoming.from.host)}`);
        const same = cur.name && cur.name === incoming.from.name && (cur.microservice || '') === (incoming.from.microservice || '');
        menu.append(el2('div', `color:${same ? '#cbd5e1' : '#fbbf24'};margin-bottom:6px`,
          `«${incoming.from.name}» (${incoming.from.microservice || '—'}, id ${incoming.from.id})${same ? '' : `\n⚠ Открыто другое письмо: «${cur.name || '?'}»`}`));
        const chips = el2('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px');
        const act = activeLocale();
        for (const l of incoming.locales) {
          const c = l.code.toLowerCase();
          const done = incoming.done?.[c];
          chips.append(el2('span', `padding:2px 7px;border-radius:6px;background:${done ? '#14532d' : c === act ? '#1d4ed8' : '#1e293b'};color:#e6edf7`, `${done ? '✓ ' : ''}${c.toUpperCase()}`));
        }
        menu.append(chips);
        menu.append(itemButton(`Вставить в открытую локаль ${act.toUpperCase() || '?'}`, 'HTML + Subject, без сохранения', () => {
          try {
            const r = insertActive();
            if (!r) return;
            out.textContent = `✓ ${r.code.toUpperCase()} вставлена${r.subject ? '' : ' (поле Subject не найдено — вставьте тему вручную)'}. Проверьте и нажмите Save в UCC, затем откройте следующую локаль.`;
            out.style.color = '#86efac';
            openMenu();
          } catch (error) { out.textContent = `✕ ${error.message}`; out.style.color = '#fecaca'; menu.append(out); }
        }));
        menu.append(itemButton('Убрать пришедшее', '', () => { incoming = null; saveIncoming(); openMenu(); }));
      }

      section(menu, 'Это письмо');
      menu.append(itemButton('⬇ ZIP письма', 'все локали: HTML + Subject + параметры', async () => {
        out.textContent = 'Собираю ZIP…'; menu.append(out);
        try { const r = await exportZip(templateId()); out.textContent = `✓ ZIP: ${r.locales} локалей`; out.style.color = '#86efac'; }
        catch (error) { out.textContent = `✕ ${error.message}`; out.style.color = '#fecaca'; }
      }));

      section(menu, '→ MoEngage');
      const mo = moTabs();
      if (!mo.length) menu.append(el2('div', 'color:#8a98ad', 'Нет открытых писем MoEngage (откройте письмо на шаге контента).'));
      for (const t of mo) menu.append(itemButton(moLabel(t), t.locales?.length ? `${t.locales.length} лок.: ${t.locales.join(', ')}` : '', () => send(t, menu)));

      section(menu, '→ Другое письмо UCC (INT ⇄ PROD)');
      const ut = uccTabs();
      const mine = metaCache.get(templateId()) || {};
      if (!ut.length) menu.append(el2('div', 'color:#8a98ad', 'Откройте целевое письмо UCC в другой вкладке (PROD или INT) — оно появится здесь.'));
      for (const t of ut) {
        const match = mine.name && t.name === mine.name && (t.microservice || '') === (mine.microservice || '');
        menu.append(itemButton(`${envName(t.host)}: ${t.name || `id ${t.id}`}`, `${match ? '✓ то же письмо' : '⚠ другое имя'} · ${t.locales || '?'} лок.`, () => { menu.append(out); sendToUcc(t, out); }));
      }
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
      const links = moTabs().length + uccTabs().length;
      pill.style.background = incoming ? '#b45309' : links ? '#15803d' : '#3b5bfd';
      pill.style.color = '#fff';
      pill.textContent = '';
      const d = el2('span', `width:8px;height:8px;border-radius:50%;flex:0 0 8px;background:${links ? '#4ade80' : '#cbd5e1'}`);
      pill.append(d, document.createTextNode(incoming ? `RetKit ▾ · пришло из ${envName(incoming.from.host)}` : `RetKit ▾${links ? ` · на связи: ${links}` : ''}`));
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
      version: '0.9.1',
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
            if (m.type === 'status') { await mbPost('claude', { type: 'status', cmd: m.id, url: location.href, templateId: templateId(), version: '0.9.1' }).catch(() => {}); continue; }
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
    mbPost('claude', { type: 'ready', url: location.href, templateId: templateId(), version: '0.9.1' }).catch(() => {});
    loop();
  }

  W.__retkitUccExport = { collect, filesFor, makeZip, exportZip, transferFor, applyFooter, summaryOf, MAP };
  if (IS_UCC) {
    sync();
    setInterval(sync, 1000); // UCC — одностраничное приложение, адрес меняется без перезагрузки
    uccLink();
    if (typeof sessionStorage !== "undefined") uccMailbox(); // в тестах (vm) ящика нет
  } else if (/moengage\.com$/.test(location.host)) {
    moengageLink();
  }
})();

