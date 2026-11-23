(function (root) {
  'use strict';

  // Перенос письма из UCC в открытое письмо MoEngage.
  //
  // Связь с UCC даёт скрипт «RetKit UCC Export» (стоит и на UCC, и здесь):
  // window.__RetKitUccLink — какие письма открыты во вкладках UCC, запрос письма.
  // Задание приходит готовым: футер заменён на content blocks, локали UCC
  // сопоставлены с MoEngage, Default = EN.
  //
  // UI: чип «UCC · <письмо>» в панели RetKit → выпадающий блок: выбор письма
  // (если открыто несколько), чипы локалей, отправитель, одна кнопка
  // «Перенести». Ход — по чипам. Ошибка — в блоке, итог последней попытки
  // видит и агент (status → uccLast). Кампанию сохраняет человек.

  const POP_ID = 'retkit-mo-ucc-pop';
  const STYLE_ID = 'retkit-mo-ucc-style';
  const link = () => root.__RetKitUccLink || null;
  const api = () => root.__RetKitMoEngageBridgeApi || null;
  const core = () => root.__RetKitMoEngageCore || null;
  const wait = (ms) => new Promise((r) => (typeof setTimeout === 'function' ? setTimeout(r, ms) : root.setTimeout?.(r, ms)));
  const log = (...a) => { try { root.console?.info?.('[RetKit UCC]', ...a); } catch {} };
  const diag = (type, meta) => { try { root.__RetKitDiagnostics?.breadcrumb?.(type, meta); } catch {} };

  function localeKey(value) {
    const raw = String(value || '').trim();
    if (/^default$/i.test(raw)) return 'EN';
    const m = raw.match(/^([a-z]{2,3})(?:[-_]([a-z]{2,4}))?$/i);
    return m ? (m[2] ? `${m[1].toUpperCase()}_${m[2].toUpperCase()}` : m[1].toUpperCase()) : raw.toUpperCase();
  }
  const envOf = (host) => (/\.int\./.test(host || '') ? 'INT' : 'PROD');

  function status() {
    const l = link();
    if (!l) return { linkInstalled: false, online: false, ready: false, tabs: [], line: 'UCC: мост не установлен (RetKit UCC Export 0.3+)' };
    const tabs = (typeof l.tabs === 'function' ? l.tabs() : []).map((t) => ({ ...t, env: envOf(t.host), label: `${t.name || `письмо ${t.id}`}${t.microservice ? ` · ${t.microservice}` : ''} · ${envOf(t.host)}` }));
    const line = !tabs.length ? 'UCC: открытых писем нет' : (tabs.length === 1 ? `UCC: ${tabs[0].label}, локалей ${tabs[0].locales || '?'}` : `UCC: открыто писем ${tabs.length}`);
    return { linkInstalled: true, online: tabs.length > 0, ready: tabs.length > 0, tabs, id: tabs[0]?.id || null, name: tabs[0]?.name || '', host: tabs[0]?.host || '', line };
  }

  async function plan(transfer) {
    const a = api();
    if (!a) throw new Error('RetKit for MoEngage ещё не готов на этой вкладке');
    let existing = [];
    try { existing = await a.listLocales(); } catch (error) { throw new Error(`Не прочитал локали письма MoEngage: ${error?.message || error}`); }
    if (!existing.length) throw new Error('Не вижу вкладок локалей — откройте письмо MoEngage на шаге контента');
    const have = new Set(existing.map(localeKey));
    const missing = transfer.locales.map((l) => l.mo).filter((mo) => !have.has(localeKey(mo)));
    let sender = null;
    try { sender = a.readSender?.() || null; } catch {}
    const senderHere = sender?.found ? String(sender.fromEmail || '') : '';
    const senderDiffers = Boolean(transfer.senderEmail && senderHere && !senderHere.toLowerCase().includes(transfer.senderEmail.toLowerCase()));
    return {
      name: transfer.name, id: transfer.id, microservice: transfer.microservice, env: envOf(transfer.host),
      existing: existing.map(localeKey), write: transfer.locales.map((l) => l.mo), missing, skipped: transfer.skipped || [], empty: transfer.empty || [],
      placeholders: Object.keys(transfer.placeholders || {}), footerLeftovers: transfer.footerLeftovers || [],
      senderUcc: transfer.senderEmail || transfer.sender || '', senderHere, senderDiffers,
    };
  }

  let running = false;
  let last = null;
  async function apply(transfer, { applySender = false, onLine = () => {}, onLocale = () => {} } = {}) {
    if (running) throw new Error('Перенос уже идёт');
    const a = api();
    if (!a) throw new Error('RetKit for MoEngage ещё не готов на этой вкладке');
    running = true;
    const lines = [];
    const say = (text, kind = 'info') => { lines.push(text); log(text); try { onLine(text, kind); } catch {} };
    const results = [];
    const c = core();
    last = { ts: Date.now(), name: transfer.name, state: 'running', lines };
    diag('ucc.import.start', { name: transfer.name, locales: transfer.locales.length });
    try {
      const flushed = await Promise.resolve(c?.flushBeforeLocaleSwitch?.() || { ok: true });
      if (flushed && flushed.ok === false) throw new Error(`Не удалось досохранить текущую локаль: ${flushed.reason || ''}`);
      const p = await plan(transfer);
      const notAdded = new Set();
      if (p.missing.length) {
        say(`Добавляю локали: ${p.missing.join(', ')}`);
        let r = null;
        try { r = await a.addLocales(p.missing); } catch (error) { r = { ok: false, reason: error?.message || String(error) }; }
        await wait(500);
        const have = new Set((await a.listLocales()).map(localeKey));
        for (const m of p.missing) if (!have.has(localeKey(m))) notAdded.add(localeKey(m));
        say(notAdded.size ? `Не добавились: ${[...notAdded].join(', ')}${r?.reason ? ` — ${r.reason}` : ''}` : 'Локали добавлены', notAdded.size ? 'error' : 'ok');
      }
      const origin = a.getActiveLocale?.() || '';
      c?.setMultiLocaleBusy?.(true, `UCC 0/${transfer.locales.length}…`);
      try {
        for (let i = 0; i < transfer.locales.length; i += 1) {
          const l = transfer.locales[i];
          c?.setMultiLocaleBusy?.(true, `UCC ${i + 1}/${transfer.locales.length}…`);
          onLocale(l.mo, 'run');
          if (notAdded.has(localeKey(l.mo))) {
            results.push({ locale: l.mo, ok: false, reason: 'локали нет в письме' });
            onLocale(l.mo, 'fail', 'локали нет в письме'); continue;
          }
          try {
            if (!(await a.switchLocale(l.mo))) throw new Error('не открылась вкладка локали');
            const w = await a.setLocaleHtmlStable(l.mo, l.html);
            if (!w?.ok) throw new Error(w?.reason || 'MoEngage не удержал HTML');
            if (!a.setSubject(l.subject)) throw new Error('не найдено поле Subject');
            await wait(300);
            const got = String(a.getSubject?.() ?? l.subject);
            if (got.trim() !== String(l.subject).trim()) throw new Error(`Subject не удержался («${got}»)`);
            results.push({ locale: l.mo, ok: true });
            onLocale(l.mo, 'ok', `HTML ${l.html.length} симв. · «${l.subject}»`);
          } catch (error) {
            const reason = error?.message || String(error);
            results.push({ locale: l.mo, ok: false, reason });
            say(`${l.mo}: ${reason}`, 'error');
            onLocale(l.mo, 'fail', reason);
          }
        }
      } finally {
        c?.setMultiLocaleBusy?.(false);
      }
      let sender = null;
      if (applySender && p.senderDiffers && transfer.senderEmail) {
        try {
          const current = a.readSender?.() || {};
          const okLocales = results.filter((r) => r.ok).map((r) => r.locale);
          const r = await a.applySender({ ...current, fromEmail: transfer.senderEmail }, okLocales);
          const bad = (r || []).filter((x) => !x.ok);
          sender = { ok: !bad.length, failed: bad.map((x) => `${x.locale}: ${x.reason}`) };
          say(bad.length ? `Отправитель не встал: ${sender.failed.join('; ')}` : `Отправитель: ${transfer.senderEmail}`, bad.length ? 'error' : 'ok');
        } catch (error) {
          sender = { ok: false, failed: [error?.message || String(error)] };
          say(`Отправитель: ${error?.message || error}`, 'error');
        }
      }
      if (origin) { try { await a.switchLocale(origin); } catch {} }
      try { a.refreshUi?.(); } catch {}
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      say(failed ? `Перенесено ${ok} из ${results.length}` : `Перенесено ${ok} из ${results.length}. Проверьте и сохраните кампанию.`, failed ? 'warn' : 'ok');
      last = { ts: Date.now(), name: transfer.name, state: failed ? 'partial' : 'done', ok, failed, lines };
      diag('ucc.import.done', { name: transfer.name, ok, failed });
      return { ok: !failed, written: ok, failed, results, sender, skipped: transfer.skipped || [], lines, note: 'Кампанию в MoEngage сохраняет человек.' };
    } catch (error) {
      const reason = error?.message || String(error);
      say(reason, 'error');
      last = { ts: Date.now(), name: transfer.name, state: 'error', error: reason, lines };
      diag('ucc.import.error', { name: transfer.name, reason });
      throw error;
    } finally {
      running = false;
    }
  }

  // ─── UI ───────────────────────────────────────────────────────────────────
  function injectStyle() {
    if (root.document.getElementById(STYLE_ID)) return;
    const s = root.document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      #${POP_ID}{position:fixed;z-index:2147483646;width:380px;max-height:70vh;overflow:auto;background:#0f1722;color:#e6edf7;
        border:1px solid #2a3647;border-radius:12px;box-shadow:0 18px 40px rgba(0,0,0,.5);font:12px/1.45 Inter,ui-sans-serif,-apple-system,sans-serif}
      #${POP_ID} .u-h{display:flex;align-items:center;justify-content:space-between;padding:12px 14px 8px;font-weight:600;font-size:13px}
      #${POP_ID} .u-x{background:none;border:0;color:#8a98ad;font-size:16px;cursor:pointer;line-height:1}
      #${POP_ID} .u-sec{padding:4px 14px 10px}
      #${POP_ID} .u-cap{color:#7d8ba1;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:6px 0}
      #${POP_ID} .u-mail{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:#152030;border:1px solid #243246;
        color:#e6edf7;border-radius:9px;padding:8px 10px;margin-bottom:6px;cursor:pointer;font:inherit}
      #${POP_ID} .u-mail.on{border-color:#3b82f6;background:#172a45}
      #${POP_ID} .u-mail b{font-weight:600}
      #${POP_ID} .u-tag{font-size:10px;padding:1px 6px;border-radius:999px;background:#243246;color:#a9b6c8}
      #${POP_ID} .u-tag.int{background:#3b2f12;color:#f5c26b}
      #${POP_ID} .u-chips{display:flex;flex-wrap:wrap;gap:5px}
      #${POP_ID} .u-chip{font:600 11px/1 ui-monospace,Menlo,monospace;padding:5px 7px;border-radius:6px;background:#1d2a3c;color:#c6d2e2;border:1px solid #2a3a50}
      #${POP_ID} .u-chip.add{border-style:dashed;color:#93c5fd}
      #${POP_ID} .u-chip.skip{opacity:.45;text-decoration:line-through}
      #${POP_ID} .u-chip.run{background:#1e3a8a;color:#fff}
      #${POP_ID} .u-chip.ok{background:#14532d;border-color:#166534;color:#bbf7d0}
      #${POP_ID} .u-chip.fail{background:#5b1a1a;border-color:#7f1d1d;color:#fecaca}
      #${POP_ID} .u-note{color:#8a98ad;margin-top:6px}
      #${POP_ID} .u-warn{color:#fbbf24;margin-top:6px}
      #${POP_ID} .u-err{background:#3a1416;border:1px solid #7f1d1d;color:#fecaca;border-radius:8px;padding:8px 10px;margin:6px 0;white-space:pre-wrap}
      #${POP_ID} .u-ok{color:#86efac;margin-top:8px}
      #${POP_ID} .u-foot{display:flex;gap:8px;align-items:center;padding:10px 14px 14px;border-top:1px solid #1f2b3b}
      #${POP_ID} .u-go{flex:1;background:#2563eb;border:0;color:#fff;border-radius:8px;padding:9px 12px;font:600 12px/1 inherit;cursor:pointer}
      #${POP_ID} .u-go:disabled{background:#334155;cursor:default}
      #${POP_ID} label.u-sw{display:flex;gap:8px;align-items:center;margin-top:8px;color:#c6d2e2;cursor:pointer}
      #${POP_ID} .u-spin{color:#8a98ad}
      .rk-ucc-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:1px}
    `;
    root.document.head.appendChild(s);
  }
  function h(tag, cls, text) {
    const n = root.document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function closePop() { root.document.getElementById(POP_ID)?.remove(); }

  let boundButton = null;
  let selected = null; // { id, host }
  let cached = null;   // { key, transfer }

  async function open() {
    const existing = root.document.getElementById(POP_ID);
    if (existing) { if (!running) closePop(); return; }
    injectStyle();
    const pop = h('div'); pop.id = POP_ID;
    pop.style.right = '16px';
    const r = boundButton?.getBoundingClientRect?.();
    pop.style.top = `${Math.round((r?.bottom || 60) + 8)}px`;
    root.document.body.appendChild(pop);
    await render(pop);
  }

  async function render(pop) {
    pop.textContent = '';
    const head = h('div', 'u-h'); head.append(h('span', null, 'Перенос из UCC'));
    const x = h('button', 'u-x', '×'); x.addEventListener('click', () => { if (!running) closePop(); }); head.append(x);
    pop.append(head);
    const s = status();
    const sec = h('div', 'u-sec'); pop.append(sec);
    if (!s.linkInstalled || !s.tabs.length) {
      sec.append(h('div', 'u-err', s.linkInstalled ? 'В UCC не открыто ни одного письма. Откройте письмо в UCC — оно появится здесь.' : s.line));
      return;
    }
    if (!selected || !s.tabs.some((t) => String(t.id) === String(selected.id) && t.host === selected.host)) selected = { id: s.tabs[0].id, host: s.tabs[0].host };
    sec.append(h('div', 'u-cap', s.tabs.length > 1 ? `Письмо (открыто ${s.tabs.length})` : 'Письмо'));
    for (const t of s.tabs) {
      const b = h('button', `u-mail${String(t.id) === String(selected.id) && t.host === selected.host ? ' on' : ''}`);
      const name = h('b', null, t.name || `#${t.id}`);
      const env = h('span', `u-tag${t.env === 'INT' ? ' int' : ''}`, t.env);
      const ns = h('span', 'u-tag', t.microservice || '—');
      const loc = h('span', 'u-tag', `${t.locales || '?'} лок.`);
      b.append(name, env, ns, loc);
      b.addEventListener('click', () => { if (running) return; selected = { id: t.id, host: t.host }; cached = null; render(pop); });
      sec.append(b);
    }
    const body = h('div', 'u-sec'); pop.append(body);
    const foot = h('div', 'u-foot'); pop.append(foot);
    const go = h('button', 'u-go', 'Читаю письмо…'); go.disabled = true; foot.append(go);
    let transfer; let pl;
    try {
      const key = `${selected.host}#${selected.id}`;
      if (cached?.key !== key) {
        body.append(h('div', 'u-spin', 'Забираю из UCC…'));
        cached = { key, transfer: await link().pull({ id: selected.id, host: selected.host }) };
        body.textContent = '';
      }
      transfer = cached.transfer;
      pl = await plan(transfer);
    } catch (error) {
      body.textContent = '';
      body.append(h('div', 'u-err', error?.message || String(error)));
      go.disabled = false; go.textContent = 'Повторить';
      go.addEventListener('click', () => { cached = null; render(pop); });
      log('plan error', error);
      return;
    }
    body.append(h('div', 'u-cap', 'Локали MoEngage'));
    const chips = h('div', 'u-chips'); body.append(chips);
    const chipBy = new Map();
    for (const mo of pl.write) {
      const add = pl.missing.includes(mo);
      const c = h('span', `u-chip${add ? ' add' : ''}`, `${add ? '+' : ''}${mo}`);
      c.title = add ? 'Локали нет в письме — будет добавлена' : 'HTML и Subject будут заменены';
      chipBy.set(mo, c); chips.append(c);
    }
    for (const sk of pl.skipped) { const c = h('span', 'u-chip skip', sk); c.title = 'Такой локали нет в MoEngage — не переносится'; chips.append(c); }
    if (pl.skipped.length) body.append(h('div', 'u-note', `Зачёркнутые — нет в MoEngage, попросить завести.`));
    if (pl.empty.length) body.append(h('div', 'u-warn', `Пустые в UCC: ${pl.empty.join(', ')}`));
    if (pl.footerLeftovers.length) body.append(h('div', 'u-err', `Футер не заменён: ${pl.footerLeftovers.join(', ')}`));
    if (pl.placeholders.length) body.append(h('div', 'u-note', `Остаются как есть: ${pl.placeholders.join(' ')}`));
    let senderBox = null;
    if (pl.senderDiffers) {
      const lab = h('label', 'u-sw'); senderBox = h('input'); senderBox.type = 'checkbox'; senderBox.checked = true;
      lab.append(senderBox, h('span', null, `Отправитель ${pl.senderUcc} (сейчас ${pl.senderHere})`));
      body.append(lab);
    }
    const out = h('div'); body.append(out);
    go.disabled = false;
    go.textContent = `Перенести ${pl.write.length} лок.`;
    go.addEventListener('click', async () => {
      go.disabled = true; go.textContent = 'Переношу…';
      out.textContent = '';
      try {
        const res = await apply(transfer, {
          applySender: Boolean(senderBox?.checked),
          onLocale: (mo, state, title) => { const c = chipBy.get(mo); if (c) { c.className = `u-chip ${state}`; if (title) c.title = title; } },
          onLine: (text, kind) => { if (kind === 'error') out.append(h('div', 'u-err', text)); },
        });
        out.append(h('div', res.failed ? 'u-warn' : 'u-ok', res.failed ? `Перенесено ${res.written} из ${res.results.length} — наведите на красные локали` : `Готово: ${res.written} лок. Проверьте и сохраните кампанию.`));
        go.textContent = 'Закрыть'; go.disabled = false;
        go.onclick = closePop;
      } catch (error) {
        out.append(h('div', 'u-err', error?.message || String(error)));
        go.textContent = 'Повторить'; go.disabled = false;
        go.onclick = () => { cached = null; render(pop); };
      }
    }, { once: true });
  }

  // Кнопка в панели RetKit + полоса под панелью: видно, с каким письмом UCC связь и куда нажать.
  const BANNER_ID = 'retkit-mo-ucc-banner';
  function paint() {
    const b = boundButton;
    if (!b || !b.isConnected) return;
    const s = status();
    const ready = s.linkInstalled && s.tabs.length > 0;
    const pick = s.tabs.find((t) => selected && String(t.id) === String(selected.id) && t.host === selected.host) || s.tabs[0];
    b.textContent = '';
    const dot = h('span', 'rk-ucc-dot'); dot.style.background = ready ? '#22c55e' : '#64748b';
    b.append(dot, root.document.createTextNode(ready ? 'Перенести из UCC' : 'UCC'));
    b.style.background = ready ? '#15803d' : '';
    b.style.borderColor = ready ? '#16a34a' : '';
    b.style.color = ready ? '#fff' : '';
    b.title = ready ? `${s.tabs.map((t) => t.label).join('\n')}\nНажмите — перенос в это письмо MoEngage` : s.line;
    // Полоса под панелью
    const bar = b.closest?.('.rk-topbar');
    let banner = root.document.getElementById(BANNER_ID);
    if (!bar) return;
    if (!banner) {
      banner = h('div'); banner.id = BANNER_ID;
      Object.assign(banner.style, { display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 14px', font: '12px/1.3 Inter,ui-sans-serif,sans-serif', borderBottom: '1px solid #1f2b3b' });
      bar.insertAdjacentElement('afterend', banner);
    }
    banner.textContent = '';
    banner.style.background = ready ? '#0f2a1a' : '#111827';
    banner.style.color = ready ? '#bbf7d0' : '#94a3b8';
    const d2 = h('span', 'rk-ucc-dot'); d2.style.background = ready ? '#22c55e' : '#64748b';
    banner.append(d2);
    if (!s.linkInstalled) { banner.append(root.document.createTextNode('Мост UCC не установлен — поставьте RetKit UCC Export.')); return; }
    if (!ready) { banner.append(root.document.createTextNode('UCC: откройте письмо в UCC в соседней вкладке — оно появится здесь.')); return; }
    banner.append(root.document.createTextNode(s.tabs.length > 1 ? `UCC на связи: открыто писем ${s.tabs.length}` : `UCC на связи: ${pick.label} · ${pick.locales || '?'} лок.`));
    const go = h('button', null, s.tabs.length > 1 ? 'Выбрать и перенести →' : 'Перенести в это письмо →');
    Object.assign(go.style, { marginLeft: 'auto', background: '#16a34a', color: '#fff', border: '0', borderRadius: '6px', padding: '5px 10px', font: '600 12px/1 inherit', cursor: 'pointer' });
    go.addEventListener('click', () => open());
    banner.append(go);
  }
  function bindButton(button) { boundButton = button; injectStyle(); paint(); }

  let started = false;
  function start() {
    const l = link();
    if (started || !l) return;
    started = true;
    l.onPresence?.(() => paint());
  }
  const tickUi = () => { start(); paint(); };
  if (typeof setInterval === 'function') setInterval(tickUi, 2000); else root.setInterval?.(tickUi, 2000);
  try { root.addEventListener?.('retkit:ucc-link-ready', start); } catch {}

  root.__RetKitUccImport = {
    status, plan, apply, open, bindButton, localeKey,
    last: () => last,
    /** Для агента: без apply — план; с apply — перенос. При нескольких письмах нужен id. */
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
