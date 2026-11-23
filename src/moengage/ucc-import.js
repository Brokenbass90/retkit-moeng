(function (root) {
  'use strict';

  // Перенос письма из UCC в открытое письмо MoEngage.
  //
  // Связь с UCC — скрипт «RetKit UCC Export» (стоит и на UCC, и здесь):
  // window.__RetKitUccLink. Задание приходит готовым: футер заменён на content
  // blocks, отписка в низу футера, локали UCC сопоставлены с MoEngage, Default = EN.
  //
  // Правила записи (после пилота 23.11):
  //   • локали мост НЕ создаёт: меню «+ Locale» MoEngage добавляло не те языки.
  //     Письмо с нужными локалями создаёт Claude через коннектор MoEngage (или человек);
  //   • перед записью проверяется, что открыта именно нужная вкладка локали —
  //     иначе локаль пропускается (никогда не пишем в чужую вкладку);
  //   • отправителя мост не меняет — он задаётся при создании письма.
  //
  // UI: круглая кнопка в правом нижнем углу (и кнопка в панели RetKit) → меню
  // переноса. Перенос можно запустить и из UCC: там выбирают вкладку MoEngage.

  const POP_ID = 'retkit-mo-ucc-pop';
  const FAB_ID = 'retkit-mo-ucc-fab';
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
    if (!l) return { linkInstalled: false, online: false, ready: false, tabs: [], line: 'UCC: мост не установлен (RetKit UCC Export 0.7+)' };
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
    const write = transfer.locales.filter((l) => have.has(localeKey(l.mo))).map((l) => l.mo);
    const missing = transfer.locales.map((l) => l.mo).filter((mo) => !have.has(localeKey(mo)));
    return {
      name: transfer.name, id: transfer.id, microservice: transfer.microservice, env: envOf(transfer.host),
      existing: existing.map(localeKey), write, missing, skipped: transfer.skipped || [], empty: transfer.empty || [],
      placeholders: Object.keys(transfer.placeholders || {}), footerLeftovers: transfer.footerLeftovers || [],
    };
  }

  /** Открыть вкладку локали и убедиться, что открыта именно она. */
  async function openLocale(a, mo) {
    const want = localeKey(mo);
    const ok = await a.switchLocale(mo);
    await wait(150);
    let now = '';
    try { now = localeKey(a.getNativeTabLocale?.() || a.getActiveLocale?.() || ''); } catch {}
    if (!ok || (now && now !== want)) throw new Error(`не открылась вкладка ${mo}${now ? ` (открыта ${now})` : ''} — не пишу`);
  }

  let running = false;
  let last = null;
  async function apply(transfer, { onLine = () => {}, onLocale = () => {} } = {}) {
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
      if (!p.write.length) throw new Error(`В этом письме нет ни одной нужной локали (${p.missing.join(', ')}). Создайте письмо с локалями через Claude или выберите другое письмо.`);
      for (const mo of p.missing) { onLocale(mo, 'fail', 'нет в этом письме MoEngage'); results.push({ locale: mo, ok: false, reason: 'нет в письме' }); }
      const origin = a.getActiveLocale?.() || '';
      const todo = transfer.locales.filter((l) => p.write.includes(l.mo));
      c?.setMultiLocaleBusy?.(true, `UCC 0/${todo.length}…`);
      try {
        for (let i = 0; i < todo.length; i += 1) {
          const l = todo[i];
          c?.setMultiLocaleBusy?.(true, `UCC ${i + 1}/${todo.length}…`);
          onLocale(l.mo, 'run');
          try {
            await openLocale(a, l.mo);
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
      if (origin) { try { await a.switchLocale(origin); } catch {} }
      try { a.refreshUi?.(); } catch {}
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      if (p.missing.length) say(`Нет в этом письме: ${p.missing.join(', ')} — создайте письмо с этими локалями`, 'warn');
      say(failed ? `Перенесено ${ok} из ${results.length}` : `Перенесено ${ok} из ${results.length}. Проверьте и сохраните кампанию.`, failed ? 'warn' : 'ok');
      last = { ts: Date.now(), name: transfer.name, state: failed ? 'partial' : 'done', ok, failed, results, lines };
      diag('ucc.import.done', { name: transfer.name, ok, failed });
      return { ok: !failed, written: ok, failed, results, skipped: transfer.skipped || [], lines, note: 'Кампанию в MoEngage сохраняет человек.' };
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
      #${FAB_ID}{position:fixed;right:18px;bottom:18px;z-index:2147483646;height:42px;padding:0 16px 0 12px;border-radius:21px;border:1px solid #2a3647;
        background:#0f1722;color:#e6edf7;font:600 13px/1 Inter,ui-sans-serif,-apple-system,sans-serif;display:flex;align-items:center;gap:8px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35)}
      #${FAB_ID}.ready{background:#15803d;border-color:#16a34a;color:#fff}
      #${POP_ID}{position:fixed;right:18px;bottom:70px;z-index:2147483646;width:380px;max-height:70vh;overflow:auto;background:#0f1722;color:#e6edf7;
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
      #${POP_ID} .u-chip.miss{border-style:dashed;color:#fbbf24}
      #${POP_ID} .u-chip.skip{opacity:.45;text-decoration:line-through}
      #${POP_ID} .u-chip.run{background:#1e3a8a;color:#fff}
      #${POP_ID} .u-chip.ok{background:#14532d;border-color:#166534;color:#bbf7d0}
      #${POP_ID} .u-chip.fail{background:#5b1a1a;border-color:#7f1d1d;color:#fecaca}
      #${POP_ID} .u-note{color:#8a98ad;margin-top:6px}
      #${POP_ID} .u-warn{color:#fbbf24;margin-top:6px}
      #${POP_ID} .u-err{background:#3a1416;border:1px solid #7f1d1d;color:#fecaca;border-radius:8px;padding:6px 9px;margin:5px 0;white-space:pre-wrap}
      #${POP_ID} .u-ok{color:#86efac;margin-top:8px}
      #${POP_ID} .u-foot{display:flex;gap:8px;align-items:center;padding:10px 14px 14px;border-top:1px solid #1f2b3b}
      #${POP_ID} .u-go{flex:1;background:#2563eb;border:0;color:#fff;border-radius:8px;padding:9px 12px;font:600 12px/1 inherit;cursor:pointer}
      #${POP_ID} .u-go:disabled{background:#334155;cursor:default}
      #${POP_ID} .u-spin{color:#8a98ad}
      .rk-ucc-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:0 0 8px}
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

  let selected = null; // { id, host }
  let cached = null;   // { key, transfer }

  async function open(pushed = null) {
    const existing = root.document.getElementById(POP_ID);
    if (existing && !pushed) { if (!running) closePop(); return; }
    existing?.remove();
    injectStyle();
    const pop = h('div'); pop.id = POP_ID;
    root.document.body.appendChild(pop);
    if (pushed?.transfer) {
      selected = { id: pushed.transfer.id, host: pushed.transfer.host };
      cached = { key: `${pushed.transfer.host}#${pushed.transfer.id}`, transfer: pushed.transfer };
    }
    await render(pop, pushed);
  }

  async function render(pop, pushed = null) {
    pop.textContent = '';
    const head = h('div', 'u-h'); head.append(h('span', null, 'Перенос из UCC'));
    const x = h('button', 'u-x', '×'); x.addEventListener('click', () => { if (!running) closePop(); }); head.append(x);
    pop.append(head);
    const s = status();
    const sec = h('div', 'u-sec'); pop.append(sec);
    if (!pushed && (!s.linkInstalled || !s.tabs.length)) {
      sec.append(h('div', 'u-err', s.linkInstalled ? 'В UCC не открыто ни одного письма. Откройте письмо в UCC — оно появится здесь.' : s.line));
      return;
    }
    if (!pushed) {
      if (!selected || !s.tabs.some((t) => String(t.id) === String(selected.id) && t.host === selected.host)) selected = { id: s.tabs[0].id, host: s.tabs[0].host };
      sec.append(h('div', 'u-cap', s.tabs.length > 1 ? `Откуда (открыто в UCC: ${s.tabs.length})` : 'Откуда'));
      for (const t of s.tabs) {
        const b = h('button', `u-mail${String(t.id) === String(selected.id) && t.host === selected.host ? ' on' : ''}`);
        b.append(h('b', null, t.name || `#${t.id}`), h('span', `u-tag${t.env === 'INT' ? ' int' : ''}`, t.env), h('span', 'u-tag', t.microservice || '—'), h('span', 'u-tag', `${t.locales || '?'} лок.`));
        b.addEventListener('click', () => { if (running) return; selected = { id: t.id, host: t.host }; cached = null; render(pop); });
        sec.append(b);
      }
    } else {
      sec.append(h('div', 'u-cap', 'Откуда (выбрано в UCC)'));
      const b = h('div', 'u-mail on');
      b.append(h('b', null, pushed.transfer.name), h('span', `u-tag${envOf(pushed.transfer.host) === 'INT' ? ' int' : ''}`, envOf(pushed.transfer.host)), h('span', 'u-tag', pushed.transfer.microservice || '—'));
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
      go.onclick = () => { cached = null; render(pop, pushed); };
      reportPush(pushed, { state: 'error', error: error?.message || String(error) });
      return;
    }
    body.append(h('div', 'u-cap', 'Куда: локали этого письма MoEngage'));
    const chips = h('div', 'u-chips'); body.append(chips);
    const chipBy = new Map();
    for (const l of transfer.locales) {
      const miss = pl.missing.includes(l.mo);
      const c = h('span', `u-chip${miss ? ' miss' : ''}`, l.mo);
      c.title = miss ? 'Такой локали нет в этом письме MoEngage — не переносится' : 'HTML и Subject будут заменены';
      chipBy.set(l.mo, c); chips.append(c);
    }
    for (const sk of pl.skipped) { const c = h('span', 'u-chip skip', sk); c.title = 'Такой локали нет в MoEngage вообще'; chips.append(c); }
    if (pl.missing.length) body.append(h('div', 'u-warn', `Пунктир — нет в этом письме: ${pl.missing.join(', ')}. Локали создаёт Claude при создании письма.`));
    if (pl.skipped.length) body.append(h('div', 'u-note', 'Зачёркнутые — нет в MoEngage, попросить завести.'));
    if (pl.empty.length) body.append(h('div', 'u-warn', `Пустые в UCC: ${pl.empty.join(', ')}`));
    if (pl.footerLeftovers.length) body.append(h('div', 'u-err', `Футер не заменён: ${pl.footerLeftovers.join(', ')}`));
    if (pl.placeholders.length) body.append(h('div', 'u-note', `Остаются как есть: ${pl.placeholders.join(' ')}`));
    const out = h('div'); body.append(out);
    const run = async () => {
      go.disabled = true; go.textContent = 'Переношу…';
      out.textContent = '';
      reportPush(pushed, { state: 'running', done: 0, total: pl.write.length });
      let done = 0;
      try {
        const res = await apply(transfer, {
          onLocale: (mo, st, title) => {
            const c = chipBy.get(mo); if (c) { c.className = `u-chip ${st}`; if (title) c.title = title; }
            if (st === 'ok' || st === 'fail') { done += 1; reportPush(pushed, { state: 'running', done, total: transfer.locales.length, last: `${mo}: ${st === 'ok' ? '✓' : `✕ ${title || ''}`}` }); }
          },
          onLine: (text, kind) => { if (kind === 'error') out.append(h('div', 'u-err', text)); },
        });
        out.append(h('div', res.failed ? 'u-warn' : 'u-ok', res.failed ? `Перенесено ${res.written} из ${res.results.length}. Красные — наведите, там причина.` : `Готово: ${res.written} лок. Проверьте и сохраните кампанию.`));
        reportPush(pushed, { state: 'done', ok: res.written, failed: res.failed, lines: res.lines });
        go.textContent = 'Закрыть'; go.disabled = false; go.onclick = closePop;
      } catch (error) {
        out.append(h('div', 'u-err', error?.message || String(error)));
        reportPush(pushed, { state: 'error', error: error?.message || String(error) });
        go.textContent = 'Повторить'; go.disabled = false;
        go.onclick = () => { cached = null; render(pop, pushed); };
      }
    };
    if (!pl.write.length) {
      go.textContent = 'Нет подходящих локалей'; go.disabled = true;
      reportPush(pushed, { state: 'error', error: 'В письме MoEngage нет нужных локалей' });
      return;
    }
    go.disabled = false;
    go.textContent = `Перенести ${pl.write.length} лок.`;
    go.onclick = run;
    if (pushed?.auto) run(); // запуск выбран в UCC — человек уже нажал
  }

  function reportPush(pushed, patch) {
    if (!pushed?.requestId) return;
    try { link()?.reportStatus?.(pushed.requestId, patch); } catch {}
  }

  // Кнопка в углу + кнопка в панели RetKit.
  let barButton = null;
  function paint() {
    const s = status();
    const ready = s.linkInstalled && s.tabs.length > 0;
    const text = !s.linkInstalled ? 'UCC: нет моста' : (!ready ? 'UCC: нет письма' : (s.tabs.length > 1 ? `Из UCC · ${s.tabs.length} письма` : `Из UCC · ${s.tabs[0].name || s.tabs[0].id}`));
    const title = ready ? `${s.tabs.map((t) => t.label).join('\n')}\nНажмите — меню переноса в это письмо MoEngage` : s.line;
    const fill = (b) => {
      b.textContent = '';
      const dot = h('span', 'rk-ucc-dot'); dot.style.background = ready ? '#4ade80' : '#64748b';
      b.append(dot, root.document.createTextNode(text.length > 30 ? `${text.slice(0, 29)}…` : text));
      b.title = title;
    };
    if (root.document?.body && api()) {
      injectStyle();
      let fab = root.document.getElementById(FAB_ID);
      if (!fab) { fab = h('button'); fab.id = FAB_ID; fab.type = 'button'; fab.addEventListener('click', () => open()); root.document.body.appendChild(fab); }
      fab.className = ready ? 'ready' : '';
      fill(fab);
    }
    if (barButton?.isConnected) {
      fill(barButton);
      barButton.style.background = ready ? '#15803d' : '';
      barButton.style.color = ready ? '#fff' : '';
    }
    root.document.getElementById('retkit-mo-ucc-banner')?.remove(); // полоса из 0.11.3 больше не нужна
  }
  function bindButton(button) { barButton = button; paint(); }

  let started = false;
  function start() {
    const l = link();
    if (started || !l) return;
    started = true;
    l.onPresence?.(() => paint());
    l.onPush?.((req) => { if (req?.transfer) open(req); });
  }
  const tickUi = () => { start(); paint(); };
  if (typeof setInterval === 'function') setInterval(tickUi, 2000); else root.setInterval?.(tickUi, 2000);
  try { root.addEventListener?.('retkit:ucc-link-ready', start); } catch {}

  root.__RetKitUccImport = {
    status, plan, apply, open, bindButton, localeKey,
    last: () => last,
    /** Для агента: без apply — план; с apply — перенос. При нескольких письмах нужен id. */
    async agent({ apply: doApply = false, id } = {}) {
      const s = status();
      if (!s.linkInstalled) throw new Error(s.line);
      if (!s.ready) throw new Error(`${s.line}. Попросите открыть письмо в UCC.`);
      if (!id && s.tabs.length > 1) return { choose: s.tabs.map((t) => ({ id: t.id, host: t.host, label: t.label })), note: 'Открыто несколько писем UCC — повторите с id.' };
      const t = s.tabs.find((x) => String(x.id) === String(id || s.id)) || s.tabs[0];
      const transfer = await link().pull({ id: t.id, host: t.host });
      if (!doApply) return { plan: await plan(transfer), note: 'Это план. Перенос — тот же вызов с apply: true (после согласия человека).' };
      return apply(transfer);
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
