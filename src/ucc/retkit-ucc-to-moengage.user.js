// ==UserScript==
// @name         RetKit UCC → MoEngage
// @namespace    https://github.com/Brokenbass90/retkit-moeng
// @version      0.1.0
// @description  Мост: кнопка «→ MoEngage» в UCC переносит HTML и Subject всех локалей письма в открытое письмо MoEngage (футер заменяется по карте). UCC — только чтение.
// @match        https://ucc.iqoption.com/*
// @match        https://ucc.int.iqoption.com/*
// @match        https://dashboard-02.moengage.com/*
// @updateURL    https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/dist/retkit-ucc-to-moengage.user.js
// @downloadURL  https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/dist/retkit-ucc-to-moengage.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @sandbox      JavaScript
// @run-at       document-idle
// ==/UserScript==

/*
 * Как работает.
 *   Один и тот же скрипт стоит на UCC и на MoEngage. Вкладки разных сайтов
 *   общаются через хранилище Tampermonkey (GM_setValue + GM_addValueChangeListener):
 *   оно общее для всех вкладок одного скрипта.
 *
 *   UCC: кнопка «→ MoEngage» читает письмо теми же GET, что и страница
 *   (/api/email/templates/<id>, senders, categories), меняет футер по карте,
 *   сопоставляет локали UCC → MoEngage и кладёт задание в хранилище.
 *   В UCC ничего не сохраняется и не нажимается. JWT микросервиса в задание не попадает.
 *
 *   MoEngage: на вкладке с открытым письмом появляется панель задания
 *   (письмо, какие локали зальются, какие пропущены, отправитель).
 *   «Перенести» → недостающие локали добавляются, в каждую пишутся HTML и Subject
 *   через RetKit for MoEngage (__RetKitMoEngageBridgeApi), с проверкой, что MoEngage
 *   их удержал. Первую версию каждой локали RetKit сохраняет сам (кнопка «Original»).
 *   Кампанию в MoEngage сохраняет человек.
 *
 *   Ход и итог видны и на панели MoEngage, и на кнопке в UCC.
 *   Требуется: RetKit for MoEngage на той же вкладке MoEngage.
 */
(function () {
  'use strict';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (W.__retkitUccToMoengage) return;

  // ─── Карта замен (зеркало tools/ucc-footer-map.json; тест следит, чтобы совпадали) ───
  const MAP = {
    replace: {
      '{{embedded.company_address}}': "{{ContentBlock['iq_company_address_text']}}",
      '{{embedded.risk_warning}}': "{{ContentBlock['iq_risk_warning_noreg_{LANG}']}}",
      '{{embedded.company_terms_link}}': "{{ContentBlock['iq_terms_noreg_url']}}",
      '{{embedded.domain}}/traderoom/': 'https://iqbroker.co/lp/multilink/asset?aff=7&amp;afftrack=mail_system&amp;retrack=system',
    },
    moengageLocales: { en: 'en_US', ar: 'ar_KW', es: 'es_ES', pt: 'pt_PT', th: 'th_TH', id: 'id_ID', vi: 'vi_VN', fr: 'fr_FR' },
  };

  const KEY_REQUEST = 'retkit.ucc2mo.request';
  const KEY_STATUS = 'retkit.ucc2mo.status';
  const KEY_CLAIM = 'retkit.ucc2mo.claim';
  const FRESH_MS = 10 * 60 * 1000;
  const PLACEHOLDER_RE = /\{\{\s*[^{}]+?\s*\}\}/g;

  // ─── Чистая часть: письмо UCC → задание для MoEngage ──────────────────────
  function asList(value) {
    if (Array.isArray(value)) return value;
    for (const key of ['data', 'items', 'results', 'senders', 'categories']) if (Array.isArray(value?.[key])) return value[key];
    return [];
  }
  function describe(item) {
    if (!item) return '';
    const main = item.email || item.address || item.from || item.name || item.title || '';
    const extra = item.name && item.name !== main ? ` (${item.name})` : '';
    return `${main}${extra}`.trim();
  }

  function applyFooter(html, code, map = MAP) {
    const lang = String(code || '').toUpperCase();
    let out = String(html || '');
    for (const [from, to] of Object.entries(map.replace || {})) if (to) out = out.split(from).join(to.split('{LANG}').join(lang));
    return out;
  }

  function buildTransfer(tpl, { senders = [], categories = [], host = '', defaultFromEn = true, map = MAP } = {}) {
    const sender = asList(senders).find((s) => s.id === tpl.email_sender_id);
    const category = asList(categories).find((c) => c.id === tpl.email_category_id);
    const locales = [];
    const skipped = [];
    const empty = [];
    const placeholders = {};
    for (const l of tpl.locales || []) {
      const code = String(l.locale?.short_name || l.locale?.name || l.locale_id || '').toLowerCase();
      const mo = (map.moengageLocales || {})[code] || '';
      const html = applyFooter(l.html_body || '', code, map);
      if (!mo) { skipped.push(code.toUpperCase()); continue; }
      if (!html.trim()) { empty.push(code.toUpperCase()); continue; }
      for (const m of html.match(PLACEHOLDER_RE) || []) if (!/ContentBlock\[/.test(m)) placeholders[m] = (placeholders[m] || 0) + 1;
      locales.push({ ucc: code.toUpperCase(), mo, subject: String(l.subject || ''), html });
    }
    // Default в MoEngage — запасная локаль; без неё кампания не сохраняется. Берём EN.
    const en = locales.find((l) => l.ucc === 'EN');
    if (defaultFromEn && en) locales.unshift({ ...en, mo: 'Default' });
    const leftovers = Object.keys(map.replace || {}).filter((k) => locales.some((l) => l.html.includes(k)));
    return {
      id: tpl.id,
      name: String(tpl.name || `template-${tpl.id}`),
      host,
      uccUrl: host ? `https://${host}/email-templates/${tpl.id}/edit` : '',
      microservice: tpl.microservice_name || tpl.microservice?.Name || '',
      sender: describe(sender) || (tpl.email_sender_id != null ? `id ${tpl.email_sender_id}` : ''),
      senderEmail: sender?.email || sender?.address || '',
      category: describe(category) || (tpl.email_category_id != null ? `id ${tpl.email_category_id}` : ''),
      locales,
      skipped,
      empty,
      placeholders,
      footerLeftovers: leftovers,
    };
  }

  /** Как сравнивать локали: en_US → EN_US, Default → EN (так их показывает RetKit). */
  function localeKey(value) {
    const raw = String(value || '').trim();
    if (/^default$/i.test(raw)) return 'EN';
    const m = raw.match(/^([a-z]{2,3})(?:[-_]([a-z]{2,4}))?$/i);
    return m ? (m[2] ? `${m[1].toUpperCase()}_${m[2].toUpperCase()}` : m[1].toUpperCase()) : raw.toUpperCase();
  }

  function missingLocales(transfer, existing) {
    const have = new Set((existing || []).map(localeKey));
    return transfer.locales.map((l) => l.mo).filter((mo) => !have.has(localeKey(mo)));
  }

  // ─── Хранилище ────────────────────────────────────────────────────────────
  const gm = {
    get: (k, d) => { try { return GM_getValue(k, d); } catch { return d; } },
    set: (k, v) => { try { GM_setValue(k, v); } catch {} },
    on: (k, fn) => { try { GM_addValueChangeListener(k, (_n, _o, v, remote) => fn(v, remote)); } catch {} },
  };
  const now = () => Date.now();
  const tabId = Math.random().toString(36).slice(2, 10);
  function status(requestId, patch) {
    const prev = gm.get(KEY_STATUS, {}) || {};
    const next = { ...(prev.requestId === requestId ? prev : { lines: [] }), ...patch, requestId, ts: now() };
    gm.set(KEY_STATUS, next);
    return next;
  }

  function el(tag, style, text) {
    const node = document.createElement(tag);
    if (style) Object.assign(node.style, style);
    if (text != null) node.textContent = text;
    return node;
  }
  const BTN_STYLE = {
    padding: '9px 14px', borderRadius: '8px', border: 'none', color: '#fff',
    font: '600 13px/1 sans-serif', cursor: 'pointer',
  };

  // ─── UCC ──────────────────────────────────────────────────────────────────
  function uccSide() {
    const BUTTON_ID = 'retkit-ucc-to-mo';
    let currentRequest = '';

    async function getJson(url) {
      const res = await W.fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res.json();
    }
    async function collectTransfer(id) {
      const tpl = await getJson(`/api/email/templates/${id}`);
      const [senders, categories] = await Promise.all([
        getJson('/api/email/senders/').catch(() => []),
        getJson('/api/email/categories').catch(() => []),
      ]);
      return buildTransfer(tpl, { senders, categories, host: location.host });
    }
    function templateId() {
      const m = location.pathname.match(/\/email-templates\/(\d+)/);
      return m ? m[1] : null;
    }

    function render(button, s) {
      if (!s || s.requestId !== currentRequest) return;
      const map = {
        sent: '⏳ ждёт MoEngage…',
        claimed: '⏳ MoEngage принял',
        running: `⏳ ${s.done || 0}/${s.total || 0}`,
        done: s.failed ? `⚠ ${s.ok}/${s.total}, ошибок ${s.failed}` : `✓ ${s.ok}/${s.total} в MoEngage`,
        cancelled: '✕ отменено в MoEngage',
        error: '✕ ошибка в MoEngage',
      };
      button.textContent = map[s.state] || button.textContent;
      button.title = (s.lines || []).join('\n') || button.title;
      if (['done', 'cancelled', 'error'].includes(s.state)) button.disabled = false;
    }

    function sync() {
      const id = templateId();
      let button = document.getElementById(BUTTON_ID);
      if (!id) { button?.remove(); return; }
      if (button) { button.dataset.id = id; return; }
      button = el('button', { ...BTN_STYLE, position: 'fixed', right: '20px', bottom: '64px', zIndex: 99999, background: '#0f9d58', boxShadow: '0 4px 14px rgba(0,0,0,.25)' }, '→ MoEngage');
      button.id = BUTTON_ID;
      button.type = 'button';
      button.dataset.id = id;
      button.title = 'RetKit: отправить HTML и Subject всех локалей в письмо, открытое в MoEngage. В UCC ничего не меняется.';
      button.addEventListener('click', async () => {
        button.disabled = true; button.textContent = '⏳ читаю письмо…';
        try {
          const transfer = await collectTransfer(button.dataset.id);
          if (!transfer.locales.length) throw new Error('Нет локалей, которые есть в MoEngage');
          currentRequest = `${transfer.id}-${now().toString(36)}`;
          gm.set(KEY_REQUEST, { requestId: currentRequest, ts: now(), transfer });
          status(currentRequest, { state: 'sent', lines: [`Отправлено: ${transfer.name}, локалей ${transfer.locales.length}`] });
          button.textContent = '⏳ ждёт MoEngage…';
        } catch (error) {
          button.disabled = false; button.textContent = '✕ ошибка';
          alert(`RetKit UCC → MoEngage: ${error.message}`);
          setTimeout(() => { button.textContent = '→ MoEngage'; }, 2500);
        }
      });
      gm.on(KEY_STATUS, (s) => render(button, s));
      document.body.appendChild(button);
    }
    sync();
    setInterval(sync, 1000);
    return { collectTransfer };
  }

  // ─── MoEngage ─────────────────────────────────────────────────────────────
  function moSide() {
    const PANEL_ID = 'retkit-ucc2mo-panel';
    const api = () => W.__RetKitMoEngageBridgeApi || null;
    let shownRequest = '';
    let running = false;

    async function editorReady() {
      const a = api();
      if (!a) return { ok: false, reason: 'RetKit for MoEngage не найден на этой вкладке' };
      let locales = [];
      try { locales = await a.listLocales(); } catch {}
      if (!locales.length) return { ok: false, reason: 'Откройте письмо (шаг с контентом и вкладками локалей)' };
      return { ok: true, locales };
    }

    function panel() {
      let p = document.getElementById(PANEL_ID);
      if (p) return p;
      p = el('div', {
        position: 'fixed', right: '20px', bottom: '20px', zIndex: 2147483000, width: '380px', maxHeight: '70vh', overflow: 'auto',
        background: '#0d141e', color: '#e9eef7', border: '1px solid #334155', borderRadius: '10px', padding: '14px',
        font: '13px/1.45 Inter,ui-sans-serif,-apple-system,sans-serif', boxShadow: '0 10px 30px rgba(0,0,0,.4)',
      });
      p.id = PANEL_ID;
      document.body.appendChild(p);
      return p;
    }
    function closePanel() { document.getElementById(PANEL_ID)?.remove(); }

    function line(parent, text, color) { parent.appendChild(el('div', { color: color || '#cbd5e1', whiteSpace: 'pre-wrap' }, text)); }

    async function show(req) {
      if (!req?.transfer || now() - (req.ts || 0) > FRESH_MS || running) return;
      const claim = gm.get(KEY_CLAIM, null);
      if (claim?.requestId === req.requestId) return; // уже взяла другая вкладка
      shownRequest = req.requestId;
      const t = req.transfer;
      const ready = await editorReady();
      const p = panel(); p.textContent = '';
      p.appendChild(el('div', { font: '700 14px/1.3 sans-serif', marginBottom: '8px' }, `UCC → MoEngage: ${t.name}`));
      line(p, `namespace: ${t.microservice || '—'} · id ${t.id}`);
      line(p, `Отправитель в UCC: ${t.sender || '—'}`);
      try {
        const s = api()?.readSender?.();
        if (s?.found) line(p, `Отправитель здесь: ${s.fromEmail || '—'}`, t.senderEmail && s.fromEmail && !s.fromEmail.includes(t.senderEmail) ? '#fbbf24' : '#86efac');
      } catch {}
      line(p, `Зальются (${t.locales.length}): ${t.locales.map((l) => l.mo).join(', ')}`, '#86efac');
      if (t.skipped.length) line(p, `Нет в MoEngage, пропущены (${t.skipped.length}): ${t.skipped.join(', ')}`, '#fbbf24');
      if (t.empty.length) line(p, `Пустые в UCC: ${t.empty.join(', ')}`, '#fbbf24');
      if (t.footerLeftovers.length) line(p, `Футер не заменён: ${t.footerLeftovers.join(', ')}`, '#f87171');
      const ph = Object.keys(t.placeholders);
      if (ph.length) line(p, `Плейсхолдеры остаются как есть: ${ph.join(' ')}`, '#94a3b8');
      if (ready.ok) {
        const missing = missingLocales(t, ready.locales);
        if (missing.length) line(p, `Будут добавлены локали: ${missing.join(', ')}`, '#93c5fd');
        line(p, 'HTML и Subject этих локалей в открытом письме будут заменены. Первая версия каждой локали сохраняется в RetKit («Original»). Сохраняете кампанию вы.', '#94a3b8');
      } else {
        line(p, `Нельзя начать: ${ready.reason}`, '#f87171');
      }
      const row = el('div', { display: 'flex', gap: '8px', marginTop: '12px' });
      const go = el('button', { ...BTN_STYLE, background: ready.ok ? '#0f9d58' : '#475569' }, ready.ok ? 'Перенести' : 'Проверить снова');
      const cancel = el('button', { ...BTN_STYLE, background: '#334155' }, 'Отмена');
      go.addEventListener('click', () => (ready.ok ? run(req) : show(req)));
      cancel.addEventListener('click', () => { status(req.requestId, { state: 'cancelled' }); closePanel(); });
      row.append(go, cancel);
      p.appendChild(row);
    }

    async function run(req) {
      if (running) return;
      const claim = gm.get(KEY_CLAIM, null);
      if (claim?.requestId === req.requestId && claim.tab !== tabId) { closePanel(); return; }
      gm.set(KEY_CLAIM, { requestId: req.requestId, tab: tabId, ts: now() });
      running = true;
      const t = req.transfer;
      const a = api();
      const p = panel(); p.textContent = '';
      p.appendChild(el('div', { font: '700 14px/1.3 sans-serif', marginBottom: '8px' }, `Переношу ${t.name}…`));
      const log = el('div'); p.appendChild(log);
      const lines = [];
      const say = (text, color) => { lines.push(text); line(log, text, color); status(req.requestId, { lines }); };
      status(req.requestId, { state: 'claimed', total: t.locales.length, done: 0 });
      let ok = 0; let failed = 0;
      try {
        const existing = await a.listLocales();
        const missing = missingLocales(t, existing);
        const notAdded = new Set();
        if (missing.length) {
          say(`Добавляю локали: ${missing.join(', ')}…`);
          const r = await a.addLocales(missing);
          const after = await a.listLocales();
          for (const m of missingLocales(t, after)) notAdded.add(localeKey(m));
          say(notAdded.size ? `Не добавились: ${[...notAdded].join(', ')}${r?.reason ? ` (${r.reason})` : ''}` : 'Локали добавлены', notAdded.size ? '#f87171' : '#86efac');
        }
        const original = a.getActiveLocale?.() || '';
        for (let i = 0; i < t.locales.length; i += 1) {
          const l = t.locales[i];
          status(req.requestId, { state: 'running', done: i, total: t.locales.length });
          if (notAdded.has(localeKey(l.mo))) { failed += 1; say(`✕ ${l.mo}: локали нет в письме`, '#f87171'); continue; }
          try {
            if (!(await a.switchLocale(l.mo))) throw new Error('не переключилась вкладка');
            const w = await a.setLocaleHtmlStable(l.mo, l.html);
            if (!w?.ok) throw new Error(w?.reason || 'HTML не сохранился');
            if (!a.setSubject(l.subject)) throw new Error('не найдено поле Subject');
            await new Promise((r) => setTimeout(r, 300));
            const got = String(a.getSubject?.() ?? l.subject);
            if (got.trim() !== l.subject.trim()) throw new Error(`Subject не удержался («${got}»)`);
            ok += 1; say(`✓ ${l.mo} ← ${l.ucc}: HTML ${l.html.length} симв., Subject «${l.subject}»`, '#86efac');
          } catch (error) {
            failed += 1; say(`✕ ${l.mo}: ${error.message || error}`, '#f87171');
          }
        }
        if (original) { try { await a.switchLocale(original); } catch {} }
        try { a.refreshUi?.(); } catch {}
        if (t.skipped.length) say(`Пропущены (нет в MoEngage): ${t.skipped.join(', ')}`, '#fbbf24');
        say(failed ? `Готово с ошибками: ${ok}/${t.locales.length}.` : `Готово: ${ok}/${t.locales.length}. Проверьте и сохраните кампанию.`, failed ? '#fbbf24' : '#86efac');
        status(req.requestId, { state: 'done', ok, failed, done: t.locales.length, total: t.locales.length });
      } catch (error) {
        say(`Ошибка: ${error.message || error}`, '#f87171');
        status(req.requestId, { state: 'error', ok, failed });
      } finally {
        running = false;
        const close = el('button', { ...BTN_STYLE, background: '#334155', marginTop: '10px' }, 'Закрыть');
        close.addEventListener('click', closePanel);
        p.appendChild(close);
      }
    }

    gm.on(KEY_REQUEST, (req) => show(req));
    gm.on(KEY_CLAIM, (c) => { if (c?.requestId === shownRequest && c.tab !== tabId && !running) closePanel(); });
    // Задание отправили, пока этой вкладки ещё не было, — покажем его сразу.
    setTimeout(() => { const req = gm.get(KEY_REQUEST, null); if (req && gm.get(KEY_STATUS, {})?.state === 'sent') show(req); }, 2500);
    return { show, run };
  }

  const host = location.host;
  const side = /(^|\.)ucc(\.int)?\.iqoption\.com$/.test(host) ? uccSide() : (/moengage\.com$/.test(host) ? moSide() : null);
  W.__retkitUccToMoengage = { MAP, applyFooter, buildTransfer, localeKey, missingLocales, side };
})();
