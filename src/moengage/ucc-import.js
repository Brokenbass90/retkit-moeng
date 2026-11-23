(function (root) {
  'use strict';

  // Перенос письма из UCC в открытое письмо MoEngage.
  //
  // Связь с вкладкой UCC даёт скрипт «RetKit UCC Export» (он стоит и на UCC, и
  // здесь): window.__RetKitUccLink — присутствие вкладки UCC, запрос письма,
  // «→ MoEngage» из UCC. Задание приходит готовым: футер заменён на content
  // blocks, локали UCC сопоставлены с MoEngage, Default = EN.
  //
  // Здесь: кнопка «⇄ UCC» в панели RetKit (зелёная, когда UCC с письмом на
  // связи) → окно с планом → «Перенести»: недостающие локали добавляются, в
  // каждую пишутся HTML и Subject с проверкой, что MoEngage их удержал;
  // по галочке — отправитель. Первую версию каждой локали RetKit сохраняет сам
  // (↶ Original). Кампанию сохраняет человек.

  const PANEL_ID = 'retkit-mo-ucc-panel';
  const link = () => root.__RetKitUccLink || null;
  const api = () => root.__RetKitMoEngageBridgeApi || null;
  const core = () => root.__RetKitMoEngageCore || null;
  const wait = (ms) => new Promise((r) => (typeof setTimeout === 'function' ? setTimeout(r, ms) : root.setTimeout?.(r, ms)));

  function localeKey(value) {
    const raw = String(value || '').trim();
    if (/^default$/i.test(raw)) return 'EN';
    const m = raw.match(/^([a-z]{2,3})(?:[-_]([a-z]{2,4}))?$/i);
    return m ? (m[2] ? `${m[1].toUpperCase()}_${m[2].toUpperCase()}` : m[1].toUpperCase()) : raw.toUpperCase();
  }

  function status() {
    const l = link();
    if (!l) return { linkInstalled: false, online: false, ready: false, tabs: [], line: 'UCC: мост не установлен (скрипт RetKit UCC Export 0.3+)' };
    const tabs = typeof l.tabs === 'function' ? l.tabs() : (l.presence().id ? [l.presence()] : []);
    const label = (t) => `${t.name || `письмо ${t.id}`}${t.microservice ? ` (${t.microservice})` : ''}${/\.int\./.test(t.host || '') ? ' · INT' : ''}`;
    const line = !tabs.length ? 'UCC: открытых писем нет' : (tabs.length === 1 ? `UCC: ${label(tabs[0])}, локалей ${tabs[0].locales || '?'}` : `UCC: открыто писем ${tabs.length} — выберите в ⇄ UCC`);
    return { linkInstalled: true, online: tabs.length > 0, ready: tabs.length > 0, tabs: tabs.map((t) => ({ ...t, label: label(t) })), id: tabs[0]?.id || null, name: tabs[0]?.name || '', host: tabs[0]?.host || '', line };
  }

  async function plan(transfer) {
    const a = api();
    if (!a) throw new Error('RetKit for MoEngage ещё не готов на этой вкладке');
    let existing = [];
    try { existing = await a.listLocales(); } catch {}
    if (!existing.length) throw new Error('Откройте письмо в MoEngage (шаг с контентом и вкладками локалей)');
    const have = new Set(existing.map(localeKey));
    const missing = transfer.locales.map((l) => l.mo).filter((mo) => !have.has(localeKey(mo)));
    let sender = null;
    try { sender = a.readSender?.() || null; } catch {}
    const senderHere = sender?.found ? String(sender.fromEmail || '') : '';
    const senderDiffers = Boolean(transfer.senderEmail && senderHere && !senderHere.toLowerCase().includes(transfer.senderEmail.toLowerCase()));
    return {
      name: transfer.name, id: transfer.id, microservice: transfer.microservice,
      write: transfer.locales.map((l) => l.mo), missing, skipped: transfer.skipped, empty: transfer.empty,
      placeholders: Object.keys(transfer.placeholders || {}), footerLeftovers: transfer.footerLeftovers || [],
      senderUcc: transfer.senderEmail || transfer.sender || '', senderHere, senderDiffers,
    };
  }

  let running = false;
  async function apply(transfer, { applySender = false, onLine = () => {} } = {}) {
    if (running) throw new Error('Перенос уже идёт');
    const a = api();
    if (!a) throw new Error('RetKit for MoEngage ещё не готов на этой вкладке');
    running = true;
    const lines = [];
    const say = (text, kind = 'info') => { lines.push(text); try { onLine(text, kind); } catch {} };
    const results = [];
    const c = core();
    try {
      const flushed = await Promise.resolve(c?.flushBeforeLocaleSwitch?.() || { ok: true });
      if (flushed && flushed.ok === false) throw new Error(`Не удалось досохранить текущую локаль: ${flushed.reason || ''}`);
      const p = await plan(transfer);
      const notAdded = new Set();
      if (p.missing.length) {
        say(`Добавляю локали: ${p.missing.join(', ')}…`);
        const r = await a.addLocales(p.missing);
        await wait(400);
        const have = new Set((await a.listLocales()).map(localeKey));
        for (const m of p.missing) if (!have.has(localeKey(m))) notAdded.add(localeKey(m));
        say(notAdded.size ? `Не добавились: ${[...notAdded].join(', ')}${r?.reason ? ` (${r.reason})` : ''}` : 'Локали добавлены', notAdded.size ? 'error' : 'ok');
      }
      const origin = a.getActiveLocale?.() || '';
      c?.setMultiLocaleBusy?.(true, `UCC 0/${transfer.locales.length}…`);
      try {
        for (let i = 0; i < transfer.locales.length; i += 1) {
          const l = transfer.locales[i];
          c?.setMultiLocaleBusy?.(true, `UCC ${i + 1}/${transfer.locales.length}…`);
          if (notAdded.has(localeKey(l.mo))) { results.push({ locale: l.mo, ok: false, reason: 'локали нет в письме' }); say(`✕ ${l.mo}: локали нет в письме`, 'error'); continue; }
          try {
            if (!(await a.switchLocale(l.mo))) throw new Error('не переключилась вкладка локали');
            const w = await a.setLocaleHtmlStable(l.mo, l.html);
            if (!w?.ok) throw new Error(w?.reason || 'HTML не сохранился');
            if (!a.setSubject(l.subject)) throw new Error('не найдено поле Subject');
            await wait(300);
            const got = String(a.getSubject?.() ?? l.subject);
            if (got.trim() !== String(l.subject).trim()) throw new Error(`Subject не удержался («${got}»)`);
            results.push({ locale: l.mo, ok: true });
            say(`✓ ${l.mo} ← ${l.ucc}: HTML ${l.html.length} симв., Subject «${l.subject}»`, 'ok');
          } catch (error) {
            results.push({ locale: l.mo, ok: false, reason: error?.message || String(error) });
            say(`✕ ${l.mo}: ${error?.message || error}`, 'error');
          }
        }
      } finally {
        c?.setMultiLocaleBusy?.(false);
      }
      let sender = null;
      if (applySender && p.senderDiffers && transfer.senderEmail) {
        say(`Отправитель → ${transfer.senderEmail}…`);
        try {
          const current = a.readSender?.() || {};
          const okLocales = results.filter((r) => r.ok).map((r) => r.locale);
          const r = await a.applySender({ ...current, fromEmail: transfer.senderEmail }, okLocales);
          const bad = (r || []).filter((x) => !x.ok);
          sender = { ok: !bad.length, failed: bad.map((x) => `${x.locale}: ${x.reason}`) };
          say(bad.length ? `Отправитель не встал: ${sender.failed.join('; ')}` : 'Отправитель применён', bad.length ? 'error' : 'ok');
        } catch (error) {
          sender = { ok: false, failed: [error?.message || String(error)] };
          say(`Отправитель: ${error?.message || error}`, 'error');
        }
      }
      if (origin) { try { await a.switchLocale(origin); } catch {} }
      try { a.refreshUi?.(); } catch {}
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      if (transfer.skipped?.length) say(`Пропущены (нет в MoEngage): ${transfer.skipped.join(', ')}`, 'warn');
      say(failed ? `Готово с ошибками: ${ok}/${results.length}.` : `Готово: ${ok}/${results.length}. Проверьте и сохраните кампанию.`, failed ? 'warn' : 'ok');
      return { ok: !failed, written: ok, failed, results, sender, skipped: transfer.skipped || [], lines, note: 'Кампанию в MoEngage сохраняет человек.' };
    } finally {
      running = false;
    }
  }

  // ─── Окно переноса ────────────────────────────────────────────────────────
  function el(tag, style, text) {
    const node = root.document.createElement(tag);
    if (style) Object.assign(node.style, style);
    if (text != null) node.textContent = text;
    return node;
  }
  const COLORS = { ok: '#86efac', warn: '#fbbf24', error: '#f87171', info: '#cbd5e1', muted: '#94a3b8', blue: '#93c5fd' };
  const BTN = { padding: '8px 14px', borderRadius: '7px', border: 'none', color: '#fff', font: '600 12px/1 sans-serif', cursor: 'pointer' };
  function closePanel() { root.document.getElementById(PANEL_ID)?.remove(); }
  function panel() {
    closePanel();
    const p = el('div', {
      position: 'fixed', right: '20px', top: '64px', zIndex: 2147483600, width: '400px', maxHeight: '75vh', overflow: 'auto',
      background: '#0d141e', color: '#e9eef7', border: '1px solid #334155', borderRadius: '10px', padding: '14px',
      font: '12px/1.5 Inter,ui-sans-serif,-apple-system,sans-serif', boxShadow: '0 10px 30px rgba(0,0,0,.45)',
    });
    p.id = PANEL_ID;
    root.document.body.appendChild(p);
    return p;
  }
  const line = (parent, text, kind = 'info') => parent.appendChild(el('div', { color: COLORS[kind] || kind, whiteSpace: 'pre-wrap' }, text));

  async function open(pushed = null) {
    const p = panel();
    p.appendChild(el('div', { font: '700 13px/1.3 sans-serif', marginBottom: '8px' }, 'Перенос из UCC'));
    const body = el('div'); p.appendChild(body);
    const row = el('div', { display: 'flex', gap: '8px', marginTop: '12px', alignItems: 'center' });
    const cancel = el('button', { ...BTN, background: '#334155' }, 'Закрыть');
    cancel.addEventListener('click', closePanel);
    let transfer = pushed?.transfer || null;
    try {
      if (!transfer) {
        const s = status();
        if (!s.ready) throw new Error(`${s.line}. Откройте письмо в UCC в соседней вкладке.`);
        let pick = s.tabs[0];
        if (s.tabs.length > 1) {
          pick = await new Promise((resolve) => {
            line(body, 'В UCC открыто несколько писем — какое переносим?', 'info');
            for (const t of s.tabs) {
              const b = el('button', { ...BTN, background: '#1e293b', display: 'block', width: '100%', textAlign: 'left', marginTop: '6px', font: '500 12px/1.3 sans-serif' }, t.label);
              b.addEventListener('click', () => resolve(t));
              body.appendChild(b);
            }
          });
          body.textContent = '';
        }
        line(body, `Забираю из UCC: ${pick.label}…`, 'muted');
        transfer = await link().pull({ id: pick.id, host: pick.host });
        body.textContent = '';
      }
      const pl = await plan(transfer);
      line(body, `${pl.name} · ${pl.microservice || '—'} · UCC id ${pl.id}`, 'info');
      line(body, `Зальются HTML + Subject (${pl.write.length}): ${pl.write.join(', ')}`, 'ok');
      if (pl.missing.length) line(body, `Будут добавлены локали: ${pl.missing.join(', ')}`, 'blue');
      if (pl.skipped.length) line(body, `Нет в MoEngage, пропущены (${pl.skipped.length}): ${pl.skipped.join(', ')}`, 'warn');
      if (pl.empty.length) line(body, `Пустые в UCC: ${pl.empty.join(', ')}`, 'warn');
      if (pl.footerLeftovers.length) line(body, `Футер не заменён: ${pl.footerLeftovers.join(', ')}`, 'error');
      if (pl.placeholders.length) line(body, `Плейсхолдеры остаются как есть: ${pl.placeholders.join(' ')}`, 'muted');
      let senderBox = null;
      if (pl.senderDiffers) {
        const label = el('label', { display: 'flex', gap: '6px', alignItems: 'center', color: COLORS.warn, marginTop: '4px' });
        senderBox = el('input'); senderBox.type = 'checkbox'; senderBox.checked = true;
        label.append(senderBox, el('span', null, `Отправитель: здесь ${pl.senderHere}, в UCC ${pl.senderUcc} — поставить как в UCC`));
        body.appendChild(label);
      } else if (pl.senderUcc) {
        line(body, `Отправитель: ${pl.senderHere || '—'} (в UCC ${pl.senderUcc})`, pl.senderHere ? 'ok' : 'muted');
      }
      line(body, 'HTML и Subject этих локалей будут заменены. Первая версия каждой локали — в ↶ Original. Кампанию сохраняете вы.', 'muted');
      const go = el('button', { ...BTN, background: '#0f9d58' }, 'Перенести');
      go.addEventListener('click', async () => {
        go.disabled = true; cancel.disabled = true; go.textContent = 'Переношу…';
        const log = el('div', { marginTop: '10px', borderTop: '1px solid #263140', paddingTop: '8px' }); p.insertBefore(log, row);
        try {
          await apply(transfer, { applySender: Boolean(senderBox?.checked), onLine: (t, k) => line(log, t, k) });
        } catch (error) {
          line(log, `Ошибка: ${error?.message || error}`, 'error');
        } finally {
          go.remove(); cancel.disabled = false;
        }
      });
      row.append(go, cancel);
    } catch (error) {
      line(body, error?.message || String(error), 'error');
      const retry = el('button', { ...BTN, background: '#475569' }, 'Ещё раз');
      retry.addEventListener('click', () => open(pushed));
      row.append(retry, cancel);
    }
    p.appendChild(row);
  }

  // ─── Кнопка «⇄ UCC» в панели RetKit ──────────────────────────────────────
  let boundButton = null;
  function paint() {
    const b = boundButton;
    if (!b || !b.isConnected) return;
    const s = status();
    const color = !s.linkInstalled ? '#64748b' : (s.tabs.length === 1 ? '#22c55e' : (s.tabs.length > 1 ? '#f59e0b' : '#64748b'));
    b.textContent = '';
    b.append(el('span', { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: color, marginRight: '6px' }), root.document.createTextNode(s.tabs.length > 1 ? `⇄ UCC (${s.tabs.length})` : '⇄ UCC'));
    b.title = `${s.line}\nНажмите, чтобы перенести открытое в UCC письмо сюда (HTML + Subject всех локалей).`;
  }
  function bindButton(button) { boundButton = button; paint(); }

  let started = false;
  function start() {
    if (started) return;
    const l = link();
    if (!l) return;
    started = true;
    l.onPresence(() => paint());
    l.onPush((req) => { open(req); });
  }
  const tickUi = () => { start(); paint(); };
  if (typeof setInterval === 'function') setInterval(tickUi, 2000); else root.setInterval?.(tickUi, 2000);
  try { root.addEventListener?.('retkit:ucc-link-ready', start); } catch {}

  root.__RetKitUccImport = { status, plan, apply, open, bindButton, localeKey,
    /** Для агента: без apply — план; с apply — перенос. */
    async agent({ apply: doApply = false, applySender = false, id } = {}) {
      const s = status();
      if (!s.linkInstalled) throw new Error(s.line);
      if (!s.ready) throw new Error(`${s.line}. Попросите открыть письмо в UCC.`);
      if (!id && s.tabs.length > 1) return { choose: s.tabs.map((t) => ({ id: t.id, host: t.host, label: t.label })), note: 'Открыто несколько писем UCC — повторите с id.' };
      const t = s.tabs.find((x) => String(x.id) === String(id || s.id)) || s.tabs[0];
      const transfer = await link().pull({ id: t.id, host: t.host });
      if (!doApply) return { plan: await plan(transfer), note: 'Это план. Перенос — тот же вызов с apply: true (после согласия человека).' };
      return apply(transfer, { applySender });
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
