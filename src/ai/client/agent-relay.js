(function (root) {
  'use strict';

  // RetKit ↔ the person's own agent (Claude / Codex), through Retention Studio.
  //
  // The agent connects to the studio by a personal link (MCP). The email lives
  // here, in the MoEngage tab, which the cloud cannot reach. So the "Агент"
  // button opens a small studio window (relay.html): it has the studio's own
  // browser identity (one link for studio + MoEngage), long-polls the studio for
  // commands and passes them here by postMessage. Only the studio origin is
  // trusted. Saving the campaign in MoEngage always stays a human click.

  const DEFAULT_STUDIO = 'https://retention-tool-kit-127e48dd48c6.herokuapp.com';
  const WINDOW_NAME = 'retkit-agent-relay';

  function stableHash(value) {
    const input = String(value ?? '');
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${(hash >>> 0).toString(36)}:${input.length}`;
  }

  function bodyHasContent(html) {
    const match = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(String(html || ''));
    const body = match ? match[1] : String(html || '');
    if (/<(img|table|a)\b/i.test(body)) return true;
    return body.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '').replace(/&nbsp;|\s/g, '').length > 0;
  }

  function studioUrl() {
    try { return (root.localStorage?.getItem('retkit-studio-url') || DEFAULT_STUDIO).replace(/\/+$/, ''); } catch { return DEFAULT_STUDIO; }
  }

  const ws = () => root.__RetKitAiWorkspaceApi || null;
  const core = () => root.__RetKitMoEngageCore || null;
  const bridge = () => root.__RetKitMoEngageBridgeApi || null;
  const workspaceOpen = () => Boolean(root.document?.getElementById('retkit-mo-workspace'));
  const normLocale = (value) => String(value || '').trim().toUpperCase();

  function requireWorkspace() {
    if (!workspaceOpen() || !ws()) throw new Error('RetKit закрыт. Попросите человека открыть письмо в MoEngage и нажать RetKit.');
    if (core()?.isMultiLocaleBusy?.()) throw new Error('RetKit сейчас обходит локали (поиск или замена) — подождите и повторите.');
  }

  async function snapshot() {
    const api = ws();
    let locales = [];
    try { locales = await api?.listLocales?.() || []; } catch {}
    const html = workspaceOpen() ? String(api?.getCurrentHtml?.() || '') : '';
    return {
      workspaceOpen: workspaceOpen(),
      page: root.location?.pathname || '',
      locale: normLocale(api?.getActiveLocale?.()),
      locales: Array.isArray(locales) ? locales.map(normLocale) : [],
      subject: String(api?.getSubject?.() || ''),
      htmlLength: html.length,
      hash: html ? stableHash(html) : '',
      note: 'Сохранение кампании в MoEngage делает человек.',
    };
  }

  async function readEmail({ locale } = {}) {
    requireWorkspace();
    const api = ws();
    const current = normLocale(api.getActiveLocale?.());
    const wanted = normLocale(locale) || current;
    if (!wanted || wanted === current) {
      const html = String(api.getCurrentHtml() || '');
      return { locale: current, html, hash: stableHash(html) };
    }
    const flushed = await core()?.flushBeforeLocaleSwitch?.();
    if (flushed && flushed.ok === false) throw new Error(`Не удалось досохранить ${current} перед переключением: ${flushed.reason || 'неизвестно'}`);
    let html = '';
    try {
      const read = await bridge().readLocaleHtmlSettled(wanted);
      html = String(read?.html || '');
      if (read && read.confirmed === false) throw new Error(`MoEngage не подтвердил содержимое ${wanted} — попробуйте ещё раз.`);
    } finally {
      if (current) await bridge().switchLocale(current);
    }
    return { locale: wanted, html, hash: stableHash(html), note: `Человек снова на ${current}.` };
  }

  async function writeEmail({ html, based_on_hash: basedOn } = {}) {
    requireWorkspace();
    const api = ws();
    const next = String(html ?? '');
    const current = String(api.getCurrentHtml() || '');
    if (!basedOn) throw new Error('Нужен based_on_hash из moengage_read_email.');
    if (stableHash(current) !== String(basedOn)) throw new Error('Письмо изменилось после чтения (человек правит?). Перечитайте moengage_read_email и повторите.');
    if (!bodyHasContent(next)) throw new Error('В новом HTML пустой <body> — не записываю, чтобы не стереть письмо.');
    if (next === current) return { ok: true, changed: false };
    const ok = await api.setHtml(next);
    try { root.__RetKitDiagnostics?.breadcrumb?.('agent.write', { locale: api.getActiveLocale?.(), length: next.length }); } catch {}
    return { ok: ok !== false, changed: true, locale: normLocale(api.getActiveLocale?.()), hash: stableHash(String(api.getCurrentHtml() || '')),
      note: 'Записано в редактор RetKit/MoEngage. Кампанию в MoEngage человек сохраняет сам.' };
  }

  async function run(tool, args) {
    if (tool === 'status') return snapshot();
    if (tool === 'read_email') return readEmail(args);
    if (tool === 'write_email') return writeEmail(args);
    if (tool === 'switch_locale') {
      requireWorkspace();
      const flushed = await core()?.flushBeforeLocaleSwitch?.();
      if (flushed && flushed.ok === false) throw new Error(`Не удалось досохранить перед переключением: ${flushed.reason || ''}`);
      const ok = await bridge().switchLocale(normLocale(args?.locale));
      return { ok: Boolean(ok), locale: normLocale(ws().getActiveLocale?.()) };
    }
    if (tool === 'find_across_locales') {
      requireWorkspace();
      const plan = await ws().acrossLocales({ query: String(args?.query || ''), replacement: args?.replacement });
      return { ...plan, note: args?.replacement !== undefined ? 'Замена подготовлена и показана человеку — нажимает он.' : undefined };
    }
    if (tool === 'validator') { requireWorkspace(); return { issues: ws().getValidatorIssues?.() || [] }; }
    throw new Error(`Неизвестная команда: ${tool}`);
  }

  // ─── Связь с окном студии ─────────────────────────────────────────────────
  let relayWindow = null;
  let relayOrigin = '';
  let acked = false;
  let heartbeat = null;

  // Одно состояние «AI» на всё расширение. Панель внизу только рисует его,
  // поэтому после закрытия/открытия RetKit индикатор тот же, что и был.
  const agentState = {
    relay: 'off',          // off | opening | on
    agentSeenAt: 0,        // когда агент последний раз заходил по личной ссылке (из студии)
    client: '',            // Claude / Codex — как он представился
    prompt: '',            // текст «для агента»: ссылка + что делать
    busy: false,
    lastActivityAt: 0,
    feed: [],              // что агент делал в этой вкладке
  };
  const listeners = new Set();
  function emitState() {
    for (const fn of listeners) { try { fn(getState()); } catch {} }
  }
  function getState() {
    return { ...agentState, feed: agentState.feed.slice() };
  }
  function subscribe(fn) {
    listeners.add(fn);
    try { fn(getState()); } catch {}
    return () => listeners.delete(fn);
  }
  function setButton(state) {
    const next = state === 'on' ? 'on' : 'off';
    if (agentState.relay === next) return;
    agentState.relay = next;
    emitState();
  }

  const TOOL_WORDS = {
    status: 'проверил, что открыто',
    read_email: 'прочитал письмо',
    write_email: 'записал правку',
    switch_locale: 'переключил локаль',
    find_across_locales: 'искал по локалям',
    validator: 'проверил ошибки HTML',
  };
  function feedText(tool, args, reply) {
    const locale = normLocale(reply?.result?.locale || args?.locale || '');
    if (tool === 'find_across_locales' && args?.replacement !== undefined) return 'подготовил замену по локалям — подтверждаете вы';
    const base = TOOL_WORDS[tool] || tool;
    return locale && tool !== 'status' ? `${base} · ${locale}` : base;
  }
  function pushFeed(entry) {
    agentState.feed.unshift({ at: Date.now(), ...entry });
    agentState.feed.length = Math.min(agentState.feed.length, 40);
  }

  async function copyPrompt() {
    const text = agentState.prompt;
    if (!text) return false;
    try { await root.navigator.clipboard.writeText(text); return true; } catch {}
    try {
      const area = root.document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;opacity:0';
      root.document.body.appendChild(area);
      area.select();
      const ok = root.document.execCommand('copy');
      area.remove();
      return ok;
    } catch { return false; }
  }

  function post(message) {
    if (!relayWindow || relayWindow.closed) return false;
    try { relayWindow.postMessage({ source: 'retkit', ...message }, relayOrigin || studioUrl()); return true; } catch { return false; }
  }

  async function sendStatus() {
    if (!relayWindow || relayWindow.closed) { acked = false; setButton('off'); return; }
    post({ type: 'status', status: await snapshot().catch(() => null) });
    if (!acked) post({ type: 'hello' });
  }

  function connect() {
    const url = `${studioUrl()}/relay.html`;
    relayOrigin = new URL(url).origin;
    // Named window: a second press, or RetKit after a page reload, finds the
    // same window instead of opening another one.
    relayWindow = root.open(url, WINDOW_NAME, 'popup,width=440,height=420');
    if (!relayWindow) { root.alert?.('Браузер заблокировал окно связи — разрешите всплывающие окна для MoEngage.'); return; }
    acked = false;
    if (agentState.relay !== 'on') { agentState.relay = 'opening'; emitState(); }
    post({ type: 'hello' });
    clearInterval(heartbeat);
    heartbeat = setInterval(sendStatus, 4000);
    setTimeout(sendStatus, 800);
  }

  root.addEventListener?.('message', async (event) => {
    if (!relayOrigin || event.origin !== relayOrigin) return;
    const msg = event.data;
    if (!msg || msg.source !== 'retkit-relay') return;
    if (event.source && event.source !== relayWindow) relayWindow = event.source;
    if (msg.type === 'hello-ack') { acked = true; setButton('on'); return; }
    if (msg.type === 'link') {
      // Окно студии знает личную ссылку и когда агент по ней заходил.
      agentState.prompt = String(msg.prompt || '');
      agentState.agentSeenAt = Number(msg.lastSeenAt || 0) || agentState.agentSeenAt;
      agentState.client = String(msg.lastClient || agentState.client || '');
      if (!acked) { acked = true; agentState.relay = 'on'; }
      emitState();
      return;
    }
    if (msg.type !== 'command') return;
    const tool = String(msg.tool || '');
    agentState.busy = true;
    agentState.lastActivityAt = Date.now();
    agentState.agentSeenAt = Date.now();
    emitState();
    let reply;
    try {
      reply = { ok: true, result: await run(tool, msg.args || {}) };
    } catch (error) {
      reply = { ok: false, error: String(error?.message || error) };
    }
    agentState.busy = false;
    agentState.lastActivityAt = Date.now();
    if (tool !== 'status') pushFeed({ tool, ok: reply.ok, text: feedText(tool, msg.args || {}, reply), error: reply.ok ? '' : reply.error });
    emitState();
    post({ type: 'result', id: msg.id, ...reply });
  });

  // Кнопки «Агент» в верхней панели больше нет: подключение и статус — в
  // панели AI внизу (одно место, один индикатор).
  function ensureUi() {
    root.document?.getElementById('retkit-agent-button')?.remove();
    if (relayWindow && relayWindow.closed && agentState.relay !== 'off') setButton('off');
  }

  root.__RetKitAgentRelay = { ensureUi, run, stableHash, bodyHasContent, studioUrl, connect, copyPrompt, getState, subscribe, feedText };
})(typeof window !== 'undefined' ? window : globalThis);
