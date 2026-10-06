// ==UserScript==
// @name         RetKit for MoEngage
// @namespace    https://github.com/Brokenbass90/retkit-moeng
// @version      0.8.1
// @description  RetKit workspace with native MoEngage locale tabs, RTL and Test Campaign bridge.
// @match        https://dashboard-02.moengage.com/*
// @updateURL    https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/dist/retkit-moengage.user.js
// @downloadURL  https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/dist/retkit-moengage.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function (root) {
  'use strict';

  const STORAGE_KEY = 'retkit-diagnostics-incidents-v1';
  const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000;
  const DEFAULT_MAX_BREADCRUMBS = 200;
  const DEFAULT_MAX_INCIDENTS = 25;
  const DEFAULT_MAX_BYTES = 1536 * 1024;
  const DEFAULT_DEDUPE_WINDOW = 60 * 1000;

  function safeJsonParse(value, fallback) {
    try { return JSON.parse(String(value || '')); } catch { return fallback; }
  }

  function hashText(value) {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function sanitizeMeta(input, depth = 0) {
    if (depth > 5) return '[truncated]';
    if (input == null || typeof input === 'number' || typeof input === 'boolean') return input;
    if (typeof input === 'string') return input.length > 600 ? `${input.slice(0, 600)}…` : input;
    if (Array.isArray(input)) return input.slice(0, 40).map((item) => sanitizeMeta(item, depth + 1));
    if (typeof input !== 'object') return String(input);
    const output = {};
    for (const [key, value] of Object.entries(input)) {
      if (/(?:html|content|source|body|subjectValue|rawText)$/i.test(key) && typeof value === 'string') {
        const stringValue = String(value ?? '');
        output[`${key}Length`] = stringValue.length;
        output[`${key}Hash`] = hashText(stringValue);
        continue;
      }
      output[key] = sanitizeMeta(value, depth + 1);
    }
    return output;
  }

  function utf8Bytes(value) {
    const text = String(value ?? '');
    try { return new TextEncoder().encode(text).length; } catch { return text.length * 2; }
  }

  function createRecorder(options = {}) {
    const storage = options.storage || root.localStorage || null;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const key = options.storageKey || STORAGE_KEY;
    const versionKey = options.versionKey || `${key}-version`;
    let activeVersion = '';
    const maxBreadcrumbs = Math.max(1, Number(options.maxBreadcrumbs) || DEFAULT_MAX_BREADCRUMBS);
    const maxIncidents = Math.max(1, Number(options.maxIncidents) || DEFAULT_MAX_INCIDENTS);
    const ttlMs = Math.max(1000, Number(options.ttlMs) || DEFAULT_TTL);
    const maxBytes = Math.max(50000, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
    const dedupeWindowMs = Math.max(0, Number(options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW) || 0);
    const getLocation = typeof options.getLocation === 'function'
      ? options.getLocation
      : () => String(root.location?.pathname || '');
    const breadcrumbs = [];
    const listeners = new Set();

    function setVersion(version) {
      const next = String(version || '').trim();
      if (!next || next === activeVersion) return false;
      const previous = String(storage?.getItem?.(versionKey) || '').trim();
      if (previous && previous !== next) {
        try { storage?.removeItem?.(key); } catch {}
      }
      try { storage?.setItem?.(versionKey, next); } catch {}
      activeVersion = next;
      if (previous && previous !== next) notify();
      return Boolean(previous && previous !== next);
    }

    function readIncidents() {
      const parsed = safeJsonParse(storage?.getItem?.(key), []);
      return Array.isArray(parsed) ? parsed : [];
    }

    function trimToLimits(items) {
      const cutoff = now() - ttlMs;
      let next = items.filter((item) => Number(item?.time) >= cutoff).slice(-maxIncidents);
      while (next.length > 1 && utf8Bytes(JSON.stringify(next)) > maxBytes) next.shift();
      return next;
    }

    function writeIncidents(items) {
      if (!storage?.setItem) return;
      const next = trimToLimits(items);
      try { storage.setItem(key, JSON.stringify(next)); } catch {
        // If quota is unexpectedly tight, retain only the newest incident.
        try { storage.setItem(key, JSON.stringify(next.slice(-1))); } catch {}
      }
    }

    function notify() {
      const summary = getSummary();
      for (const listener of listeners) {
        try { listener(summary); } catch {}
      }
    }

    function cleanup() {
      writeIncidents(readIncidents());
      notify();
    }

    function breadcrumb(type, meta = {}) {
      breadcrumbs.push({ time: now(), type: String(type || 'event'), meta: sanitizeMeta(meta) });
      if (breadcrumbs.length > maxBreadcrumbs) breadcrumbs.splice(0, breadcrumbs.length - maxBreadcrumbs);
    }

    function incident(type, message, meta = {}) {
      const items = readIncidents();
      const incidentTime = now();
      const incidentType = String(type || 'unknown');
      const incidentMessage = String(message || type || 'RetKit anomaly');
      const page = String(getLocation() || '').split('?')[0];
      const sanitizedMeta = sanitizeMeta(meta);
      const previous = items.at(-1);
      const previousTime = Number(previous?.lastTime || previous?.time || 0);
      const canMerge = Boolean(previous)
        && dedupeWindowMs > 0
        && previous.type === incidentType
        && previous.message === incidentMessage
        && String(previous.page || '') === page
        && incidentTime >= previousTime
        && (incidentTime - previousTime) <= dedupeWindowMs;

      if (canMerge) {
        previous.repeatCount = Math.max(1, Number(previous.repeatCount) || 1) + 1;
        previous.firstTime = Number(previous.firstTime || previous.time || incidentTime);
        previous.time = incidentTime;
        previous.lastTime = incidentTime;
        previous.lastMeta = sanitizedMeta;
        previous.context = breadcrumbs.slice(-40);
        writeIncidents(items);
        notify();
        return previous;
      }

      const created = {
        id: `${incidentTime.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        time: incidentTime,
        firstTime: incidentTime,
        lastTime: incidentTime,
        repeatCount: 1,
        page,
        type: incidentType,
        message: incidentMessage,
        meta: sanitizedMeta,
        context: breadcrumbs.slice(-40),
        ...(activeVersion ? { version: activeVersion } : {}),
      };
      items.push(created);
      writeIncidents(items);
      notify();
      return created;
    }

    function getBreadcrumbs() { return breadcrumbs.map((item) => ({ ...item, meta: sanitizeMeta(item.meta) })); }
    function getIncidents() { return trimToLimits(readIncidents()); }
    function getSummary() {
      const incidents = getIncidents();
      return { count: incidents.length, latest: incidents.at(-1) || null };
    }
    function clear() {
      try { storage?.removeItem?.(key); } catch {}
      breadcrumbs.length = 0;
      notify();
    }
    function exportReport(extra = {}) {
      cleanup();
      return {
        schema: 1,
        generatedAt: now(),
        retkitVersion: String(extra.retkitVersion || ''),
        environment: sanitizeMeta(extra.environment || {}),
        incidents: getIncidents(),
        breadcrumbs: getBreadcrumbs().slice(-80),
        // Вторая колонка отчёта: как устроена страница MoEngage (без значений).
        ...(root.__RetKitFunctionMap?.export && extra.includeFunctionality !== false
          ? { functionality: root.__RetKitFunctionMap.export() } : {}),
        ...(extra.includeHtml && typeof extra.html === 'string' ? { html: extra.html } : {}),
      };
    }
    function subscribe(listener) {
      listeners.add(listener);
      try { listener(getSummary()); } catch {}
      return () => listeners.delete(listener);
    }

    cleanup();
    return { breadcrumb, incident, cleanup, clear, exportReport, getSummary, getIncidents, getBreadcrumbs, subscribe, setVersion };
  }

  const recorder = (typeof document !== 'undefined') ? createRecorder({}) : null;

  function environmentSnapshot() {
    return {
      userAgent: String(root.navigator?.userAgent || ''),
      platform: String(root.navigator?.platform || ''),
      language: String(root.navigator?.language || ''),
      viewport: { width: Number(root.innerWidth || 0), height: Number(root.innerHeight || 0) },
      url: String(root.location?.href || '').split('?')[0],
    };
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  let uiUnsubscribe = null;

  function ensureUi(workspace, options = {}) {
    if (!workspace || typeof document === 'undefined' || !recorder) return;
    try { recorder.setVersion?.(String(options.version || '')); } catch {}
    const bar = workspace.querySelector('.rk-topbar');
    if (!bar || document.getElementById('retkit-diagnostics-button')) return;

    const button = document.createElement('button');
    button.id = 'retkit-diagnostics-button';
    button.className = 'rk-btn';
    button.type = 'button';
    button.title = 'RetKit anomaly detector and diagnostic reports';
    const renderBadge = (summary) => {
      const count = Number(summary?.count || 0);
      button.textContent = count ? `⚠ Logs ${count}` : '✓ Logs';
      button.classList.toggle('rk-active', count > 0);
    };
    try { uiUnsubscribe?.(); } catch {}
    uiUnsubscribe = recorder.subscribe(renderBadge);

    button.addEventListener('click', () => {
      document.getElementById('retkit-diagnostics-popover')?.remove();
      const pop = document.createElement('div');
      pop.id = 'retkit-diagnostics-popover';
      pop.style.cssText = 'position:fixed;top:58px;right:76px;z-index:2147483646;width:360px;max-height:70vh;overflow:auto;background:#111b28;border:1px solid #334155;border-radius:12px;padding:12px;color:#dce6f4;box-shadow:0 16px 40px rgba(0,0,0,.45);font:12px/1.45 Inter,system-ui,sans-serif';
      const summary = recorder.getSummary();
      pop.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px"><strong>Diagnostics</strong><button data-close style="border:0;background:transparent;color:#9fb0c4;font-size:18px;cursor:pointer">×</button></div>
        <div style="color:#8fa2b8;margin-bottom:10px">Only anomalies are stored. Normal editor events are kept briefly as context.</div>
        <div style="margin-bottom:10px"><b>${summary.count}</b> incident(s) retained · auto-clean after 7 days</div>
        <div data-recent style="display:grid;gap:5px;margin-bottom:10px"></div>
        <div data-fmap style="padding:7px;border:1px solid #263140;border-radius:7px;background:#0c141f;color:#aebdd0;margin-bottom:10px"></div>
        <label style="display:flex;gap:7px;align-items:center;margin-bottom:10px"><input type="checkbox" data-html> Include current HTML in exported report</label>
        <div style="display:flex;gap:7px;flex-wrap:wrap">
          <button class="rk-btn" data-copy>Copy report</button>
          <button class="rk-btn" data-download>Download .json</button>
          <button class="rk-btn" data-clear>Clear</button>
        </div>`;
      const recent = recorder.getIncidents().slice(-5).reverse();
      const recentHost = pop.querySelector('[data-recent]');
      for (const item of recent) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:6px 7px;border:1px solid #263140;border-radius:7px;background:#0c141f;color:#aebdd0';
        const repeats = Number(item.repeatCount || 1) > 1 ? ` ×${Number(item.repeatCount)}` : '';
        row.textContent = `${item.type}${repeats} · ${item.message}`;
        row.title = `${new Date(Number(item.lastTime || item.time || 0)).toLocaleString()} · ${item.page || ''}`;
        recentHost?.appendChild(row);
      }
      const fmapHost = pop.querySelector('[data-fmap]');
      const renderFmap = () => {
        const m = root.__RetKitFunctionMap?.summary?.();
        if (!fmapHost) return;
        if (!m) { fmapHost.remove(); return; }
        fmapHost.innerHTML = `<b>Functionality map</b> · ${m.endpoints} requests · ${m.controls} controls · ${m.screens} screens`
          + '<div style="color:#8fa2b8;margin:3px 0 6px">Shapes only: no tokens, emails or email texts. Goes into the downloaded report.</div>'
          + '<button class="rk-btn" data-fmap-snap>Snapshot screen</button> <button class="rk-btn" data-fmap-clear>Clear map</button>';
        fmapHost.querySelector('[data-fmap-snap]')?.addEventListener('click', () => { root.__RetKitFunctionMap?.snapshotNow?.(); renderFmap(); });
        fmapHost.querySelector('[data-fmap-clear]')?.addEventListener('click', () => { root.__RetKitFunctionMap?.clear?.(); renderFmap(); });
      };
      renderFmap();
      const makeReport = () => recorder.exportReport({
        retkitVersion: String(options.version || ''),
        environment: environmentSnapshot(),
        includeHtml: Boolean(pop.querySelector('[data-html]')?.checked),
        html: pop.querySelector('[data-html]')?.checked ? String(options.getHtml?.() || '') : '',
      });
      pop.querySelector('[data-close]')?.addEventListener('click', () => pop.remove());
      pop.querySelector('[data-clear]')?.addEventListener('click', () => { recorder.clear(); pop.remove(); });
      pop.querySelector('[data-copy]')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(JSON.stringify(makeReport(), null, 2)); } catch {}
      });
      pop.querySelector('[data-download]')?.addEventListener('click', () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadJson(`retkit-diagnostics-${stamp}.json`, makeReport());
      });
      document.body.appendChild(pop);
    });

    const spacer = bar.querySelector('.rk-spacer');
    bar.insertBefore(button, spacer || bar.lastChild);
  }

  const api = {
    createRecorder,
    recorder,
    hashText,
    sanitizeMeta,
    breadcrumb: (...args) => recorder?.breadcrumb(...args),
    incident: (...args) => recorder?.incident(...args),
    ensureUi,
  };
  root.__RetKitDiagnostics = api;

  if (recorder && typeof root.setInterval === 'function') {
    const cleanupTimer = root.setInterval(() => recorder.cleanup(), 30 * 60 * 1000);
    root.addEventListener?.('beforeunload', () => {
      try { root.clearInterval?.(cleanupTimer); } catch {}
      try { uiUnsubscribe?.(); } catch {}
    }, { once: true });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

(function (root) {
  'use strict';

  /*
   * RetKit · карта функционала MoEngage.
   *
   * Тихо, без панели и без кнопок, запоминает, КАК устроена страница письма:
   *  – какие запросы она шлёт на сервер (метод, адрес-шаблон, имена полей и
   *    типы того, что ушло и пришло) и после какого нажатия;
   *  – какие кнопки нажимались (подпись + где на странице);
   *  – какие элементы управления есть на каждом экране (без значений).
   *
   * Значения НЕ хранятся: токены, cookie, email, тексты писем заменяются на
   * «<hidden>», «<email>», «<text len=42>», «<html len=…>». Запросы страницы не
   * меняются — обёртка отдаёт их дальше как есть и читает только копию ответа.
   * Ничего никуда не отправляется: карта лежит в localStorage этой вкладки и
   * уходит только в отчёт Logs, который человек скачивает сам.
   */

  const STORAGE_KEY = 'retkit-function-map-v1';
  const MAX_ENDPOINTS = 300;
  const MAX_CONTROLS = 500;
  const MAX_SCREENS = 40;
  const MAX_BYTES = 900 * 1024;
  const MAX_DEPTH = 7;
  const MAX_KEYS = 80;
  const ACTION_WINDOW_MS = 2500;
  const IGNORE_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i; // мост RetKit и прочее локальное
  const IGNORE_PATH = /\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|map)$/i;

  /* ── Обезличивание ─────────────────────────────────────────────── */
  const LOCALE = /^[a-z]{2,3}([-_][A-Za-z]{2,4})?$/;
  const ID = /^([0-9a-f]{24}|[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{6,})$/i;
  const ENUMISH = /^[A-Z][A-Z0-9_]{1,40}$|^[a-z][a-z0-9]*_[a-z0-9_]+$/;
  const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|session|api[_-]?key|csrf|xsrf|signature/i;

  function describeString(s) {
    s = String(s);
    if (s === '') return '';
    if (LOCALE.test(s)) return s;
    if (ID.test(s)) return '<id>';
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return '<email>';
    if (/^https?:\/\//i.test(s)) {
      try { const u = new URL(s); return `<url ${u.host}${routeOf(u.pathname)}>`; } catch { return '<url>'; }
    }
    if (/^\d{4}-\d\d-\d\d(T|$)/.test(s)) return '<date>';
    if (/<[a-z!][^>]*>/i.test(s)) return `<html len=${s.length}>`;
    if (/^(true|false)$/.test(s)) return s;
    if (s.length <= 40 && ENUMISH.test(s)) return `<enum ${s}>`;
    return `<text len=${s.length}>`;
  }

  function shape(value, depth = 0) {
    if (value === null || value === undefined) return null;
    const t = typeof value;
    if (t === 'string') return describeString(value);
    if (t === 'number') return '<number>';
    if (t === 'boolean') return value;
    if (t !== 'object') return `<${t}>`;
    if (depth >= MAX_DEPTH) return '<…>';
    if (Array.isArray(value)) return value.length ? { '<array>': value.length, first: shape(value[0], depth + 1) } : [];
    const out = {};
    const keys = Object.keys(value);
    for (const k of keys.slice(0, MAX_KEYS)) out[k] = SECRET_KEY.test(k) ? '<hidden>' : shape(value[k], depth + 1);
    if (keys.length > MAX_KEYS) out['<more keys>'] = keys.length - MAX_KEYS;
    return out;
  }

  /** Слить две формы: объединение ключей, чтобы видеть все поля, что встречались. */
  function mergeShape(a, b, depth = 0) {
    if (a == null) return b;
    if (b == null || depth > MAX_DEPTH) return a;
    const plain = (x) => x && typeof x === 'object' && !Array.isArray(x);
    if (plain(a) && plain(b)) {
      if ('<array>' in a && '<array>' in b) return { '<array>': Math.max(a['<array>'], b['<array>']), first: mergeShape(a.first, b.first, depth + 1) };
      const out = { ...a };
      for (const [k, v] of Object.entries(b)) out[k] = k in out ? mergeShape(out[k], v, depth + 1) : v;
      return out;
    }
    return a;
  }

  function shapeBody(body, contentType = '') {
    try {
      if (body == null || body === '') return null;
      if (typeof body === 'string') {
        const s = body.trim();
        if (/json/i.test(contentType) || /^[{[]/.test(s)) {
          try { return { json: shape(JSON.parse(s)) }; } catch { /* не JSON */ }
        }
        if (/x-www-form-urlencoded/i.test(contentType) || /^[\w.%[\]-]+=/.test(s)) {
          const form = {};
          for (const [k, v] of new URLSearchParams(s)) form[k] = SECRET_KEY.test(k) ? '<hidden>' : shape(v);
          return { form };
        }
        return { text: describeString(s) };
      }
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        const form = {}; for (const [k, v] of body) form[k] = SECRET_KEY.test(k) ? '<hidden>' : shape(v); return { form };
      }
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const form = {};
        for (const [k, v] of body) {
          form[k] = (typeof File !== 'undefined' && v instanceof File) ? `<file ${v.type || '?'}>` : (SECRET_KEY.test(k) ? '<hidden>' : shape(v));
        }
        return { multipart: form };
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) return { blob: `<${body.type || 'blob'}>` };
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { binary: true };
      return { other: Object.prototype.toString.call(body) };
    } catch (error) {
      return { error: String(error && error.message || error).slice(0, 120) };
    }
  }

  function routeOf(pathname) {
    return String(pathname || '')
      .replace(/\/([0-9a-f]{12,}|[0-9a-f]{8}-[0-9a-f-]{27}|\d{4,})(?=\/|$)/gi, '/:id')
      .replace(/\/[^/]*@[^/]*(?=\/|$)/g, '/:email');
  }

  function parseUrl(raw) {
    try {
      const u = new URL(String(raw), root.location?.href || 'https://x/');
      return { host: u.host, route: routeOf(u.pathname), queryKeys: [...new Set([...u.searchParams.keys()])].slice(0, 30), path: u.pathname };
    } catch { return null; }
  }

  function cleanLabel(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (/@|\d{6,}/.test(s) || s.length > 60) return describeString(s);
    return s;
  }

  /* ── Хранилище ─────────────────────────────────────────────────── */
  function createFunctionMap(options = {}) {
    const storage = options.storage || root.localStorage || null;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    let state = load();
    let saveTimer = null;
    let lastAction = null; // { label, time }

    function blank() { return { schema: 1, startedAt: now(), endpoints: {}, controls: {}, screens: {} }; }
    function load() {
      try {
        const parsed = JSON.parse(String(storage?.getItem?.(STORAGE_KEY) || ''));
        if (parsed && parsed.schema === 1) return parsed;
      } catch { /* пусто или повреждено */ }
      return blank();
    }
    function trim() {
      const cap = (obj, max) => {
        const keys = Object.keys(obj);
        if (keys.length <= max) return;
        keys.sort((a, b) => Number(obj[a].lastAt || 0) - Number(obj[b].lastAt || 0));
        for (const k of keys.slice(0, keys.length - max)) delete obj[k];
      };
      cap(state.endpoints, MAX_ENDPOINTS);
      cap(state.controls, MAX_CONTROLS);
      cap(state.screens, MAX_SCREENS);
      let text = JSON.stringify(state);
      // Сначала теряем самые большие формы ответов, а не сами ручки.
      while (text.length > MAX_BYTES) {
        const big = Object.values(state.endpoints).filter((e) => e.response).sort((a, b) => JSON.stringify(b.response).length - JSON.stringify(a.response).length)[0];
        if (!big) break;
        big.response = '<dropped: too large>';
        text = JSON.stringify(state);
      }
      return text;
    }
    function saveNow() {
      saveTimer = null;
      try { storage?.setItem?.(STORAGE_KEY, trim()); } catch { /* квота — карта не важнее страницы */ }
    }
    function save() {
      if (saveTimer) return;
      saveTimer = (root.setTimeout || setTimeout)(saveNow, 1500);
    }

    function noteAction(label, selector, extra = {}) {
      const time = now();
      const clean = cleanLabel(label);
      lastAction = { label: clean || selector || '(без подписи)', time };
      const key = `${clean}|${selector}`.slice(0, 300);
      const c = state.controls[key] || (state.controls[key] = { label: clean, selector, count: 0, firstAt: time, ...extra });
      c.count += 1;
      c.lastAt = time;
      c.screen = routeOf(root.location?.pathname || '');
      save();
    }

    function noteRequest({ method, url, request, status, response, ms, via }) {
      const parsed = parseUrl(url);
      if (!parsed || IGNORE_HOST.test(parsed.host) || IGNORE_PATH.test(parsed.path)) return null;
      const time = now();
      const key = `${method} ${parsed.host}${parsed.route}`;
      const e = state.endpoints[key] || (state.endpoints[key] = {
        method, host: parsed.host, route: parsed.route, via, count: 0, firstAt: time,
        statuses: {}, queryKeys: [], actions: [], screens: [],
      });
      e.count += 1;
      e.lastAt = time;
      e.statuses[String(status)] = (e.statuses[String(status)] || 0) + 1;
      e.queryKeys = [...new Set([...e.queryKeys, ...parsed.queryKeys])].slice(0, 40);
      e.request = mergeShape(e.request, request);
      if (response && (Number(status) < 400)) e.response = mergeShape(e.response, response);
      if (response && Number(status) >= 400) e.errorResponse = mergeShape(e.errorResponse, response);
      if (ms != null) e.maxMs = Math.max(Number(e.maxMs || 0), Number(ms));
      const screen = routeOf(root.location?.pathname || '');
      if (!e.screens.includes(screen)) e.screens = [...e.screens, screen].slice(-8);
      if (lastAction && time - lastAction.time <= ACTION_WINDOW_MS && !e.actions.includes(lastAction.label)) {
        e.actions = [...e.actions, lastAction.label].slice(-8);
      }
      save();
      return e;
    }

    function noteScreen(route, controls) {
      const time = now();
      const prev = state.screens[route];
      // Перезаписываем, только если экран заметно изменился: та же страница
      // не должна гонять localStorage на каждом переходе.
      if (prev && Math.abs((prev.controls?.length || 0) - controls.length) < 3) { prev.lastAt = time; prev.visits = (prev.visits || 1) + 1; save(); return; }
      state.screens[route] = { route, firstAt: prev?.firstAt || time, lastAt: time, visits: (prev?.visits || 0) + 1, controls };
      save();
    }

    function summary() {
      return {
        endpoints: Object.keys(state.endpoints).length,
        controls: Object.keys(state.controls).length,
        screens: Object.keys(state.screens).length,
      };
    }
    function exportMap() {
      if (saveTimer) { (root.clearTimeout || clearTimeout)(saveTimer); saveNow(); }
      return JSON.parse(JSON.stringify(state));
    }
    function clear() {
      state = blank();
      try { storage?.removeItem?.(STORAGE_KEY); } catch { /* */ }
    }

    return { noteAction, noteRequest, noteScreen, summary, export: exportMap, clear };
  }

  /* ── Подключение к странице ────────────────────────────────────── */
  function selectorOf(el) {
    if (!el || !el.tagName) return '';
    const parts = [];
    let node = el;
    for (let i = 0; node && node.nodeType === 1 && i < 5; i += 1) {
      let part = node.tagName.toLowerCase();
      const testId = node.getAttribute('data-testid') || node.getAttribute('data-test-id') || node.getAttribute('data-cy') || node.getAttribute('data-qa');
      if (node.id && !/\d{3,}/.test(node.id)) { parts.unshift(`${part}#${node.id}`); break; }
      if (testId) part += `[data-testid="${testId}"]`;
      else if (node.classList && node.classList.length) {
        const cls = [...node.classList].filter((c) => !/\d{3,}|^ng-|^css-|^sc-|^rk-/.test(c)).slice(0, 2);
        if (cls.length) part += `.${cls.join('.')}`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function labelOf(el) {
    return (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || '').trim();
  }
  const isOurs = (el) => Boolean(el && el.closest && el.closest('[class*="rk-"], [id^="retkit"], #rk-workspace, .rk-workspace'));

  function controlsOf(doc, frame = 'top', out = []) {
    let nodes = [];
    try { nodes = doc.querySelectorAll('button, a[href], [role=button], [role=tab], [role=menuitem], [role=option], [role=switch], input, select, textarea, [contenteditable=true], iframe'); } catch { return out; }
    for (const el of nodes) {
      if (out.length >= 400) break;
      if (isOurs(el)) continue;
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
      const tag = el.tagName.toLowerCase();
      const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
      out.push({
        frame, tag,
        type: el.getAttribute('type') || '',
        role: el.getAttribute('role') || '',
        name: el.getAttribute('name') || '',
        label: cleanLabel(isField ? (el.getAttribute('placeholder') || el.getAttribute('aria-label') || '') : labelOf(el)),
        visible: rect.width > 0 && rect.height > 0,
        disabled: Boolean(el.disabled),
        selector: selectorOf(el),
      });
      if (tag === 'iframe') {
        try { if (el.contentDocument) controlsOf(el.contentDocument, `${frame} > iframe`, out); } catch { /* чужой домен */ }
      }
    }
    return out;
  }

  function install(map, win = root) {
    if (!win || win.__retkitFunctionMapInstalled) return false;
    win.__retkitFunctionMapInstalled = true;

    // fetch
    const originalFetch = win.fetch;
    if (typeof originalFetch === 'function') {
      win.fetch = function retkitObservedFetch(input, init) {
        const started = Date.now();
        let method = 'GET'; let url = ''; let body = null; let contentType = '';
        try {
          const req = (typeof Request !== 'undefined' && input instanceof Request) ? input : null;
          url = req ? req.url : String(input);
          method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase();
          body = init && 'body' in init ? init.body : null;
          contentType = new Headers((init && init.headers) || (req && req.headers) || {}).get('content-type') || '';
        } catch { /* не мешаем странице */ }
        const promise = originalFetch.apply(this, arguments);
        promise.then((response) => {
          let type = '';
          try { type = response.headers.get('content-type') || ''; } catch { /* */ }
          const finish = (responseShape) => {
            try { map.noteRequest({ via: 'fetch', method, url, request: shapeBody(body, contentType), status: response.status, response: responseShape, ms: Date.now() - started }); } catch { /* */ }
          };
          if (/json/i.test(type)) response.clone().text().then((t) => finish(shapeBody(t, type)), () => finish(null));
          else finish(type ? { type: type.split(';')[0] } : null);
          if (response.status >= 500) root.__RetKitDiagnostics?.breadcrumb?.('moengage.request.failed', { method, route: parseUrl(url)?.route, status: response.status });
        }, (error) => {
          try { map.noteRequest({ via: 'fetch', method, url, request: shapeBody(body, contentType), status: 'network-error', response: null }); } catch { /* */ }
          root.__RetKitDiagnostics?.breadcrumb?.('moengage.request.network', { method, route: parseUrl(url)?.route, error: String(error && error.message || error).slice(0, 120) });
        });
        return promise;
      };
    }

    // XMLHttpRequest
    const XHR = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    if (XHR) {
      const open = XHR.open; const send = XHR.send; const setHeader = XHR.setRequestHeader;
      XHR.open = function (method, url) {
        try { this.__rkMap = { method: String(method || 'GET').toUpperCase(), url: String(url), type: '' }; } catch { /* */ }
        return open.apply(this, arguments);
      };
      XHR.setRequestHeader = function (name, value) {
        try { if (this.__rkMap && /^content-type$/i.test(name)) this.__rkMap.type = String(value); } catch { /* */ }
        return setHeader.apply(this, arguments);
      };
      XHR.send = function (body) {
        const meta = this.__rkMap;
        if (meta) {
          const started = Date.now();
          let request = null;
          try { request = shapeBody(body, meta.type); } catch { /* */ }
          this.addEventListener('loadend', () => {
            try {
              let response = null;
              const type = this.getResponseHeader('content-type') || '';
              if ((this.responseType === '' || this.responseType === 'text') && /json/i.test(type)) response = shapeBody(this.responseText, type);
              else if (this.responseType === 'json') response = { json: shape(this.response) };
              else if (type) response = { type: type.split(';')[0] };
              map.noteRequest({ via: 'xhr', method: meta.method, url: meta.url, request, status: this.status || 'network-error', response, ms: Date.now() - started });
              if (!this.status || this.status >= 500) root.__RetKitDiagnostics?.breadcrumb?.('moengage.request.failed', { method: meta.method, route: parseUrl(meta.url)?.route, status: this.status || 0 });
            } catch { /* */ }
          });
        }
        return send.apply(this, arguments);
      };
    }

    // Нажатия: только подпись кнопки и её место, без содержимого полей.
    win.document?.addEventListener?.('click', (event) => {
      try {
        const el = event.target && event.target.closest
          ? event.target.closest('button, a, [role=button], [role=tab], [role=menuitem], [role=option], [role=switch], input[type=checkbox], input[type=radio], select, label')
          : null;
        if (!el || isOurs(el)) return;
        map.noteAction(labelOf(el), selectorOf(el), { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '' });
      } catch { /* */ }
    }, true);

    // Экраны: после загрузки и каждой смены адреса — какие элементы управления есть.
    let lastRoute = '';
    let snapTimer = null;
    const snap = () => {
      snapTimer = null;
      try {
        const route = routeOf(win.location?.pathname || '');
        map.noteScreen(route, controlsOf(win.document));
      } catch { /* */ }
    };
    const watch = () => {
      const route = routeOf(win.location?.pathname || '');
      if (route !== lastRoute) {
        lastRoute = route;
        if (snapTimer) win.clearTimeout(snapTimer);
        snapTimer = win.setTimeout(snap, 3000);
      }
    };
    watch();
    win.setInterval?.(watch, 2000);
    return true;
  }

  const map = (typeof document !== 'undefined') ? createFunctionMap({}) : null;
  root.__RetKitFunctionMap = {
    createFunctionMap, install, shape, shapeBody, describeString, mergeShape, routeOf, controlsOf,
    summary: () => map?.summary() || { endpoints: 0, controls: 0, screens: 0 },
    export: () => map?.export() || null,
    clear: () => map?.clear(),
    snapshotNow: () => { try { map?.noteScreen(routeOf(root.location?.pathname || ''), controlsOf(root.document)); } catch { /* */ } },
  };
  if (map && /moengage\.com$/i.test(String(root.location?.hostname || ''))) install(map, root);
})(typeof globalThis !== 'undefined' ? globalThis : this);

(function (root) {
  'use strict';

  // Подпись локали как во вкладке MoEngage (Default, en_US, ar_KW).
  const localeLabel = (locale) => {
    try { return root.__RetKitMoEngageBridgeCore?.localeUiLabel?.(locale) || String(locale || ''); }
    catch { return String(locale || ''); }
  };

  const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }


  function decodeHtmlText(value) {
    return String(value || '')
      .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  }

  function normalizeComparableText(value) {
    return decodeHtmlText(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function findSourceIndex(source, needle) {
    if (!source || !needle) return -1;
    const candidates = [
      needle,
      needle.replaceAll('&', '&amp;'),
      needle.replaceAll('&amp;', '&'),
      needle.replaceAll('"', '&quot;'),
      needle.replaceAll("'", '&#39;'),
    ];
    for (const candidate of candidates) {
      const index = source.indexOf(candidate);
      if (index !== -1) return index;
    }
    return -1;
  }

  function findOccurrenceIndex(source, needle, occurrence = 0) {
    if (!source || !needle) return -1;
    const target = Math.max(0, Number(occurrence) || 0);
    const candidates = [
      needle,
      needle.replaceAll('&', '&amp;'),
      needle.replaceAll('&amp;', '&'),
      needle.replaceAll('"', '&quot;'),
      needle.replaceAll("'", '&#39;'),
    ];
    for (const candidate of [...new Set(candidates)]) {
      let from = 0;
      let seen = 0;
      while (from <= source.length) {
        const index = source.indexOf(candidate, from);
        if (index === -1) break;
        if (seen === target) return index;
        seen += 1;
        from = index + Math.max(1, candidate.length);
      }
    }
    return -1;
  }

  function findTextOccurrenceRange(source, value, occurrence = 0) {
    if (!source || value == null) return null;
    const raw = String(value);
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const candidates = [
      trimmed,
      trimmed.replaceAll('&', '&amp;'),
      trimmed.replaceAll('&amp;', '&'),
      trimmed.replaceAll('"', '&quot;'),
      trimmed.replaceAll("'", '&#39;'),
    ];
    const target = Math.max(0, Number(occurrence) || 0);
    for (const candidate of [...new Set(candidates)]) {
      let from = 0;
      let seen = 0;
      while (from <= source.length) {
        const index = source.indexOf(candidate, from);
        if (index === -1) break;
        if (seen === target) return { start: index, end: index + candidate.length };
        seen += 1;
        from = index + Math.max(1, candidate.length);
      }
    }
    return null;
  }

  function findTagOccurrenceStart(source, tagName, occurrence = 0) {
    const tag = String(tagName || '').toLowerCase();
    if (!source || !tag) return -1;
    const re = new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>`, 'gi');
    const target = Math.max(0, Number(occurrence) || 0);
    let seen = 0;
    let match;
    while ((match = re.exec(source))) {
      if (seen === target) return match.index;
      seen += 1;
    }
    return -1;
  }

  function findTextNodeRangeInElement(source, descriptor) {
    if (!source || !descriptor?.pointText) return null;
    const tag = String(descriptor.tag || descriptor.ancestorTag || '').toLowerCase();
    if (!tag) return null;
    const elementOccurrence = Math.max(0, Number(descriptor.tagOccurrence ?? descriptor.ancestorOccurrence ?? 0) || 0);
    const openingStart = findTagOccurrenceStart(source, tag, elementOccurrence);
    if (openingStart === -1) return null;
    const elementRange = findElementRange(source, openingStart, tag);
    if (!elementRange) return null;
    const openingEnd = source.indexOf('>', openingStart);
    const closingStart = VOID_TAGS.has(tag) ? elementRange.end : source.lastIndexOf(`</${tag}`, elementRange.end);
    const contentStart = openingEnd === -1 ? elementRange.start : openingEnd + 1;
    const contentEnd = closingStart >= contentStart ? closingStart : elementRange.end;
    const segment = source.slice(contentStart, contentEnd);
    const directTextSegments = [];
    let depth = 0;
    let cursor = 0;
    const tokenRe = /<\/?[a-zA-Z0-9:-]+\b[^>]*>|[^<]+/g;
    let token;
    while ((token = tokenRe.exec(segment))) {
      const value = token[0];
      if (value.startsWith('<')) {
        const tokenTag = parseTagName(value);
        const closing = /^<\//.test(value);
        const selfClosing = /\/\s*>$/.test(value) || VOID_TAGS.has(tokenTag);
        if (closing) depth = Math.max(0, depth - 1);
        else if (!selfClosing) depth += 1;
      } else if (depth === 0 && value.trim()) {
        directTextSegments.push({ start: token.index, end: token.index + value.length, value });
      }
      cursor = tokenRe.lastIndex;
    }
    const ordinal = Math.max(0, Number(descriptor.pointTextOrdinal ?? descriptor.ancestorTextOrdinal ?? 0) || 0);
    const direct = directTextSegments[ordinal];
    if (direct) {
      const expected = normalizeComparableText(descriptor.pointText);
      const actual = normalizeComparableText(direct.value);
      if (!expected || actual.includes(expected) || expected.includes(actual)) {
        const leading = (direct.value.match(/^\s*/) || [''])[0].length;
        const trailing = (direct.value.match(/\s*$/) || [''])[0].length;
        return {
          start: contentStart + direct.start + leading,
          end: contentStart + direct.end - trailing,
        };
      }
    }

    const raw = String(descriptor.pointText);
    const localIndex = findOccurrenceIndex(segment, raw, 0);
    if (localIndex === -1) return null;
    const actualNeedleIndex = contentStart + localIndex;
    const candidates = [raw, raw.replaceAll('&', '&amp;'), raw.replaceAll('&amp;', '&')];
    const actualNeedle = candidates.find((candidate) => source.startsWith(candidate, actualNeedleIndex)) || raw;
    return { start: actualNeedleIndex, end: actualNeedleIndex + actualNeedle.length };
  }

  function findElementRange(source, openingTagStart, tagName) {
    const tag = String(tagName || '').toLowerCase();
    if (!source || openingTagStart < 0 || !tag) return null;

    const openingEnd = source.indexOf('>', openingTagStart);
    if (openingEnd === -1) return null;
    if (VOID_TAGS.has(tag) || /\/\s*>$/.test(source.slice(openingTagStart, openingEnd + 1))) {
      return { start: openingTagStart, end: openingEnd + 1 };
    }

    const re = new RegExp(`<\\/?${escapeRegExp(tag)}\\b[^>]*>`, 'gi');
    re.lastIndex = openingTagStart;
    let depth = 0;
    let match;
    while ((match = re.exec(source))) {
      const token = match[0];
      const isClosing = /^<\//.test(token);
      const isSelfClosing = /\/\s*>$/.test(token);
      if (isClosing) {
        depth -= 1;
        if (depth === 0) return { start: openingTagStart, end: match.index + token.length };
      } else if (!isSelfClosing) {
        depth += 1;
      }
    }
    return { start: openingTagStart, end: openingEnd + 1 };
  }

  function findElementContentRange(source, openingTagStart, tagName) {
    const range = findElementRange(source, openingTagStart, tagName);
    if (!range) return null;
    const tag = String(tagName || '').toLowerCase();
    if (VOID_TAGS.has(tag)) return range;
    const openingEnd = source.indexOf('>', openingTagStart);
    if (openingEnd === -1) return range;
    const closingStart = source.lastIndexOf(`</${tag}`, range.end);
    if (closingStart === -1 || closingStart < openingEnd) return range;
    return { start: openingEnd + 1, end: closingStart };
  }

  function findEnclosingElementContentRangeAtIndex(source, index, tagName) {
    const tag = String(tagName || '').toLowerCase();
    if (!source || index < 0 || !tag || VOID_TAGS.has(tag)) return null;

    const re = new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>`, 'gi');
    const openings = [];
    let match;
    while ((match = re.exec(source))) {
      if (match.index > index) break;
      openings.push(match.index);
    }

    for (let i = openings.length - 1; i >= 0; i -= 1) {
      const range = findElementContentRange(source, openings[i], tag);
      if (range && index >= range.start && index <= range.end) return range;
    }
    return null;
  }

  function findOpeningTagStart(source, attributeIndex) {
    if (attributeIndex < 0) return -1;
    return source.lastIndexOf('<', attributeIndex);
  }

  function findRangeFromDescriptor(source, descriptor) {
    if (!source || !descriptor) return null;

    // Images are special: clicking an image should jump straight to its src URL.
    if (String(descriptor.tag || '').toUpperCase() === 'IMG' && descriptor.src) {
      const start = findOccurrenceIndex(source, descriptor.src, descriptor.srcOccurrence || 0);
      if (start !== -1) return { kind: 'src', start, end: start + descriptor.src.length };
    }

    // Prefer the exact text-node occurrence from the rendered preview.
    // Browser table repair / MoEngage rendering can change element ordinals,
    // especially after responsive reflow. Text occurrence is therefore more
    // stable than "the Nth <p>/<a> in the DOM".
    const rawPointText = String(descriptor.pointText || '');
    if (rawPointText.trim().length >= 1 && rawPointText.length <= 640) {
      const first = findTextOccurrenceRange(source, rawPointText, 0);
      const second = findTextOccurrenceRange(source, rawPointText, 1);
      const constrained = findTextNodeRangeInElement(source, descriptor);
      const exactPointRange = Number.isInteger(descriptor.pointTextGlobalOccurrence) && descriptor.pointTextGlobalOccurrence >= 0
        ? findTextOccurrenceRange(source, rawPointText, descriptor.pointTextGlobalOccurrence)
        : null;
      const shortPointText = rawPointText.trim().length <= 4;

      // In mixed copy (<p>plain <b>bold</b> plain</p>) a click on the plain
      // paragraph text should select the paragraph content including inline
      // markup. A click inside the <b>/<strong> remains an exact text click.
      // Prefer the clicked element's structural occurrence here: a raw global
      // occurrence can be shifted by the same word/number appearing in CSS.
      const pointParentTag = String(descriptor.pointParentTag || '').toLowerCase();
      if (descriptor.pointParentHasElementChildren === true && pointParentTag === 'p') {
        const pointRange = constrained || exactPointRange || first;
        if (pointRange) {
          const parentRange = findEnclosingElementContentRangeAtIndex(source, pointRange.start, pointParentTag);
          if (parentRange) return { kind: 'mixedParent', ...parentRange };
        }
      }

      // Tiny/repeated visible values such as step numbers "1" and "2" are
      // especially unsafe to resolve as the Nth raw substring in the source.
      // CSS, URLs and attributes may contain the same characters. In that case
      // use the clicked tag occurrence first.
      if (constrained && shortPointText) {
        return { kind: 'pointText', ...constrained };
      }

      if (exactPointRange) return { kind: 'pointText', ...exactPointRange };

      // If the visible text is unique in source, it is safer than tag order.
      if (first && !second) return { kind: 'pointText', ...first };

      if (constrained) return { kind: 'pointText', ...constrained };

      if (first) return { kind: 'pointText', ...first };
    }

    // For visible copy, prefer the text itself over the surrounding tag, href,
    // class or background. This makes preview -> source useful for copy editing.
    const text = String(descriptor.text || '').replace(/\s+/g, ' ').trim();
    if (text.length >= 1 && text.length <= 240) {
      const index = source.indexOf(text);
      if (index !== -1 && source.indexOf(text, index + 1) === -1) {
        return { kind: 'text', start: index, end: index + text.length };
      }
    }

    const direct = [
      ['href', descriptor.href, descriptor.hrefOccurrence || 0],
      ...((descriptor.backgroundUrls || []).map((value, index) => ['background', value, descriptor.backgroundOccurrences?.[index] || 0])),
    ];

    for (const [kind, needle, occurrence] of direct) {
      if (!needle) continue;
      const start = findOccurrenceIndex(source, needle, occurrence);
      if (start !== -1) return { kind, start, end: start + needle.length };
    }

    if (descriptor.id) {
      for (const quote of ['"', "'"]) {
        const needle = `id=${quote}${descriptor.id}${quote}`;
        const attrIndex = source.indexOf(needle);
        if (attrIndex !== -1) {
          const tagStart = findOpeningTagStart(source, attrIndex);
          const tag = descriptor.tag?.toLowerCase();
          const range = tagStart !== -1 && tag ? findElementRange(source, tagStart, tag) : null;
          if (range) return { kind: 'id', ...range };
          return { kind: 'id', start: attrIndex, end: attrIndex + needle.length };
        }
      }
    }

    const tag = descriptor.tag?.toLowerCase();
    if (tag && Array.isArray(descriptor.classes) && descriptor.classes.length) {
      for (const cls of descriptor.classes) {
        const escaped = escapeRegExp(cls);
        const re = new RegExp(`<${escapeRegExp(tag)}\\b[^>]*class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>`, 'gi');
        const matches = [...source.matchAll(re)];
        if (matches.length === 1) {
          const range = findElementContentRange(source, matches[0].index, tag);
          return range ? { kind: 'class', ...range } : {
            kind: 'class', start: matches[0].index, end: matches[0].index + matches[0][0].length,
          };
        }
      }
    }

    return null;
  }

  function writeNativeEditorValue(editor, next) {
    if (!editor || typeof editor.getValue !== 'function') return false;
    const current = editor.getValue();
    if (current === next) return false;

    const apply = () => {
      if (typeof editor.replaceRange === 'function' && typeof editor.lastLine === 'function' && typeof editor.getLine === 'function') {
        const firstLine = typeof editor.firstLine === 'function' ? editor.firstLine() : 0;
        const lastLine = editor.lastLine();
        const lastText = editor.getLine(lastLine) || '';
        editor.replaceRange(
          next,
          { line: firstLine, ch: 0 },
          { line: lastLine, ch: lastText.length },
          '+input',
        );
      } else if (typeof editor.setValue === 'function') {
        editor.setValue(next);
      } else {
        return false;
      }
      return true;
    };

    if (typeof editor.operation === 'function') {
      let changed = false;
      editor.operation(() => { changed = apply(); });
      return changed;
    }
    return apply();
  }

  function shouldAcceptRenderedPreview(state, renderedHtml, now = Date.now()) {
    if (!state?.awaiting) return true;
    if (now < Number(state.localPreviewUntil || 0)) return false;
    return Boolean(renderedHtml && renderedHtml !== state.renderedBeforeEdit);
  }

  function getPreviewDocumentHeight(doc) {
    if (!doc) return 0;
    const html = doc.documentElement || {};
    const body = doc.body || {};
    return Math.max(
      Number(html.scrollHeight) || 0,
      Number(html.offsetHeight) || 0,
      Number(html.clientHeight) || 0,
      Number(body.scrollHeight) || 0,
      Number(body.offsetHeight) || 0,
      Number(body.clientHeight) || 0,
    );
  }

  const STRUCTURAL_TAGS = new Set([
    'html', 'head', 'body', 'center', 'table', 'thead', 'tbody', 'tfoot',
    'tr', 'td', 'th', 'div', 'section', 'header', 'footer', 'main', 'article',
  ]);

  function parseTagName(token) {
    const match = String(token || '').match(/^<\/?\s*([a-zA-Z0-9:-]+)/);
    return match ? match[1].toLowerCase() : '';
  }

  function beautifyEmailHtml(source, indent = '  ') {
    const input = String(source || '');
    if (!input.trim()) return input;

    const opaque = [];
    const protectedSource = input.replace(
      /<(style|script|pre|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--\[if[\s\S]*?<!\[endif\]-->/gi,
      (block) => {
        const key = `__RETKIT_OPAQUE_${opaque.length}__`;
        opaque.push(block);
        return key;
      },
    );

    const tokens = protectedSource.match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || [protectedSource];
    const lines = [];
    let depth = 0;
    let current = '';

    const flush = () => {
      if (!current) return;
      const value = current.replace(/^\s+|\s+$/g, '');
      if (value) lines.push(`${indent.repeat(Math.max(0, depth))}${value}`);
      current = '';
    };

    for (const token of tokens) {
      if (!token) continue;
      if (/^__RETKIT_OPAQUE_\d+__$/.test(token.trim())) {
        flush();
        lines.push(`${indent.repeat(Math.max(0, depth))}${token.trim()}`);
        continue;
      }

      if (!token.startsWith('<')) {
        current += token;
        continue;
      }

      if (/^<!--/.test(token) || /^<!DOCTYPE/i.test(token) || /^<\?/.test(token) || /^<!\[/.test(token)) {
        flush();
        lines.push(`${indent.repeat(Math.max(0, depth))}${token.trim()}`);
        continue;
      }

      const tag = parseTagName(token);
      const closing = /^<\//.test(token);
      const selfClosing = /\/\s*>$/.test(token) || VOID_TAGS.has(tag);
      const structural = STRUCTURAL_TAGS.has(tag);

      if (!structural) {
        current += token;
        continue;
      }

      if (closing) {
        flush();
        depth = Math.max(0, depth - 1);
        lines.push(`${indent.repeat(depth)}${token.trim()}`);
      } else {
        flush();
        lines.push(`${indent.repeat(depth)}${token.trim()}`);
        if (!selfClosing) depth += 1;
      }
    }
    flush();

    let output = lines.join('\n');
    output = output.replace(/__RETKIT_OPAQUE_(\d+)__/g, (_, index) => opaque[Number(index)] || '');
    return output;
  }

  // ---------------------------------------------------------------------------
  // Source-whitespace preservation.
  //
  // RetKit edits a beautified working copy (see beautifyEmailHtml), but MoEngage
  // must receive the author's original formatting. Beautify only changes
  // whitespace between tokens, so the token sequence of the original HTML and of
  // the working copy is the same except where the user actually edited. We keep
  // the original whitespace for the unchanged prefix/suffix and take the edited
  // middle verbatim from the working copy. That keeps email size stable and
  // never adds whitespace between inline-block columns the user did not touch.
  // ---------------------------------------------------------------------------
  function tokenizeHtmlForWhitespace(source) {
    const text = String(source ?? '');
    const tokens = [];
    const gaps = [];
    const re = /<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g;
    let pendingGap = '';
    let match;
    while ((match = re.exec(text))) {
      const piece = match[0];
      if (piece[0] === '<') {
        gaps.push(pendingGap);
        tokens.push(piece);
        pendingGap = '';
        continue;
      }
      const words = piece.split(/(\s+)/);
      for (const part of words) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { pendingGap += part; continue; }
        gaps.push(pendingGap);
        tokens.push(part);
        pendingGap = '';
      }
    }
    return { tokens, gaps, tail: pendingGap };
  }

  function isStructuralToken(token) {
    if (!token || token[0] !== '<') return false;
    return STRUCTURAL_TAGS.has(parseTagName(token));
  }

  // A gap is "layout-neutral" when it touches a structural tag: beautify adds or
  // removes whitespace there, so only its presence between inline content counts.
  function gapKey(tokens, gaps, index) {
    const gap = gaps[index] || '';
    if (isStructuralToken(tokens[index]) || isStructuralToken(tokens[index - 1])) return '';
    return gap ? ' ' : '';
  }

  function preserveSourceWhitespace(originalHtml, editedHtml) {
    const original = String(originalHtml ?? '');
    const edited = String(editedHtml ?? '');
    if (!original || !edited || original === edited) return edited;
    const a = tokenizeHtmlForWhitespace(original);
    const b = tokenizeHtmlForWhitespace(edited);
    if (!a.tokens.length || !b.tokens.length) return edited;

    const same = (i, j) => a.tokens[i] === b.tokens[j] && gapKey(a.tokens, a.gaps, i) === gapKey(b.tokens, b.gaps, j);
    const maxPrefix = Math.min(a.tokens.length, b.tokens.length);
    let prefix = 0;
    while (prefix < maxPrefix && same(prefix, prefix)) prefix += 1;
    let suffix = 0;
    while (
      suffix < maxPrefix - prefix
      && same(a.tokens.length - 1 - suffix, b.tokens.length - 1 - suffix)
    ) suffix += 1;

    // Nothing in common: a full rewrite. Send the working copy as-is.
    if (prefix === 0 && suffix === 0) return edited;

    let out = '';
    for (let i = 0; i < prefix; i += 1) out += a.gaps[i] + a.tokens[i];
    const bMiddleEnd = b.tokens.length - suffix;
    const aSuffixStart = a.tokens.length - suffix;
    // At the two edges of the edit, a layout-neutral gap (next to a structural
    // tag) keeps the original whitespace; an inline gap follows the edit.
    const edgeGap = (j, i) => {
      const neutral = isStructuralToken(b.tokens[j]) || isStructuralToken(b.tokens[j - 1]);
      return neutral && i <= a.tokens.length ? (a.gaps[i] ?? b.gaps[j]) : b.gaps[j];
    };
    for (let j = prefix; j < bMiddleEnd; j += 1) {
      out += (j === prefix ? edgeGap(j, prefix) : b.gaps[j]) + b.tokens[j];
    }
    for (let i = aSuffixStart; i < a.tokens.length; i += 1) {
      const isFirstSuffix = i === aSuffixStart;
      const touchedEdit = isFirstSuffix && (bMiddleEnd > prefix || aSuffixStart > prefix);
      out += (touchedEdit ? edgeGap(bMiddleEnd, i) : a.gaps[i]) + a.tokens[i];
    }
    const untouchedEnd = suffix > 0 || (prefix === a.tokens.length && prefix === b.tokens.length);
    out += untouchedEnd ? a.tail : b.tail;
    return out;
  }

  function htmlEquivalentForSync(left, right) {
    const a = String(left ?? '');
    const b = String(right ?? '');
    if (a === b) return true;
    // RetKit edits a beautified working copy while Froala/React can persist the
    // same email with different structural whitespace. Re-beautify both sides
    // with the same deterministic formatter before deciding that MoEngage
    // reverted content. Inline text and opaque style/script/pre blocks are kept.
    return beautifyEmailHtml(a).replace(/\r\n?/g, '\n').trim() === beautifyEmailHtml(b).replace(/\r\n?/g, '\n').trim();
  }

  function shouldBlockEmptyNativeCommit({ localHtml = '', nativeHtml = '' } = {}) {
    const local = String(localHtml ?? '').trim();
    const native = String(nativeHtml ?? '').trim();
    return !local && Boolean(native);
  }

  function shouldSkipNativeCommit({ localHtml = '', nativeHtml = '' } = {}) {
    // Dirty only means the overlay changed since the last bookkeeping update.
    // Cmd/Ctrl+Z can restore the exact native content while dirty stays true.
    // Never wake Froala/React for a semantic no-op: unnecessary commits are a
    // major source of controlled-editor reverts in MoEngage.
    return htmlEquivalentForSync(localHtml, nativeHtml);
  }

  function findAllLiteral(source, query) {
    const input = String(source || '');
    const needle = String(query || '');
    if (!needle) return [];
    const result = [];
    let offset = 0;
    while (offset <= input.length) {
      const index = input.indexOf(needle, offset);
      if (index === -1) break;
      result.push(index);
      offset = index + Math.max(1, needle.length);
    }
    return result;
  }

  function replaceAllLiteral(source, query, replacement) {
    const input = String(source || '');
    const needle = String(query || '');
    if (!needle) return { value: input, count: 0 };
    const count = findAllLiteral(input, needle).length;
    return { value: input.split(needle).join(String(replacement ?? '')), count };
  }

  function buildLocaleReplacePlan(htmlByLocale, query, replacement, locales = []) {
    const sourceMap = htmlByLocale && typeof htmlByLocale === 'object' ? htmlByLocale : {};
    const wanted = Array.isArray(locales) && locales.length ? locales : Object.keys(sourceMap);
    const seen = new Set();
    const plan = [];
    for (const rawLocale of wanted) {
      const locale = String(rawLocale || '').trim().toUpperCase();
      if (!locale || seen.has(locale)) continue;
      seen.add(locale);
      const before = String(sourceMap[rawLocale] ?? sourceMap[locale] ?? '');
      const result = replaceAllLiteral(before, query, replacement);
      plan.push({ locale, count: result.count, changed: result.count > 0, before, after: result.value });
    }
    return plan;
  }

  function summarizeLocaleReplacePlan(plan = []) {
    const items = Array.isArray(plan) ? plan : [];
    const changed = items.filter((item) => Number(item?.count || 0) > 0);
    return {
      localeCount: items.length,
      matchedLocales: changed.length,
      totalMatches: changed.reduce((sum, item) => sum + Number(item.count || 0), 0),
      changedLocales: changed.map((item) => String(item.locale || '')),
    };
  }



  function validateEmailHtml(source) {
    const input = String(source || '');
    if (!input) return [];
    const issues = [];
    const lineFor = (index) => input.slice(0, Math.max(0, index)).split('\n').length;
    const add = (severity, code, message, index) => issues.push({ severity, code, message, index, line: lineFor(index) });

    // Mask regions that may contain tag-looking text while preserving string
    // offsets so issue indices still point to the original HTML.
    const chars = [...input];
    const maskRange = (start, end) => {
      for (let i = start; i < end; i += 1) if (chars[i] !== '\n') chars[i] = ' ';
    };
    const protectedRe = /<!--\[if[\s\S]*?<!\[endif\]-->|<!--[\s\S]*?-->|<(style|script|pre|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
    let protectedMatch;
    while ((protectedMatch = protectedRe.exec(input))) maskRange(protectedMatch.index, protectedRe.lastIndex);
    const scan = chars.join('');

    // Catch lexically incomplete tags before the structural tag regex runs.
    // Browsers auto-repair these aggressively, which used to hide typos such
    // as `<td` or `<img src="...>` from RetKit's validator.
    for (let start = 0; start < scan.length; start += 1) {
      if (scan[start] !== '<' || !/^<\/?\s*[a-zA-Z][\w:-]*/.test(scan.slice(start))) continue;
      let quote = '';
      let ended = false;
      for (let cursor = start + 1; cursor < scan.length; cursor += 1) {
        const char = scan[cursor];
        if (quote) {
          if (char === quote) quote = '';
          continue;
        }
        if (char === '"' || char === "'") {
          quote = char;
          continue;
        }
        if (char === '>') {
          ended = true;
          start = cursor;
          break;
        }
        if (char === '<') break;
      }
      if (!ended) {
        if (quote) add('error', 'unclosed-attribute-quote', 'Unclosed quote in HTML attribute', start);
        else add('error', 'incomplete-tag', 'Incomplete HTML tag (missing >)', start);
        break;
      }
    }

    const stack = [];
    const tagRe = /<\/?\s*([a-zA-Z][\w:-]*)\b[^>]*>/g;
    let match;
    while ((match = tagRe.exec(scan))) {
      const raw = input.slice(match.index, match.index + match[0].length);
      const tag = match[1].toLowerCase();
      const closing = /^<\//.test(raw);
      const selfClosing = /\/\s*>$/.test(raw) || VOID_TAGS.has(tag);

      if (!closing) {
        if (tag === 'a') {
          if (stack.some((entry) => entry.tag === 'a')) add('error', 'nested-anchor', 'Nested <a> tag', match.index);
          const hrefMatch = raw.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
          if (!hrefMatch || !hrefMatch[2].trim() || hrefMatch[2].trim() === '#') {
            add('warning', 'href-placeholder', '<a> has an empty or placeholder href', match.index);
          }
        }
        if (tag === 'img') {
          const srcMatch = raw.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
          const altMatch = raw.match(/\balt\s*=\s*(["'])(.*?)\1/i);
          if (!srcMatch || !srcMatch[2].trim()) add('warning', 'img-src', '<img> is missing src', match.index);
          if (!altMatch) add('warning', 'img-alt', '<img> is missing alt', match.index);
        }
        if (!selfClosing) stack.push({ tag, index: match.index });
        continue;
      }

      const matchIndex = stack.map((entry) => entry.tag).lastIndexOf(tag);
      if (matchIndex === -1) {
        add('error', 'unexpected-close', `Unexpected </${tag}>`, match.index);
        continue;
      }
      for (let i = stack.length - 1; i > matchIndex; i -= 1) {
        const dangling = stack[i];
        add('error', 'unclosed-tag', `Unclosed <${dangling.tag}>`, dangling.index);
      }
      stack.splice(matchIndex);
    }

    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const dangling = stack[i];
      add('error', 'unclosed-tag', `Unclosed <${dangling.tag}>`, dangling.index);
    }

    return issues.sort((a, b) => a.index - b.index || (a.severity === 'error' ? -1 : 1));
  }

  function hasBlockingPreviewSyntaxIssue(source) {
    return validateEmailHtml(source).some((issue) => issue.code === 'incomplete-tag' || issue.code === 'unclosed-attribute-quote');
  }

  function findFoldRangeForLine(source, lineStart, lineEnd) {
    const input = String(source || '');
    const start = Math.max(0, Number(lineStart) || 0);
    const end = Math.max(start, Number(lineEnd) || start);
    const line = input.slice(start, end);
    const re = /<([a-zA-Z][\w:-]*)\b[^>]*>/g;
    let match;
    while ((match = re.exec(line))) {
      const token = match[0];
      const tag = match[1].toLowerCase();
      if (VOID_TAGS.has(tag) || /\/\s*>$/.test(token)) continue;
      const openingStart = start + match.index;
      const range = findElementRange(input, openingStart, tag);
      if (!range) continue;
      const openingEnd = input.indexOf('>', openingStart);
      const closingStart = input.lastIndexOf(`</${tag}`, range.end);
      if (openingEnd === -1 || closingStart === -1 || closingStart <= end) continue;
      return {
        tag,
        openStart: openingStart,
        openEnd: openingEnd + 1,
        closeStart: closingStart,
        closeEnd: range.end,
      };
    }
    return null;
  }


  function refreshEditorLayout(editor) {
    if (!editor) return false;
    try { editor.refresh?.(); } catch {}
    try {
      const from = editor.getCursor?.('from');
      const to = editor.getCursor?.('to');
      if (from && to) editor.scrollIntoView?.({ from, to }, 160);
    } catch {}
    return true;
  }

  function isAllowedHost(hostname) {
    return hostname === 'dashboard-02.moengage.com';
  }

  function launcherLifecycleAction(state = {}) {
    if (state.hasNative && !state.hasLauncher) return 'show';
    if (!state.hasNative && state.hasLauncher) return 'remove';
    if (!state.hasNative && state.hasWorkspace && state.routeChanged) return 'close-workspace';
    return 'keep';
  }

  function nextEditRevision(current) {
    const value = Number(current);
    return (Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0) + 1;
  }

  function idleSyncDelay() {
    return 1400;
  }

  function shouldApplyNativeResult(state = {}) {
    return Number(state.startedRevision) === Number(state.currentRevision);
  }

  function shouldPullNativeIntoOverlay(state = {}) {
    if (state.focused || state.applying || state.composing || state.dirty || state.multiLocaleBusy) return false;
    return true;
  }

  function previewReadinessAction(state = {}) {
    if (!state.native) return { open: false, mode: 'missing-editor' };
    if (!state.rendered) return { open: true, mode: 'local-fallback' };
    return { open: true, mode: 'native-preview' };
  }

  function shouldTreatNativeMismatchAsLateRevert(state = {}) {
    if (state.sameContent) return false;
    if (Number(state.lastAppliedRevision) !== Number(state.currentRevision)) return false;
    const appliedAt = Number(state.lastAppliedAt) || 0;
    const now = Number(state.now) || 0;
    const graceMs = Math.max(0, Number(state.graceMs) || 5000);
    return appliedAt > 0 && now >= appliedAt && (now - appliedAt) <= graceMs;
  }

  let runtimeState = null;

  const core = {
    findSourceIndex,
    findOccurrenceIndex,
    findTextOccurrenceRange,
    findElementRange,
    findTextNodeRangeInElement,
    findElementContentRange,
    findEnclosingElementContentRangeAtIndex,
    findRangeFromDescriptor,
    writeNativeEditorValue,
    shouldAcceptRenderedPreview,
    getPreviewDocumentHeight,
    beautifyEmailHtml,
    htmlEquivalentForSync,
    preserveSourceWhitespace,
    tokenizeHtmlForWhitespace,
    shouldSkipNativeCommit,
    shouldBlockEmptyNativeCommit,
    findAllLiteral,
    replaceAllLiteral,
    buildLocaleReplacePlan,
    summarizeLocaleReplacePlan,
    validateEmailHtml,
    hasBlockingPreviewSyntaxIssue,
    findFoldRangeForLine,
    refreshEditorLayout,
    isAllowedHost,
    launcherLifecycleAction,
    nextEditRevision,
    idleSyncDelay,
    shouldApplyNativeResult,
    shouldPullNativeIntoOverlay,
    previewReadinessAction,
    shouldTreatNativeMismatchAsLateRevert,
    rebindNativeEditorFromMoEngage,
    commitNativeHtml: (html, options = {}) => commitThroughFroala(String(html ?? ''), options),
    isMultiLocaleBusy: () => Boolean(runtimeState?.multiLocaleBusy),
  };

  root.__RetKitMoEngageCore = core;

  if (typeof document === 'undefined' || !root.location || !isAllowedHost(root.location.hostname)) {
    return;
  }

  const IDS = {
    launcher: 'retkit-mo-launcher',
    workspace: 'retkit-mo-workspace',
    style: 'retkit-mo-style',
    sourceHost: 'retkit-mo-source-host',
    previewFrame: 'retkit-mo-preview-frame',
    findBar: 'retkit-mo-findbar',
    findInput: 'retkit-mo-find-input',
    replaceInput: 'retkit-mo-replace-input',
    multiLocaleModeToggle: 'retkit-mo-multilocale-mode',
    multiLocaleDetails: 'retkit-mo-multilocale-details',
    matchCount: 'retkit-mo-match-count',
    status: 'retkit-mo-status',
    split: 'retkit-mo-split',
    editorPane: 'retkit-mo-editor-pane',
    previewPane: 'retkit-mo-preview-pane',
    previewCanvas: 'retkit-mo-preview-canvas',
    validatorPopover: 'retkit-mo-validator-popover',
    validatorButton: 'retkit-mo-validator-button',
    validatorInline: 'retkit-mo-validator-inline',
    multiLocaleDrawer: 'retkit-mo-multilocale-drawer',
    multiLocaleLoading: 'retkit-mo-multilocale-loading',
    multiLocaleRows: 'retkit-mo-multilocale-rows',
    localeManagerRows: 'retkit-mo-locale-manager-rows',
    localeStrip: 'retkit-mo-locale-strip',
  };

  const STATE = {
    wrap: localStorage.getItem('retkit-mo-wrap') !== 'false',
    previewMode: localStorage.getItem('retkit-mo-preview-mode') || 'desktop',
    splitPercent: Number(localStorage.getItem('retkit-mo-split') || 50),
    syncPaused: false,
    syncingToNative: false,
    syncingFromNative: false,
    previewHtml: '',
    previewElement: null,
    previewTimer: null,
    previewPendingHtml: '',
    previewLastValidHtml: '',
    awaitingRenderedUpdate: false,
    renderedBeforeEdit: '',
    localPreviewUntil: 0,
    nativeChangeHandler: null,
    launcherTimer: null,
    launcherRoute: '',
    pollTimer: null,
    syncTimer: null,
    foldTimer: null,
    validatorTimer: null,
    validatorIssues: [],
    validatorMarks: [],
    multiLocaleAutoScanTimer: null,
    multiLocaleRescanPending: false,
    layoutRefreshTimer: null,
    overlayEditor: null,
    nativeEditor: null,
    dirty: false,
    applying: false,
    pendingApply: false,
    editRevision: 0,
    lastAppliedRevision: 0,
    lastAppliedAt: 0,
    composing: false,
    overlayFocused: false,
    searchMarks: [],
    foldMarks: new Map(),
    multiLocalePlan: [],
    multiLocaleDetailsLocale: '',
    // Per-locale replacement overrides for the current query: { LOCALE: value }.
    multiLocaleOverrides: {},
    multiLocaleOverridesQuery: '',
    multiLocaleBusy: false,
    multiLocaleCancelRequested: false,
    multiLocaleScanError: '',
  };
  runtimeState = STATE;

  function diagBreadcrumb(type, meta = {}) {
    try { root.__RetKitDiagnostics?.breadcrumb?.(type, meta); } catch {}
  }

  function diagIncident(type, message, meta = {}) {
    try { root.__RetKitDiagnostics?.incident?.(type, message, meta); } catch {}
  }

  function getNativeEditor() {
    const workspace = document.getElementById(IDS.workspace);
    const froala = document.querySelector('.fr-box');
    if (!froala) return null;
    for (const node of froala.querySelectorAll('.CodeMirror')) {
      if (workspace?.contains(node)) continue;
      if (node?.CodeMirror) return node.CodeMirror;
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getFroalaBox() {
    return document.querySelector('.fr-box');
  }

  function getCodeViewButton() {
    return getFroalaBox()?.querySelector('[data-cmd="html"]') || null;
  }

  function isCodeViewActive(button = getCodeViewButton()) {
    if (!button) return false;
    return button.getAttribute('aria-pressed') === 'true' || button.classList.contains('fr-active');
  }

  function dispatchEditorInput(target) {
    if (!target?.dispatchEvent) return;
    try {
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
    } catch {
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try { target.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
    try { target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' })); } catch {}
  }

  function getFroalaVisualTarget() {
    const box = getFroalaBox();
    if (!box) return null;
    const iframe = box.querySelector('iframe.fr-iframe');
    try {
      if (iframe?.contentDocument?.body) return iframe.contentDocument.body;
    } catch {}
    return box.querySelector('.fr-element') || box.querySelector('.fr-wrapper');
  }

  async function commitThroughFroala(next, options = {}) {
    const fast = options.fast === true;
    let native = getNativeEditor() || STATE.nativeEditor;
    const button = getCodeViewButton();
    if (!native || !button) return { ok: false, reason: 'Froala Code View button not found' };

    // We intentionally use the same path a human edit takes: update CodeMirror,
    // wake its textarea, leave Code View, fire a visual-editor input, then return.
    // Keep the author's original formatting outside the edited region so
    // MoEngage never receives a re-indented copy of the whole email.
    const nativeBefore = native.getValue?.() || '';
    // First write for this campaign+locale: keep the untouched version so the
    // user can return to it (see src/backup/original-snapshots.js).
    try { root.__RetKitOriginals?.captureBeforeCommit?.(nativeBefore, { locale: options.locale }); } catch {}
    const exactOriginal = root.__RetKitOriginals?.takeExactRestore?.(next, htmlEquivalentForSync);
    next = exactOriginal ?? preserveSourceWhitespace(nativeBefore, next);
    native.focus?.();
    writeNativeEditorValue(native, next);
    native.save?.();
    native.refresh?.();
    dispatchEditorInput(native.getInputField?.() || document.querySelector('.CodeMirror textarea'));

    try {
      if (isCodeViewActive(button)) {
        button.click();
        await sleep(fast ? 120 : 260);
      }

      const visualTarget = getFroalaVisualTarget();
      if (visualTarget) {
        visualTarget.focus?.();
        dispatchEditorInput(visualTarget);
        await sleep(fast ? 50 : 90);
        visualTarget.blur?.();
      }
      dispatchEditorInput(getFroalaBox());
      await sleep(fast ? 80 : 160);

      if (!isCodeViewActive(button)) {
        button.click();
        await sleep(fast ? 180 : 360);
      }
    } catch (error) {
      return { ok: false, reason: error?.message || String(error) };
    }

    native = getNativeEditor() || native;
    STATE.nativeEditor = native;
    native.refresh?.();
    dispatchEditorInput(native.getInputField?.() || document.querySelector('.CodeMirror textarea'));

    // A controlled React editor may briefly accept the HTML and then restore its
    // previous state. Verify after the render cycle instead of immediately.
    await sleep(fast ? 260 : 700);
    const keptOnce = htmlEquivalentForSync((getNativeEditor() || native).getValue?.(), next);
    if (fast) return { ok: Boolean(keptOnce), tentative: true, reason: keptOnce ? '' : 'MoEngage did not keep the native HTML' };
    await sleep(500);
    const keptTwice = htmlEquivalentForSync((getNativeEditor() || native).getValue?.(), next);
    const ok = Boolean(keptOnce && keptTwice);
    return { ok, reason: ok ? '' : 'MoEngage reverted the HTML after Froala accepted it' };
  }

  function getSourcePreviewFrame() {
    return document.querySelector('#sidePreview');
  }

  function getRenderedPreviewHtml() {
    return getSourcePreviewFrame()?.getAttribute('srcdoc') || '';
  }

  function status(message, tone = 'neutral') {
    const el = document.getElementById(IDS.status);
    if (!el) return;
    el.textContent = message;
    el.dataset.tone = tone;
  }

  function injectStyle() {
    if (document.getElementById(IDS.style)) return;
    const style = document.createElement('style');
    style.id = IDS.style;
    style.textContent = `
      #${IDS.launcher} {
        position: fixed; right: 18px; bottom: 80px; width: 48px; height: 48px;
        border: 0; border-radius: 14px; z-index: 2147483000; cursor: pointer;
        background: linear-gradient(145deg,#5682ff,#315be9); color:#fff; font:700 14px/1 Arial,sans-serif;
        box-shadow:0 10px 28px rgba(32,70,190,.35); transition:.16s ease;
      }
      #${IDS.launcher}:hover { transform: translateY(-2px); box-shadow:0 13px 32px rgba(32,70,190,.42); }
      #${IDS.workspace} {
        position: fixed; inset: 0; z-index: 2147483640; background:#0d1118; color:#e7edf6;
        display:flex; flex-direction:column; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${IDS.workspace} * { box-sizing:border-box; }
      .rk-topbar { height:52px; flex:0 0 52px; display:flex; align-items:center; gap:8px; padding:0 12px;
        background:#111823; border-bottom:1px solid #263140; }
      .rk-brand { display:flex; align-items:center; gap:8px; margin-right:8px; font-weight:750; }
      .rk-mark { width:27px; height:27px; display:grid; place-items:center; border-radius:8px; background:#3768ff; font-size:12px; }
      .rk-btn { border:1px solid #334155; background:#172130; color:#dce6f4; border-radius:8px; padding:6px 10px;
        font:600 12px/1.2 inherit; cursor:pointer; }
      .rk-btn:hover { background:#1e2b3d; }
      .rk-btn.rk-active { background:#284fbe; border-color:#4c75e7; color:#fff; }
      .rk-spacer { flex:1; }
      #${IDS.status} { font-size:12px; color:#93a4b8; max-width:360px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
      #${IDS.status}[data-tone="ok"] { color:#72d6a0; }
      #${IDS.status}[data-tone="warn"] { color:#f4be63; }
      #${IDS.status}[data-tone="error"] { color:#ff7e86; }
      #${IDS.findBar} { display:none; min-height:42px; flex:0 0 auto; align-items:center; gap:6px; padding:6px 8px;
        background:#101721; border-bottom:1px solid #263140; }
      #${IDS.findBar}.rk-open { display:flex; }
      .rk-find-input { min-width:110px; flex:1; height:29px; border-radius:7px; border:1px solid #334155; background:#0b111a; color:#e9eef7;
        outline:none; padding:0 8px; font:12px inherit; }
      .rk-find-input:focus { border-color:#5f83ff; box-shadow:0 0 0 2px rgba(72,111,255,.14); }
      .rk-find-mini { border:1px solid #334155; background:#172130; color:#dce6f4; border-radius:7px; height:29px; padding:0 8px;
        font:600 11px/1 inherit; cursor:pointer; }
      .rk-find-mini:hover { background:#1e2b3d; }
      #${IDS.matchCount} { min-width:48px; text-align:center; color:#8fa2b8; font-size:11px; }
      #${IDS.multiLocaleDrawer} { flex:0 0 auto; width:100%; max-height:min(310px,42vh); overflow:auto; box-sizing:border-box;
        background:#111823; border-bottom:1px solid #334155; padding:9px 10px; }
      #${IDS.multiLocaleLoading} { display:block; margin:8px 0 4px; color:#9fb0c5; }
      #${IDS.multiLocaleLoading} .rk-ml-loading-card { display:block; min-height:34px; padding:7px 9px 8px;
        border:1px solid #29384a; border-radius:9px; background:#0d151f; font:600 11px/1.25 inherit; }
      .rk-ml-progress-row { display:flex; align-items:center; gap:8px; min-width:0; }
      #${IDS.multiLocaleLoading} .rk-ml-spinner { width:11px; height:11px; flex:0 0 11px; border:1.5px solid #34455b; border-top-color:#7794e8; border-radius:50%; animation:rkMlSpin .9s linear infinite; }
      .rk-ml-progress-text { min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .rk-ml-progress-hint { margin-left:auto; color:#71839a; font-weight:500; white-space:nowrap; }
      .rk-ml-progress-track { height:3px; margin-top:7px; overflow:hidden; border-radius:999px; background:#1c2837; }
      .rk-ml-progress-bar { height:100%; width:0; border-radius:inherit; background:#4f7cff; transition:width .18s ease; }
      @keyframes rkMlSpin { to { transform:rotate(360deg); } }
      .rk-ml-head { display:flex; align-items:center; gap:8px; padding-bottom:8px; border-bottom:1px solid #263140; }
      .rk-ml-head strong { flex:1; font-size:13px; }
      .rk-ml-note { color:#8fa2b8; font-size:11px; line-height:1.45; padding:8px 2px; }
      .rk-ml-actions { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0; align-items:center; }
      .rk-ml-own { display:grid; grid-template-columns:auto 1fr; gap:8px; align-items:center; margin-bottom:4px; }
      .rk-ml-own .rk-find-input { min-width:0; }
      .rk-ml-mode { display:inline-flex; align-items:center; gap:4px; cursor:pointer; }
      #retkit-mo-multilocale-details { display:grid; gap:3px; margin-top:6px; }
      .rk-ml-hit { display:grid; grid-template-columns:auto 1fr; gap:8px; align-items:baseline; font-size:11.5px; }
      .rk-ml-kind { color:#8fa3bd; white-space:nowrap; }
      .rk-ml-hit code { color:#c9d6e6; white-space:pre-wrap; word-break:break-all; font:11px ui-monospace,Menlo,monospace; }
      .rk-ml-hit mark { background:#5a4a12; color:#ffe9a6; border-radius:2px; }
      #${IDS.multiLocaleRows} { display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:6px 0; }
      .rk-ml-row { display:inline-flex; gap:5px; align-items:center; min-height:30px; padding:4px 8px; border:1px solid #2b394b; border-radius:8px; background:#131d2a; font-size:12px; }
      .rk-ml-row[data-disabled="1"] { opacity:.46; }
      .rk-ml-row[data-state="ok"] { color:#91ddb0; }
      .rk-ml-row[data-state="error"] { color:#ff9097; }
      .rk-ml-row small { color:#7f91a7; }
      .rk-ml-section { margin-top:12px; padding-top:10px; border-top:1px solid #263140; }
      .rk-ml-section-title { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; margin-bottom:6px; }
      .rk-ml-section-title span { flex:1; }
      .rk-ml-locale-chip { display:inline-flex; align-items:center; gap:4px; margin:3px; padding:4px 6px; border:1px solid #334155; border-radius:7px; background:#172130; font-size:11px; }
      .rk-ml-remove { border:0; background:transparent; color:#ff8d95; cursor:pointer; padding:0 2px; font-size:13px; }
      .rk-search-hit { background:rgba(255,203,79,.22); }
      .rk-search-hit-current { background:rgba(79,124,255,.42); }
      #${IDS.split} { flex:1; min-height:0; display:grid; grid-template-columns:minmax(280px,var(--rk-left,50%)) 6px minmax(320px,1fr); }
      #${IDS.editorPane} { min-width:0; min-height:0; display:flex; flex-direction:column; background:#0c1118; }
      #${IDS.previewPane} { min-width:0; min-height:0; display:flex; flex-direction:column; background:#151b24; }
      .rk-pane-head { height:37px; flex:0 0 37px; display:flex; align-items:center; gap:7px; padding:0 10px; border-bottom:1px solid #263140;
        background:#111822; color:#aebdce; font-size:12px; }
      .rk-pane-head strong { color:#e4ecf6; }
      .rk-pane-head .rk-pane-spacer { flex:1; }
      .rk-icon-btn { width:30px; height:28px; padding:0; display:grid; place-items:center; border:1px solid #334155;
        background:#172130; color:#cbd7e6; border-radius:7px; cursor:pointer; }
      .rk-icon-btn:hover { background:#1e2b3d; }
      .rk-icon-btn.rk-active { background:#284fbe; border-color:#4c75e7; color:#fff; }
      .rk-icon-btn svg { width:17px; height:17px; display:block; fill:none; stroke:currentColor; stroke-width:1.8; }
      .rk-grip { background:#202a37; cursor:col-resize; position:relative; }
      .rk-grip:hover { background:#4368d8; }
      #${IDS.sourceHost} { flex:1; min-height:0; position:relative; overflow:hidden; }
      #${IDS.sourceHost} .CodeMirror { height:100% !important; width:100%; background:#0b1017; color:#dce5ef; font-size:13px; line-height:1.52; }
      #${IDS.sourceHost} .CodeMirror-gutters { background:#0f1620; border-right:1px solid #263140; }
      #${IDS.sourceHost} .CodeMirror-linenumber { color:#536275; }
      #${IDS.sourceHost} .rk-foldgutter { width:16px; }
      #${IDS.sourceHost} .rk-fold-marker { color:#6f8197; cursor:pointer; font:11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; text-align:center; }
      #${IDS.sourceHost} .rk-fold-marker:hover { color:#9db1c9; }
      #${IDS.sourceHost} .CodeMirror-foldmarker { color:#8aa2c0; text-shadow:none; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
      #${IDS.sourceHost} .CodeMirror-cursor { border-left-color:#fff; }
      #${IDS.sourceHost} .rk-html-error-mark { text-decoration:underline wavy #ff6f78 1.5px; text-decoration-skip-ink:none; background:rgba(255,74,87,.08); }
      #${IDS.sourceHost} .CodeMirror-selected { background:#214a91 !important; }
      #${IDS.sourceHost} .cm-tag { color:#ff6f91; }
      #${IDS.sourceHost} .cm-attribute { color:#eec66d; }
      #${IDS.sourceHost} .cm-string { color:#98d36f; }
      #${IDS.sourceHost} .cm-comment { color:#708195; }
      #${IDS.previewCanvas} { flex:1; min-height:0; overflow:auto; padding:18px; display:flex; justify-content:center; align-items:flex-start; background:#1a2029; }
      .rk-preview-shell { width:100%; align-self:flex-start; transition:width .18s ease; background:#fff; box-shadow:0 8px 30px rgba(0,0,0,.28); }
      .rk-preview-shell[data-mode="desktop"] { max-width:760px; }
      .rk-preview-shell[data-mode="mobile"] { width:390px; max-width:390px; }
      #${IDS.previewFrame} { display:block; width:100%; height:600px; border:0; background:#fff; overflow:hidden; }
      .rk-hidden { display:none !important; }
      .rk-kbd { color:#728398; font-size:11px; }
      .rk-popover { position:fixed; top:58px; right:110px; width:min(420px,calc(100vw - 24px)); max-height:70vh; overflow:auto;
        z-index:2147483646; background:#111823; border:1px solid #334155; border-radius:10px; box-shadow:0 18px 50px rgba(0,0,0,.4); padding:8px; }
      .rk-popover-head { display:flex; align-items:center; gap:8px; padding:4px 4px 8px; border-bottom:1px solid #263140; margin-bottom:4px; }
      .rk-popover-head strong { flex:1; font-size:13px; }
      .rk-issue-row { width:100%; text-align:left; border:0; border-bottom:1px solid #202b39; background:transparent; color:#dce6f4;
        padding:9px 8px; cursor:pointer; font:12px/1.35 inherit; display:flex; align-items:center; gap:8px; }
      .rk-issue-row:hover { background:#182334; }
      .rk-empty { color:#8293a8; padding:14px 8px; font-size:12px; }
      .rk-version { color:#71839a; font-size:11px; font-weight:600; }
      .rk-validator-ok { color:#72d6a0; }
      .rk-validator-warn { color:#f4be63; }
      .rk-issue-severity { width:8px; height:8px; border-radius:50%; flex:0 0 8px; }
      .rk-issue-severity[data-severity="error"] { background:#ff737d; }
      .rk-issue-severity[data-severity="warning"] { background:#f4be63; }
      .rk-issue-line { color:#7f91a7; margin-left:auto; white-space:nowrap; }
    `;
    document.head.appendChild(style);
  }

  function ensureLauncher() {
    if (document.getElementById(IDS.launcher)) return;
    if (!getNativeEditor()) return;
    injectStyle();
    const button = document.createElement('button');
    button.id = IDS.launcher;
    button.type = 'button';
    button.textContent = 'RK';
    button.title = 'Open RetKit workspace';
    button.addEventListener('click', openWorkspace);
    document.body.appendChild(button);
  }

  function currentRouteKey() {
    return `${String(root.location?.pathname || '')}${String(root.location?.search || '')}`;
  }

  function syncLauncherPresence() {
    if (document.hidden && !document.getElementById(IDS.workspace)) return;
    const route = currentRouteKey();
    const routeChanged = Boolean(STATE.launcherRoute && STATE.launcherRoute !== route);
    const hasNative = Boolean(getNativeEditor());
    const launcher = document.getElementById(IDS.launcher);
    const workspace = document.getElementById(IDS.workspace);
    const action = launcherLifecycleAction({ hasNative, hasLauncher: Boolean(launcher), hasWorkspace: Boolean(workspace), routeChanged });

    if (action === 'show') ensureLauncher();
    else if (action === 'remove') launcher?.remove();
    else if (action === 'close-workspace') {
      diagBreadcrumb('workspace.route-exit', { from: STATE.launcherRoute, to: route });
      closeWorkspace();
      document.getElementById(IDS.launcher)?.remove();
    }
    STATE.launcherRoute = route;
  }

  function makeButton(text, onClick, options = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `rk-btn${options.active ? ' rk-active' : ''}`;
    button.textContent = text;
    if (options.title) button.title = options.title;
    button.addEventListener('click', onClick);
    return button;
  }

  function clearSearchMarks() {
    for (const mark of STATE.searchMarks || []) {
      try { mark.clear?.(); } catch {}
    }
    STATE.searchMarks = [];
  }

  function updateSearchHighlights(query, currentStart = -1) {
    const editor = STATE.overlayEditor;
    const count = document.getElementById(IDS.matchCount);
    clearSearchMarks();
    if (!editor || !query) {
      if (count) count.textContent = '0/0';
      return [];
    }
    const source = editor.getValue();
    const indices = findAllLiteral(source, query);
    const cap = Math.min(indices.length, 500);
    for (let i = 0; i < cap; i += 1) {
      const index = indices[i];
      const from = editor.posFromIndex(index);
      const to = editor.posFromIndex(index + query.length);
      const current = index === currentStart;
      try {
        STATE.searchMarks.push(editor.markText(from, to, { className: current ? 'rk-search-hit-current' : 'rk-search-hit' }));
      } catch {}
    }
    if (count) {
      const currentPos = currentStart === -1 ? 0 : Math.max(0, indices.indexOf(currentStart) + 1);
      count.textContent = `${currentPos}/${indices.length}`;
    }
    return indices;
  }

  function findNext(query, direction = 1) {
    const editor = STATE.overlayEditor;
    if (!editor || !query) return;
    const source = editor.getValue();
    const anchor = direction > 0
      ? editor.indexFromPos(editor.getCursor('to'))
      : editor.indexFromPos(editor.getCursor('from'));
    let index = direction > 0
      ? source.indexOf(query, anchor)
      : source.lastIndexOf(query, Math.max(0, anchor - 1));
    if (index === -1) index = direction > 0 ? source.indexOf(query) : source.lastIndexOf(query);
    if (index === -1) {
      updateSearchHighlights(query, -1);
      status(`Not found: ${query}`, 'warn');
      return;
    }
    const from = editor.posFromIndex(index);
    const to = editor.posFromIndex(index + query.length);
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, 180);
    editor.focus();
    updateSearchHighlights(query, index);
    status(`Found at ${from.line + 1}:${from.ch + 1}`, 'ok');
  }

  function closeFindBar() {
    document.getElementById(IDS.findBar)?.classList.remove('rk-open');
    document.getElementById(IDS.multiLocaleDrawer)?.remove();
    clearSearchMarks();
    STATE.overlayEditor?.focus();
  }

  function openFindBar() {
    const bar = document.getElementById(IDS.findBar);
    const find = document.getElementById(IDS.findInput);
    if (!bar || !find) return;
    bar.classList.add('rk-open');
    const selected = STATE.overlayEditor?.getSelection?.() || '';
    if (selected && selected.length < 200 && !/\n/.test(selected)) find.value = selected;
    find.focus();
    find.select();
    updateSearchHighlights(find.value, -1);
    renderMultiLocaleDrawer(true);
    scheduleMultiLocaleAutoScan(40);
  }

  function replaceCurrent() {
    const editor = STATE.overlayEditor;
    const find = document.getElementById(IDS.findInput);
    const replace = document.getElementById(IDS.replaceInput);
    const query = find?.value || '';
    if (!editor || !query) return;
    const replacement = replace?.value || '';
    if (editor.getSelection() === query) {
      editor.replaceSelection(replacement, 'around', '+retkit-replace');
    }
    findNext(query, 1);
  }

  function replaceAllMatches() {
    const editor = STATE.overlayEditor;
    const find = document.getElementById(IDS.findInput);
    const replace = document.getElementById(IDS.replaceInput);
    const query = find?.value || '';
    if (!editor || !query) return;
    const result = smartReplace(editor.getValue(), query, replace?.value || '', 'text');
    if (!result.count) {
      status(`Not found: ${query}`, 'warn');
      return;
    }
    const cursor = editor.getCursor();
    editor.operation(() => editor.setValue(result.value));
    editor.setCursor(cursor);
    updateSearchHighlights(query, -1);
    status(`Replaced ${result.count} occurrence${result.count === 1 ? '' : 's'}`, 'ok');
    scheduleMultiLocaleAutoScan(120);
  }

  function captureEditorViewState() {
    const editor = STATE.overlayEditor;
    if (!editor) return null;
    const scroll = typeof editor.getScrollInfo === 'function' ? editor.getScrollInfo() : {};
    let selections = [];
    if (typeof editor.listSelections === 'function') {
      selections = editor.listSelections().map((selection) => ({
        anchor: { line: Number(selection?.anchor?.line || 0), ch: Number(selection?.anchor?.ch || 0) },
        head: { line: Number(selection?.head?.line || 0), ch: Number(selection?.head?.ch || 0) },
      }));
    } else if (typeof editor.getCursor === 'function') {
      const from = editor.getCursor('from');
      const to = editor.getCursor('to');
      selections = [{ anchor: { line: from.line, ch: from.ch }, head: { line: to.line, ch: to.ch } }];
    }
    return {
      left: Number(scroll.left || 0),
      top: Number(scroll.top || 0),
      selections,
    };
  }

  function restoreEditorViewState(state) {
    if (!state) return;
    const editor = STATE.overlayEditor;
    if (!editor) return;
    const applySelection = () => {
      if (state.selections?.length && typeof editor.setSelections === 'function') editor.setSelections(state.selections);
      else if (state.selections?.[0] && typeof editor.setSelection === 'function') editor.setSelection(state.selections[0].anchor, state.selections[0].head);
    };
    if (typeof editor.operation === 'function') editor.operation(applySelection);
    else applySelection();
    if (typeof editor.scrollTo === 'function') editor.scrollTo(state.left || 0, state.top || 0);
  }

  async function restoreEditorViewStateAfterNativeWork(state) {
    if (!state) return;
    await new Promise((resolve) => root.setTimeout(resolve, 0));
    restoreEditorViewState(state);
  }

  function multiLocaleBridge() {
    return root.__RetKitMoEngageBridgeApi || null;
  }

  // Shared smart matcher (src/shared/replace-across.js): & == &amp;, and an
  // optional "same image file name" mode. Falls back to exact literal matching.
  function replaceCore() {
    return root.RetKitReplaceAcross || null;
  }

  function multiLocaleMode() {
    const toggle = document.getElementById(IDS.multiLocaleModeToggle);
    return toggle?.checked ? 'filename' : 'text';
  }

  function smartReplace(source, query, replacement, mode = 'text') {
    const ra = replaceCore();
    if (ra) return ra.replaceIn(source, query, replacement, { mode });
    return replaceAllLiteral(source, query, replacement);
  }

  function smartPlan(htmlByLocale, query, locales, mode = 'text') {
    const ra = replaceCore();
    const wanted = [...new Set((locales || []).map((l) => String(l || '').trim().toUpperCase()).filter(Boolean))];
    return wanted.map((locale) => {
      const html = String(htmlByLocale[locale] ?? '');
      if (ra) {
        const scan = ra.scan(html, query, { mode, maxHits: 6 });
        return { locale, count: scan.count, changed: scan.count > 0, hits: scan.hits };
      }
      const count = findAllLiteral(html, query).length;
      return { locale, count, changed: count > 0, hits: [] };
    });
  }

  function setMultiLocaleLoading(message = '') {
    const drawer = document.getElementById(IDS.multiLocaleDrawer);
    let loading = document.getElementById(IDS.multiLocaleLoading);
    if (!message) { loading?.remove(); return; }
    if (!drawer) return;
    if (!loading) {
      loading = document.createElement('div');
      loading.id = IDS.multiLocaleLoading;
      loading.innerHTML = '<div class="rk-ml-loading-card"><div class="rk-ml-progress-row"><span class="rk-ml-spinner" aria-hidden="true"></span><span class="rk-ml-progress-text" data-rk-ml-loading-text></span><span class="rk-ml-progress-hint">Please wait · keep this tab open</span></div><div class="rk-ml-progress-track"><div class="rk-ml-progress-bar" data-rk-ml-progress-bar></div></div></div>';
      drawer.insertBefore(loading, drawer.children[1] || null);
    }
    const text = loading.querySelector('[data-rk-ml-loading-text]');
    if (text) text.textContent = String(message);
    const match = String(message).match(/(\d+)\s*\/\s*(\d+)/);
    const progress = loading.querySelector('[data-rk-ml-progress-bar]');
    if (progress) {
      const current = Number(match?.[1] || 0);
      const total = Number(match?.[2] || 0);
      progress.style.width = total > 0 ? `${Math.max(0, Math.min(100, (current / total) * 100))}%` : '12%';
    }
  }

  function setMultiLocaleBusy(value, message = '') {
    STATE.multiLocaleBusy = Boolean(value);
    setMultiLocaleLoading(STATE.multiLocaleBusy ? (message || 'Working across locales…') : '');
    const drawer = document.getElementById(IDS.multiLocaleDrawer);
    if (!drawer) return;
    for (const control of drawer.querySelectorAll('button,input')) control.disabled = STATE.multiLocaleBusy;
  }

  function requestMultiLocaleCancel() {
    if (!STATE.multiLocaleBusy) return;
    STATE.multiLocaleCancelRequested = true;
    status('Stopping after the current locale…', 'warn');
  }

  async function restoreMultiLocaleOrigin(origin) {
    const bridge = multiLocaleBridge();
    if (!bridge || !origin) return;
    try { await Promise.resolve(bridge.switchLocale?.(origin, { preferNative: true, rebind: true })); } catch {}
  }

  function knownMultiLocaleCodesFromUi() {
    const values = [];
    const strip = document.getElementById(IDS.localeStrip);
    if (strip?.dataset?.locales) values.push(...String(strip.dataset.locales).split(','));
    for (const tab of strip?.querySelectorAll?.('.rk-v052-locale-tab') || []) values.push(String(tab.textContent || ''));
    return [...new Set(values.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean))];
  }

  function renderMultiLocalePlanRows() {
    const host = document.getElementById(IDS.multiLocaleRows);
    const drawer = document.getElementById(IDS.multiLocaleDrawer);
    if (!host || !drawer) return;
    host.replaceChildren();
    const apply = drawer.querySelector('[data-rk-multilocale-apply]');
    if (!STATE.multiLocalePlan.length) {
      const empty = document.createElement('div');
      empty.className = 'rk-ml-note';
      if (STATE.multiLocaleBusy) {
        empty.textContent = 'Scanning locales…';
      } else if (STATE.multiLocaleScanError) {
        const message = document.createElement('span');
        message.textContent = `Locale scan failed: ${STATE.multiLocaleScanError} `;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'rk-find-mini';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => {
          STATE.multiLocaleScanError = '';
          scheduleMultiLocaleAutoScan(0);
        });
        empty.append(message, retry);
      } else {
        empty.textContent = 'RetKit scans locales automatically.';
      }
      host.appendChild(empty);
      if (apply) { apply.disabled = true; apply.textContent = 'Replace across locales'; }
      return;
    }
    const selectable = STATE.multiLocalePlan.filter((item) => item.count > 0);
    const all = document.createElement('label');
    all.className = 'rk-ml-row';
    const allInput = document.createElement('input');
    allInput.type = 'checkbox';
    allInput.dataset.rkLocaleAll = '1';
    allInput.checked = selectable.length > 0;
    const allText = document.createElement('strong');
    const totalMatches = selectable.reduce((sum, item) => sum + Number(item.count || 0), 0);
    allText.textContent = `All · ${totalMatches}`;
    all.append(allInput, allText);
    host.appendChild(all);
    for (const item of STATE.multiLocalePlan) {
      const row = document.createElement('label');
      row.className = 'rk-ml-row';
      row.dataset.locale = item.locale;
      if (!item.count) row.dataset.disabled = '1';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.rkLocaleSelect = item.locale;
      checkbox.checked = item.count > 0;
      checkbox.disabled = item.count === 0;
      const locale = document.createElement('strong');
      locale.textContent = item.count ? `${localeLabel(item.locale)} · ${item.count}${Object.prototype.hasOwnProperty.call(STATE.multiLocaleOverrides || {}, item.locale) ? ' ✎' : ''}` : localeLabel(item.locale);
      row.title = item.count ? `${item.count} match${item.count === 1 ? '' : 'es'} · click the name to see where` : 'Not found';
      locale.addEventListener('click', (event) => {
        if (!item.count) return;
        event.preventDefault();
        renderMultiLocaleDetails(item.locale);
      });
      locale.style.cursor = item.count ? 'pointer' : '';
      row.append(checkbox, locale);
      host.appendChild(row);
    }
    const detailsLocale = STATE.multiLocalePlan.find((item) => item.locale === STATE.multiLocaleDetailsLocale && item.count)?.locale
      || STATE.multiLocalePlan.find((item) => item.count)?.locale;
    if (detailsLocale) renderMultiLocaleDetails(detailsLocale);
    else document.getElementById(IDS.multiLocaleDetails)?.replaceChildren();
    const refreshApply = () => {
      const selected = [...host.querySelectorAll('[data-rk-locale-select]:checked')];
      const enabled = [...host.querySelectorAll('[data-rk-locale-select]:not(:disabled)')];
      allInput.checked = enabled.length > 0 && selected.length === enabled.length;
      allInput.indeterminate = selected.length > 0 && selected.length < enabled.length;
      if (apply) {
        const selectedLocales = new Set(selected.map((input) => input.dataset.rkLocaleSelect));
        const selectedMatches = STATE.multiLocalePlan
          .filter((item) => selectedLocales.has(item.locale))
          .reduce((sum, item) => sum + Number(item.count || 0), 0);
        apply.disabled = STATE.multiLocaleBusy || selected.length === 0 || selectedMatches === 0;
        apply.textContent = selected.length
          ? `Replace ${selectedMatches} match${selectedMatches === 1 ? '' : 'es'} in ${selected.length} locale${selected.length === 1 ? '' : 's'}`
          : 'Replace across locales';
      }
    };
    allInput.addEventListener('change', () => {
      for (const input of host.querySelectorAll('[data-rk-locale-select]:not(:disabled)')) input.checked = allInput.checked;
      refreshApply();
    });
    for (const input of host.querySelectorAll('[data-rk-locale-select]')) input.addEventListener('change', refreshApply);
    refreshApply();
  }

  function updateMultiLocaleRowState(locale, text, state = '') {
    const drawer = document.getElementById(IDS.multiLocaleDrawer);
    const label = drawer?.querySelector(`[data-rk-locale-state="${locale}"]`);
    const row = label?.closest('.rk-ml-row');
    if (label) label.textContent = text;
    if (row) row.dataset.state = state;
  }

  async function scanMultiLocaleReplace() {
    if (STATE.multiLocaleBusy) { STATE.multiLocaleRescanPending = true; return; }
    const bridge = multiLocaleBridge();
    const find = document.getElementById(IDS.findInput);
    const replace = document.getElementById(IDS.replaceInput);
    const query = String(find?.value || '');
    if (!bridge?.readLocaleHtmlFast || !query) {
      if (!query) {
        STATE.multiLocalePlan = [];
        STATE.multiLocaleScanError = '';
        renderMultiLocalePlanRows();
      }
      return;
    }

    const replacement = String(replace?.value || '');
    const viewState = captureEditorViewState();
    const htmlByLocale = {};
    let locales = [];
    let origin = '';
    STATE.multiLocaleCancelRequested = false;
    STATE.multiLocaleScanError = '';
    STATE.multiLocalePlan = [];
    setMultiLocaleBusy(true, 'Scanning locales…');
    renderMultiLocalePlanRows();

    try {
      try {
        locales = bridge?.listLocales
          ? [...new Set((await Promise.resolve(bridge.listLocales())) || [])].map(String).filter(Boolean)
          : [];
      } catch (error) {
        diagBreadcrumb('multilocale.scan.locale-list-fallback', { reason: error?.message || String(error) });
      }
      if (!locales.length) {
        locales = knownMultiLocaleCodesFromUi();
        if (locales.length) diagBreadcrumb('multilocale.scan.locale-list-fallback', { localeCount: locales.length, source: 'known-ui-locales' });
      }
      if (!locales.length) throw new Error('No known MoEngage locales are available. Retry the scan below.');

      try { origin = String(await Promise.resolve(bridge.getActiveLocale?.() || '')); } catch {}
      setMultiLocaleLoading(`Scanning locales 0/${locales.length}…`);
      status(`Scanning ${locales.length} locales…`, 'neutral');
      diagBreadcrumb('multilocale.scan.start', { localeCount: locales.length, mode: 'native-fast' });

      for (let index = 0; index < locales.length; index += 1) {
        const locale = locales[index];
        setMultiLocaleLoading(`Scanning locales ${index + 1}/${locales.length}…`);
        htmlByLocale[locale] = String(await Promise.resolve(bridge.readLocaleHtmlFast(locale)) || '');
      }
      if (String(document.getElementById(IDS.findInput)?.value || '') !== query) {
        STATE.multiLocaleRescanPending = true;
        return;
      }
      STATE.multiLocalePlan = smartPlan(htmlByLocale, query, locales, multiLocaleMode());
      if (STATE.multiLocaleOverridesQuery !== query) {
        STATE.multiLocaleOverrides = {};
        STATE.multiLocaleOverridesQuery = query;
      }
      void replacement;
      renderMultiLocalePlanRows();
      const summary = summarizeLocaleReplacePlan(STATE.multiLocalePlan);
      status(`Found ${summary.totalMatches} matches in ${summary.matchedLocales}/${summary.localeCount} locales`, summary.totalMatches ? 'ok' : 'warn');
      diagBreadcrumb('multilocale.scan.done', { ...summary, mode: 'native-fast' });
    } catch (error) {
      STATE.multiLocaleScanError = error?.message || String(error);
      STATE.multiLocalePlan = [];
      renderMultiLocalePlanRows();
      diagIncident('multilocale_scan_failed', STATE.multiLocaleScanError, { localeCount: locales.length });
      status(`Locale scan failed: ${STATE.multiLocaleScanError}. Retry is available below.`, 'error');
    } finally {
      if (origin) await restoreMultiLocaleOrigin(origin);
      await restoreEditorViewStateAfterNativeWork(viewState);
      setMultiLocaleBusy(false);
      renderMultiLocalePlanRows();
      if (STATE.multiLocaleRescanPending) {
        STATE.multiLocaleRescanPending = false;
        scheduleMultiLocaleAutoScan(80);
      }
    }
  }

  function scheduleMultiLocaleAutoScan(delayMs = 260) {
    clearTimeout(STATE.multiLocaleAutoScanTimer);
    STATE.multiLocaleAutoScanTimer = setTimeout(() => {
      STATE.multiLocaleAutoScanTimer = null;
      const query = String(document.getElementById(IDS.findInput)?.value || '');
      if (!query) {
        STATE.multiLocalePlan = [];
        document.getElementById(IDS.multiLocaleDrawer)?.remove();
        return;
      }
      renderMultiLocaleDrawer(true);
      if (STATE.multiLocaleBusy) { STATE.multiLocaleRescanPending = true; return; }
      void scanMultiLocaleReplace().catch((error) => {
        const message = error?.message || String(error);
        STATE.multiLocaleScanError = message;
        STATE.multiLocalePlan = [];
        setMultiLocaleBusy(false);
        renderMultiLocalePlanRows();
        diagIncident('multilocale_scan_failed', message, { source: 'auto-scan-scheduler' });
        status(`Locale scan failed: ${message}`, 'error');
      });
    }, Math.max(0, Number(delayMs) || 0));
  }

  function selectedMultiLocaleItems() {
    const drawer = document.getElementById(IDS.multiLocaleDrawer);
    const selected = new Set([...drawer?.querySelectorAll('[data-rk-locale-select]:checked') || []].map((input) => input.dataset.rkLocaleSelect));
    return STATE.multiLocalePlan.filter((item) => selected.has(item.locale) && item.count > 0);
  }

  async function applyMultiLocaleReplace() {
    if (STATE.multiLocaleBusy) return;
    const bridge = multiLocaleBridge();
    if (!bridge?.setLocaleHtmlStable || !bridge?.readLocaleHtmlFast) {
      status('Stable locale writer is unavailable', 'error');
      return;
    }
    const find = document.getElementById(IDS.findInput);
    const replaceField = document.getElementById(IDS.replaceInput);
    const query = String(find?.value || '');
    const replacement = String(replaceField?.value || '');
    const mode = multiLocaleMode();
    const items = selectedMultiLocaleItems();
    if (!query || !items.length) {
      status('Select at least one locale with matches', 'warn');
      return;
    }
    const origin = String(await Promise.resolve(bridge.getActiveLocale?.() || ''));
    const viewState = captureEditorViewState();
    const applied = [];
    setMultiLocaleBusy(true, `Replacing locales 0/${items.length}…`);
    diagBreadcrumb('multilocale.apply.start', { locales: items.map((item) => item.locale), queryLength: query.length, mode: 'native-hidden-stable' });
    try {
      // The scan is only a discovery/selection aid. Before each write, re-read
      // the current locale HTML so unrelated edits made after the scan are kept.
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        setMultiLocaleLoading(`Replacing locales ${index + 1}/${items.length}…`);
        updateMultiLocaleRowState(item.locale, `reading ${index + 1}/${items.length}…`);
        const currentHtml = String(await Promise.resolve(bridge.readLocaleHtmlFast(item.locale)) || '');
        const own = Object.prototype.hasOwnProperty.call(STATE.multiLocaleOverrides || {}, item.locale)
          ? String(STATE.multiLocaleOverrides[item.locale]) : null;
        const result = smartReplace(currentHtml, query, own ?? replacement, mode);
        if (!result.count) {
          updateMultiLocaleRowState(item.locale, 'no current matches', 'warn');
          continue;
        }
        updateMultiLocaleRowState(item.locale, `writing ${result.count}…`);
        const write = await Promise.resolve(bridge.setLocaleHtmlStable(item.locale, result.value));
        if (!write?.ok) {
          updateMultiLocaleRowState(item.locale, 'write failed', 'error');
          throw new Error(write?.reason || `${item.locale}: native write failed`);
        }
        applied.push({ locale: item.locale, count: result.count });
        updateMultiLocaleRowState(item.locale, `✓ ${result.count}`, 'ok');
      }
        const totalMatches = applied.reduce((sum, item) => sum + item.count, 0);
      status(`Replaced ${totalMatches} matches in ${applied.length} locales · ↶ Original keeps each locale's first version`, applied.length ? 'ok' : 'warn');
      diagBreadcrumb('multilocale.apply.done', { localeCount: applied.length, totalMatches, mode: 'native-hidden-stable' });
      scheduleMultiLocaleAutoScan(120);
    } catch (error) {
          diagIncident('multilocale_apply_failed', error?.message || String(error), { appliedLocales: applied.map((item) => item.locale), mode: 'native-hidden-stable' });
      status(`Bulk replace stopped: ${error?.message || error}`, 'error');
    } finally {
      await restoreMultiLocaleOrigin(origin);
      setMultiLocaleBusy(false);
      try { multiLocaleBridge()?.refreshUi?.(); } catch {}
      await restoreEditorViewStateAfterNativeWork(viewState);
    }
  }

  async function refreshLocaleManager() {
    const bridge = multiLocaleBridge();
    const host = document.getElementById(IDS.localeManagerRows);
    if (!host || !bridge?.listLocales) return;
    host.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'rk-ml-note';
    loading.textContent = 'Reading locales from MoEngage…';
    host.appendChild(loading);
    try {
      const existing = [...new Set((await Promise.resolve(bridge.listLocales())) || [])].map(String);
      let available = [];
      try { available = [...new Set((await Promise.resolve(bridge.listAvailableLocales?.())) || [])].map(String); } catch (error) {
        diagIncident('locale_available_scan_failed', error?.message || String(error), {});
      }
      host.replaceChildren();
      const existingWrap = document.createElement('div');
      for (const locale of existing) {
        const chip = document.createElement('span');
        chip.className = 'rk-ml-locale-chip';
        chip.append(document.createTextNode(locale));
        if (!/^(?:EN|DEFAULT)$/i.test(locale)) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'rk-ml-remove';
          remove.textContent = '×';
          remove.title = `Remove ${localeLabel(locale)}`;
          remove.addEventListener('click', async () => {
            if (STATE.multiLocaleBusy || root.confirm?.(`Remove locale ${localeLabel(locale)} from this MoEngage campaign?`) === false) return;
            setMultiLocaleBusy(true);
            try {
              const result = await Promise.resolve(bridge.removeLocale?.(locale));
              status(result?.ok ? `Removed ${locale}` : (result?.reason || `Could not remove ${locale}`), result?.ok ? 'ok' : 'error');
            } finally {
              setMultiLocaleBusy(false);
              await refreshLocaleManager();
            }
          });
          chip.appendChild(remove);
        }
        existingWrap.appendChild(chip);
      }
      host.appendChild(existingWrap);
      if (available.length) {
        const hint = document.createElement('div');
        hint.className = 'rk-ml-note';
        hint.textContent = 'Available in MoEngage but not created:';
        host.appendChild(hint);
        for (const locale of available) {
          const label = document.createElement('label');
          label.className = 'rk-ml-locale-chip';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.dataset.rkAddLocale = locale;
          label.append(checkbox, document.createTextNode(locale));
          host.appendChild(label);
        }
        const add = makeButton('Create selected', async () => {
          const locales = [...host.querySelectorAll('[data-rk-add-locale]:checked')].map((input) => input.dataset.rkAddLocale);
          if (!locales.length || STATE.multiLocaleBusy) return;
          setMultiLocaleBusy(true);
          try {
            const result = await Promise.resolve(bridge.addLocales?.(locales));
            status(result?.ok ? `Created: ${(result.added || []).join(', ')}` : (result?.reason || 'Locale creation failed'), result?.ok ? 'ok' : 'error');
          } finally {
            setMultiLocaleBusy(false);
            await refreshLocaleManager();
          }
        });
        add.classList.add('rk-find-mini');
        host.appendChild(add);
      } else {
        const done = document.createElement('div');
        done.className = 'rk-ml-note';
        done.textContent = 'No additional locales are currently offered by MoEngage.';
        host.appendChild(done);
      }
    } catch (error) {
      host.replaceChildren();
      const failed = document.createElement('div');
      failed.className = 'rk-ml-note';
      failed.textContent = `Could not read locales: ${error?.message || error}`;
      host.appendChild(failed);
    }
  }

  function renderMultiLocaleDrawer(forceOpen = false) {
    const bar = document.getElementById(IDS.findBar);
    const query = String(document.getElementById(IDS.findInput)?.value || '');
    if (!bar || !bar.classList.contains('rk-open') || !query) {
      document.getElementById(IDS.multiLocaleDrawer)?.remove();
      return;
    }
    let drawer = document.getElementById(IDS.multiLocaleDrawer);
    if (!drawer) {
      drawer = document.createElement('div');
      drawer.id = IDS.multiLocaleDrawer;
      const head = document.createElement('div');
      head.className = 'rk-ml-head';
      const title = document.createElement('strong');
      title.textContent = 'Across locales';
      const modeLabel = document.createElement('label');
      modeLabel.className = 'rk-ml-note rk-ml-mode';
      modeLabel.title = 'Each locale may host the same picture under its own upload path. This finds every URL ending with the same file name and replaces the whole URL.';
      const modeToggle = document.createElement('input');
      modeToggle.type = 'checkbox';
      modeToggle.id = IDS.multiLocaleModeToggle;
      modeToggle.addEventListener('change', () => scheduleMultiLocaleAutoScan(0));
      modeLabel.append(modeToggle, document.createTextNode(' Same image by file name'));
      const note = document.createElement('span');
      note.className = 'rk-ml-note';
      note.textContent = '& = &amp;';
      note.title = 'A link with & also matches its &amp; form; the replacement keeps the encoding it replaces.';
      head.append(title, modeLabel, note);
      drawer.appendChild(head);
      const rows = document.createElement('div');
      rows.id = IDS.multiLocaleRows;
      drawer.appendChild(rows);
      const details = document.createElement('div');
      details.id = IDS.multiLocaleDetails;
      drawer.appendChild(details);
      const actions = document.createElement('div');
      actions.className = 'rk-ml-actions';
      const hint = document.createElement('span');
      hint.className = 'rk-ml-note';
      hint.textContent = 'Uses the “Replace with…” field above.';
      const apply = makeButton('Replace across locales', applyMultiLocaleReplace);
      apply.dataset.rkMultilocaleApply = '1';
      apply.classList.add('rk-find-mini');
      apply.disabled = true;
      actions.append(hint, apply);
      drawer.appendChild(actions);
      bar.insertAdjacentElement('afterend', drawer);
    }
    const modeLabel = drawer.querySelector('.rk-ml-mode');
    const ra = replaceCore();
    if (modeLabel) modeLabel.style.display = ra?.looksLikeImage?.(query) ? '' : 'none';
    const modeToggle = document.getElementById(IDS.multiLocaleModeToggle);
    if (modeToggle && modeLabel?.style.display === 'none') modeToggle.checked = false;
    renderMultiLocalePlanRows();
  }

  // Where exactly the matches are in one locale: kind + highlighted context.
  function renderMultiLocaleDetails(locale) {
    const host = document.getElementById(IDS.multiLocaleDetails);
    if (!host) return;
    host.replaceChildren();
    const item = STATE.multiLocalePlan.find((entry) => entry.locale === locale);
    if (!item || !item.count) return;
    STATE.multiLocaleDetailsLocale = locale;
    const own = document.createElement('div');
    own.className = 'rk-ml-own';
    const ownLabel = document.createElement('span');
    ownLabel.className = 'rk-ml-kind';
    ownLabel.textContent = `${localeLabel(locale)}: replace with`;
    const ownInput = document.createElement('input');
    ownInput.className = 'rk-find-input';
    ownInput.dataset.rkLocaleOverride = locale;
    ownInput.placeholder = 'empty = same as “Replace with…” above';
    ownInput.autocomplete = 'off';
    ownInput.value = Object.prototype.hasOwnProperty.call(STATE.multiLocaleOverrides || {}, locale) ? STATE.multiLocaleOverrides[locale] : '';
    ownInput.addEventListener('input', () => {
      if (ownInput.value === '') delete STATE.multiLocaleOverrides[locale];
      else STATE.multiLocaleOverrides[locale] = ownInput.value;
      const chip = document.querySelector(`#${IDS.multiLocaleRows} [data-locale="${locale}"] strong`);
      if (chip) chip.textContent = `${localeLabel(locale)} · ${item.count}${ownInput.value !== '' ? ' ✎' : ''}`;
    });
    own.append(ownLabel, ownInput);
    host.appendChild(own);
    const KIND = { image: 'image', link: 'link', background: 'background', attribute: 'attribute', text: 'text' };
    for (const hit of (item.hits || []).slice(0, 6)) {
      const line = document.createElement('div');
      line.className = 'rk-ml-hit';
      const kind = document.createElement('span');
      kind.className = 'rk-ml-kind';
      kind.textContent = `${localeLabel(locale)} · ${KIND[hit.kind] || 'text'}`;
      const code = document.createElement('code');
      const mark = document.createElement('mark');
      mark.textContent = hit.match;
      code.append(document.createTextNode(`…${String(hit.before || '').slice(-40)}`), mark, document.createTextNode(`${String(hit.after || '').slice(0, 40)}…`));
      line.append(kind, code);
      host.appendChild(line);
    }
    if (item.count > (item.hits || []).length) {
      const more = document.createElement('div');
      more.className = 'rk-ml-note';
      more.textContent = `+${item.count - item.hits.length} more in ${locale}`;
      host.appendChild(more);
    }
  }

  function buildFindBar(editorPane) {
    const bar = document.createElement('div');
    bar.id = IDS.findBar;
    const find = document.createElement('input');
    find.id = IDS.findInput;
    find.className = 'rk-find-input';
    find.placeholder = 'Find…';
    const replace = document.createElement('input');
    replace.id = IDS.replaceInput;
    replace.className = 'rk-find-input';
    replace.placeholder = 'Replace with…';
    const count = document.createElement('span');
    count.id = IDS.matchCount;
    count.textContent = '0/0';
    const prev = makeButton('↑', () => findNext(find.value, -1));
    const next = makeButton('↓', () => findNext(find.value, 1));
    const replaceOne = makeButton('Replace', replaceCurrent);
    const replaceAll = makeButton('All', replaceAllMatches);
    const close = makeButton('×', closeFindBar);
    for (const btn of [prev, next, replaceOne, replaceAll, close]) btn.classList.add('rk-find-mini');
    find.addEventListener('input', () => {
      updateSearchHighlights(find.value, -1);
      renderMultiLocaleDrawer(true);
      scheduleMultiLocaleAutoScan();
    });
    find.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); findNext(find.value, event.shiftKey ? -1 : 1); }
      if (event.key === 'Escape') { event.preventDefault(); closeFindBar(); }
    });
    replace.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); replaceCurrent(); }
      if (event.key === 'Escape') closeFindBar();
    });
    bar.append(find, replace, count, prev, next, replaceOne, replaceAll, close);
    editorPane.appendChild(bar);
  }

  function simpleIdentityHash(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function getEmailIdentity() {
    const subject = document.querySelector('input[name*="subject" i], input[placeholder*="subject" i]')?.value || '';
    const locale = document.querySelector('[data-testid*="locale" i], [class*="locale" i]')?.textContent?.trim().slice(0, 80) || '';
    const raw = `${location.pathname}|${location.search}|${subject}|${locale}`;
    return simpleIdentityHash(raw);
  }

  function closeFloatingPopovers(exceptId = '') {
    for (const id of [IDS.validatorPopover]) {
      if (id !== exceptId) document.getElementById(id)?.remove();
    }
  }

  function updateValidatorStatus() {
    const html = STATE.overlayEditor?.getValue() || '';
    STATE.validatorIssues = validateEmailHtml(html);
    const button = document.getElementById(IDS.validatorButton);
    const errors = STATE.validatorIssues.filter((issue) => issue.severity === 'error');
    const warnings = STATE.validatorIssues.filter((issue) => issue.severity !== 'error');
    for (const mark of STATE.validatorMarks || []) { try { mark.clear?.(); } catch {} }
    STATE.validatorMarks = [];
    const editor = STATE.overlayEditor;
    if (editor) {
      const source = editor.getValue();
      for (const issue of errors.slice(0, 80)) {
        const start = Math.max(0, Number(issue.index || 0));
        let end = source.indexOf('>', start);
        const lineEnd = source.indexOf('\n', start);
        if (end < 0 || (lineEnd >= 0 && end > lineEnd)) end = lineEnd >= 0 ? lineEnd : Math.min(source.length, start + 24);
        else end += 1;
        end = Math.max(start + 1, Math.min(source.length, end));
        try { STATE.validatorMarks.push(editor.markText(editor.posFromIndex(start), editor.posFromIndex(end), { className: 'rk-html-error-mark', title: `${issue.message} · line ${issue.line}` })); } catch {}
      }
    }
    if (button) {
      if (!STATE.validatorIssues.length) {
        button.textContent = '✓ HTML';
        button.classList.add('rk-validator-ok');
        button.classList.remove('rk-validator-warn');
        button.title = 'No structural HTML issues detected';
      } else {
        button.textContent = errors.length ? `⛔ HTML ${errors.length}${warnings.length ? ` · ⚠ ${warnings.length}` : ''}` : `⚠ HTML ${warnings.length}`;
        button.classList.remove('rk-validator-ok');
        button.classList.add('rk-validator-warn');
        button.title = errors.length ? 'HTML errors detected' : 'HTML warnings detected';
      }
    }
    const open = document.getElementById(IDS.validatorPopover);
    if (open) renderValidatorPopover(true);
  }

  function scheduleValidation() {
    clearTimeout(STATE.validatorTimer);
    STATE.validatorTimer = setTimeout(updateValidatorStatus, 120);
  }

  function jumpToIssue(issue) {
    const editor = STATE.overlayEditor;
    if (!editor || !issue) return;
    const from = editor.posFromIndex(Math.max(0, issue.index || 0));
    const to = editor.posFromIndex(Math.min(editor.getValue().length, (issue.index || 0) + 1));
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, 220);
    editor.focus();
    status(`${issue.message} · line ${issue.line}`, issue.severity === 'error' ? 'error' : 'warn');
    document.getElementById(IDS.validatorPopover)?.remove();
  }

  function renderValidatorPopover(forceOpen = false) {
    const existing = document.getElementById(IDS.validatorPopover);
    if (existing && !forceOpen) {
      existing.remove();
      return;
    }
    existing?.remove();
    closeFloatingPopovers(IDS.validatorPopover);
    updateValidatorStatus();
    const pop = document.createElement('div');
    pop.id = IDS.validatorPopover;
    pop.className = 'rk-popover';
    const head = document.createElement('div');
    head.className = 'rk-popover-head';
    head.innerHTML = '<strong>HTML validator</strong>';
    const close = makeButton('×', () => pop.remove());
    head.appendChild(close);
    pop.appendChild(head);
    if (!STATE.validatorIssues.length) {
      const empty = document.createElement('div');
      empty.className = 'rk-empty';
      empty.textContent = 'No structural issues detected.';
      pop.appendChild(empty);
    } else {
      for (const issue of STATE.validatorIssues) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'rk-issue-row';
        const dot = document.createElement('span');
        dot.className = 'rk-issue-severity';
        dot.dataset.severity = issue.severity;
        const text = document.createElement('span');
        text.textContent = issue.message;
        const line = document.createElement('span');
        line.className = 'rk-issue-line';
        line.textContent = `line ${issue.line}`;
        row.append(dot, text, line);
        row.addEventListener('click', () => jumpToIssue(issue));
        pop.appendChild(row);
      }
    }
    document.body.appendChild(pop);
  }

  function buildToolbar(workspace) {
    const bar = document.createElement('div');
    bar.className = 'rk-topbar';
    const brand = document.createElement('div');
    brand.className = 'rk-brand';
    brand.innerHTML = '<span class="rk-mark">RK</span><span>RetKit × MoEngage</span><span class="rk-version">v0.8.1</span>';
    const wrapBtn = makeButton('Wrap', () => {
      STATE.wrap = !STATE.wrap;
      localStorage.setItem('retkit-mo-wrap', String(STATE.wrap));
      STATE.overlayEditor?.setOption('lineWrapping', STATE.wrap);
      wrapBtn.classList.toggle('rk-active', STATE.wrap);
    }, { active: STATE.wrap });
    const validatorBtn = makeButton('✓ HTML', () => renderValidatorPopover(false), { title: 'HTML validation' });
    validatorBtn.id = IDS.validatorButton;
    validatorBtn.classList.add('rk-validator-ok');
    const copyBtn = makeButton('Copy HTML', async () => {
      const value = STATE.overlayEditor?.getValue() || '';
      try { await navigator.clipboard.writeText(value); status('HTML copied', 'ok'); }
      catch { status('Clipboard permission denied', 'error'); }
    });
    const closeBtn = makeButton('Close', closeWorkspace);
    const statusEl = document.createElement('div');
    statusEl.id = IDS.status;
    statusEl.textContent = 'Auto apply enabled';
    const spacer = document.createElement('div');
    spacer.className = 'rk-spacer';
    bar.append(brand, wrapBtn, copyBtn, statusEl, spacer, closeBtn);
    workspace.appendChild(bar);
    try {
      root.__RetKitDiagnostics?.ensureUi?.(workspace, {
        version: '0.8.1',
        getHtml: () => STATE.overlayEditor?.getValue?.() || STATE.nativeEditor?.getValue?.() || '',
      });
    } catch {}
    const diagnosticsButton = document.getElementById('retkit-diagnostics-button');
    bar.insertBefore(validatorBtn, diagnosticsButton || spacer);
  }

  function makePreviewModeButton(mode, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rk-icon-btn';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.innerHTML = mode === 'mobile'
      ? '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.2"></rect><path d="M10 5h4M11 18.5h2"></path></svg>'
      : '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="1.5"></rect><path d="M8 20h8M12 16v4"></path></svg>';
    button.addEventListener('click', () => {
      setPreviewMode(mode);
      updatePreviewModeButtons();
    });
    return button;
  }

  function updatePreviewModeButtons() {
    for (const button of document.querySelectorAll('[data-rk-preview-mode]')) {
      button.classList.toggle('rk-active', button.dataset.rkPreviewMode === STATE.previewMode);
    }
  }

  function setPreviewMode(mode) {
    STATE.previewMode = mode;
    localStorage.setItem('retkit-mo-preview-mode', mode);
    document.querySelector('.rk-preview-shell')?.setAttribute('data-mode', mode);
    status(`${mode === 'mobile' ? 'Mobile 390px' : 'Desktop'} preview`, 'ok');
  }

  function scheduleWorkspaceLayoutRefresh() {
    if (STATE.layoutRefreshTimer) clearTimeout(STATE.layoutRefreshTimer);
    // CodeMirror caches line wrapping / coordinates. After the grid width
    // changes, refresh those measurements before the next click-to-source jump.
    refreshEditorLayout(STATE.overlayEditor);
    const frame = document.getElementById(IDS.previewFrame);
    if (frame) resizePreviewFrame(frame);
    STATE.layoutRefreshTimer = setTimeout(() => {
      refreshEditorLayout(STATE.overlayEditor);
      const currentFrame = document.getElementById(IDS.previewFrame);
      if (currentFrame) resizePreviewFrame(currentFrame);
      STATE.layoutRefreshTimer = null;
    }, 90);
  }

  function setSplitPercent(percent) {
    const split = document.getElementById(IDS.split);
    if (!split) return;
    const clamped = Math.max(24, Math.min(76, Number(percent) || 50));
    STATE.splitPercent = clamped;
    localStorage.setItem('retkit-mo-split', String(clamped));
    split.style.setProperty('--rk-left', `${clamped}%`);
    scheduleWorkspaceLayoutRefresh();
  }

  function normalizePointText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function textNodeRectsHit(node, x, y, doc) {
    if (!node || node.nodeType !== 3 || !String(node.nodeValue || '').trim()) return false;
    try {
      const range = doc.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) {
          return true;
        }
      }
    } catch {}
    return false;
  }

  function textNodeAtPoint(event, doc) {
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    if (target && typeof doc.createTreeWalker === 'function' && root.NodeFilter) {
      try {
        const walker = doc.createTreeWalker(target, root.NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (textNodeRectsHit(node, event.clientX, event.clientY, doc)) return node;
        }
      } catch {}
    }

    // Fallback for browsers where Range hit-testing is unavailable.
    try {
      if (typeof doc.caretPositionFromPoint === 'function') {
        const pos = doc.caretPositionFromPoint(event.clientX, event.clientY);
        if (pos?.offsetNode?.nodeType === 3) return pos.offsetNode;
      } else if (typeof doc.caretRangeFromPoint === 'function') {
        const range = doc.caretRangeFromPoint(event.clientX, event.clientY);
        if (range?.startContainer?.nodeType === 3) return range.startContainer;
      }
    } catch {}
    return null;
  }

  function textNodeGlobalOccurrence(doc, selectedNode) {
    if (!doc || !selectedNode || typeof doc.createTreeWalker !== 'function' || !root.NodeFilter) return 0;
    const expected = normalizePointText(selectedNode.nodeValue);
    if (!expected) return 0;
    let occurrence = 0;
    try {
      const rootNode = doc.body || doc.documentElement;
      const walker = doc.createTreeWalker(rootNode, root.NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (normalizePointText(node.nodeValue) !== expected) continue;
        if (node === selectedNode) return occurrence;
        occurrence += 1;
      }
    } catch {}
    return 0;
  }

  function getPointTextFromClick(event, doc) {
    const node = textNodeAtPoint(event, doc);
    if (!node) return { text: '', node: null, ordinal: 0, globalOccurrence: 0 };

    const raw = String(node.nodeValue || '');
    if (!raw.trim()) return { text: '', node: null, ordinal: 0, globalOccurrence: 0 };
    const parent = node.parentElement;
    const textNodes = parent
      ? [...parent.childNodes].filter((item) => item.nodeType === 3 && String(item.nodeValue || '').trim())
      : [node];
    const ordinal = Math.max(0, textNodes.indexOf(node));
    const globalOccurrence = textNodeGlobalOccurrence(doc, node);
    return { text: raw.slice(0, 640), node, ordinal, globalOccurrence };
  }

  function countOccurrenceInDocument(doc, selector, element) {
    if (!doc || !selector || !element) return 0;
    try {
      const items = [...doc.querySelectorAll(selector)];
      const index = items.indexOf(element);
      return index >= 0 ? index : 0;
    } catch {
      return 0;
    }
  }

  function descriptorFromElement(element, doc, point = { text: '', node: null, ordinal: 0 }) {
    if (!element) return null;
    const link = element.closest?.('a[href]');
    const backgroundUrls = [];
    const backgroundOccurrences = [];
    let cursor = element;
    for (let depth = 0; cursor && depth < 6; depth += 1, cursor = cursor.parentElement) {
      try {
        const bg = doc.defaultView.getComputedStyle(cursor).backgroundImage;
        for (const match of bg?.matchAll(/url\(["']?(.*?)["']?\)/g) || []) {
          if (match[1] && !backgroundUrls.includes(match[1])) {
            backgroundUrls.push(match[1]);
            backgroundOccurrences.push(0);
          }
        }
      } catch {}
    }

    const tag = element.tagName || '';
    const tagOccurrence = tag ? countOccurrenceInDocument(doc, tag.toLowerCase(), element) : 0;
    const src = element.tagName === 'IMG' ? (element.getAttribute('src') || '') : '';
    const srcOccurrence = src ? countOccurrenceInDocument(doc, `img[src="${CSS.escape(src)}"]`, element) : 0;
    const href = link?.getAttribute('href') || '';
    const hrefOccurrence = href && link ? countOccurrenceInDocument(doc, `a[href="${CSS.escape(href)}"]`, link) : 0;

    const pointParent = point?.node?.parentElement || null;

    return {
      tag,
      tagOccurrence,
      pointText: point?.text || '',
      pointTextOrdinal: point?.ordinal || 0,
      pointTextGlobalOccurrence: point?.globalOccurrence ?? 0,
      pointParentTag: pointParent?.tagName || '',
      pointParentHasElementChildren: Boolean(pointParent?.children?.length),
      src,
      srcOccurrence,
      href,
      hrefOccurrence,
      id: element.id || '',
      classes: [...(element.classList || [])],
      text: [...(element.childNodes || [])]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.nodeValue || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240),
      backgroundUrls,
      backgroundOccurrences,
    };
  }

  function resizePreviewFrame(frame) {
    const doc = frame?.contentDocument;
    if (!doc) return;
    const canvas = document.getElementById(IDS.previewCanvas);
    const measured = getPreviewDocumentHeight(doc);
    const minimum = Math.max(520, (canvas?.clientHeight || 0) - 36);
    const height = Math.max(measured, minimum);
    frame.style.height = `${height}px`;
  }

  function schedulePreviewResize(frame) {
    for (const delay of [0, 80, 250, 800]) {
      setTimeout(() => resizePreviewFrame(frame), delay);
    }
    const doc = frame?.contentDocument;
    if (!doc) return;
    for (const image of doc.images || []) {
      if (!image.complete) image.addEventListener('load', () => resizePreviewFrame(frame), { once: true });
    }
    if (typeof ResizeObserver === 'function' && doc.documentElement) {
      const observer = new ResizeObserver(() => resizePreviewFrame(frame));
      observer.observe(doc.documentElement);
      frame.__retkitResizeObserver?.disconnect?.();
      frame.__retkitResizeObserver = observer;
    }
  }

  function bindPreviewClickNavigation(frame) {
    const doc = frame.contentDocument;
    if (!doc || doc.__retkitPreviewClickBound) return;
    doc.__retkitPreviewClickBound = true;
    doc.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const target = event.target;
      const point = getPointTextFromClick(event, doc);
      const descriptor = descriptorFromElement(target, doc, point);
      const source = STATE.overlayEditor?.getValue() || '';
      const result = findRangeFromDescriptor(source, descriptor);
      if (!result) {
        status(`Can't map ${target.tagName || 'element'} to source`, 'warn');
        return;
      }
      if (STATE.previewElement && STATE.previewElement !== target) {
        STATE.previewElement.style.outline = '';
        STATE.previewElement.style.outlineOffset = '';
      }
      STATE.previewElement = target;
      target.style.outline = '3px solid #4f7cff';
      target.style.outlineOffset = '2px';

      const editor = STATE.overlayEditor;
      const from = editor.posFromIndex(result.start);
      const to = editor.posFromIndex(result.end);
      editor.setSelection(from, to);
      editor.scrollIntoView({ from, to }, 220);
      editor.focus();
      status(`Mapped ${target.tagName.toLowerCase()} by ${result.kind} → line ${from.line + 1}`, 'ok');
    }, true);
  }

  function softUpdatePreviewDocument(html) {
    const frame = document.getElementById(IDS.previewFrame);
    const doc = frame?.contentDocument;
    if (!frame || !doc?.documentElement || typeof root.DOMParser !== 'function') return false;
    try {
      const parsed = new root.DOMParser().parseFromString(String(html || ''), 'text/html');
      if (!parsed?.documentElement || !parsed.head || !parsed.body) return false;
      const scrollTop = doc.scrollingElement?.scrollTop || 0;
      const syncAttrs = (target, source) => {
        for (const attr of [...target.attributes]) if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
        for (const attr of [...source.attributes]) target.setAttribute(attr.name, attr.value);
      };
      syncAttrs(doc.documentElement, parsed.documentElement);
      syncAttrs(doc.head, parsed.head);
      syncAttrs(doc.body, parsed.body);
      doc.head.replaceChildren(...[...parsed.head.childNodes].map((node) => doc.importNode(node, true)));
      doc.body.replaceChildren(...[...parsed.body.childNodes].map((node) => doc.importNode(node, true)));
      if (doc.scrollingElement) doc.scrollingElement.scrollTop = scrollTop;
      STATE.previewHtml = String(html || '');
      STATE.previewLastValidHtml = STATE.previewHtml;
      STATE.previewElement = null;
      bindPreviewClickNavigation(frame);
      schedulePreviewResize(frame);
      return true;
    } catch (error) {
      diagBreadcrumb('preview.soft-update-failed', { message: error?.message || String(error) });
      return false;
    }
  }

  function scheduleLocalPreview(html, delay = 140) {
    STATE.previewPendingHtml = String(html || '');
    clearTimeout(STATE.previewTimer);
    STATE.previewTimer = null;
    if (!STATE.previewPendingHtml || hasBlockingPreviewSyntaxIssue(STATE.previewPendingHtml)) return;
    STATE.previewTimer = setTimeout(() => {
      STATE.previewTimer = null;
      const next = STATE.previewPendingHtml;
      if (!next || next === STATE.previewHtml || hasBlockingPreviewSyntaxIssue(next)) return;
      if (!softUpdatePreviewDocument(next)) applyPreviewHtml(next, true);
    }, Math.max(0, Number(delay) || 0));
  }

  function applyPreviewHtml(html, force = false) {
    const frame = document.getElementById(IDS.previewFrame);
    if (!frame || !html) return;
    if (!force) {
      scheduleLocalPreview(html);
      return;
    }
    if (html === STATE.previewHtml && frame.contentDocument?.documentElement) return;
    clearTimeout(STATE.previewTimer);
    STATE.previewTimer = null;
    STATE.previewPendingHtml = String(html || '');
    STATE.previewHtml = html;
    frame.onload = () => {
      STATE.previewLastValidHtml = html;
      bindPreviewClickNavigation(frame);
      schedulePreviewResize(frame);
    };
    frame.srcdoc = html;
  }

  function refreshPreviewFromMoEngage(force = false) {
    if (!force && STATE.multiLocaleBusy) return;
    const html = getRenderedPreviewHtml();
    if (!html) return;
    // While there is unsaved local work, the local iframe is authoritative.
    // Never let a delayed MoEngage render replace the preview of newer text.
    if (!force && STATE.dirty) return;

    if (!force && STATE.awaitingRenderedUpdate) {
      const accept = shouldAcceptRenderedPreview({
        awaiting: true,
        renderedBeforeEdit: STATE.renderedBeforeEdit,
        localPreviewUntil: STATE.localPreviewUntil,
      }, html);
      if (!accept) return;
      STATE.awaitingRenderedUpdate = false;
    }

    // The poll runs twice a second; an unchanged render is a no-op, so skip it
    // before the full-document syntax check that scheduleLocalPreview runs.
    if (!force && html === STATE.previewHtml) return;
    applyPreviewHtml(html, force);
  }

  function scheduleNativeSync(delay = idleSyncDelay()) {
    clearTimeout(STATE.syncTimer);
    if (!STATE.dirty || STATE.composing) return;
    STATE.syncTimer = setTimeout(() => {
      STATE.syncTimer = null;
      pushOverlayToNative(false);
    }, Math.max(0, Number(delay) || 0));
  }

  async function pushOverlayToNative(force = false) {
    if ((!force && (STATE.syncPaused || STATE.composing)) || STATE.syncingFromNative) return false;
    const overlay = STATE.overlayEditor;
    const native = STATE.nativeEditor;
    if (!overlay || !native) return false;

    if (STATE.applying) {
      STATE.pendingApply = true;
      return false;
    }

    const startedRevision = STATE.editRevision;
    const startedAt = Date.now();
    const next = overlay.getValue();
    const nativeHtmlBefore = native.getValue();
    if (shouldBlockEmptyNativeCommit({ localHtml: next, nativeHtml: nativeHtmlBefore })) {
      STATE.dirty = false;
      STATE.pendingApply = false;
      diagBreadcrumb('sync.empty-blocked', { revision: startedRevision, nativeLength: nativeHtmlBefore.length });
      status('Empty HTML was not sent to MoEngage', 'error');
      return false;
    }
    if (shouldSkipNativeCommit({ localHtml: next, nativeHtml: nativeHtmlBefore })) {
      STATE.dirty = false;
      STATE.pendingApply = false;
      diagBreadcrumb('sync.noop', { revision: startedRevision, reason: 'equivalent-native-html' });
      const pendingRtl = root.__RetKitPendingRtlVerification;
      if (pendingRtl && htmlEquivalentForSync(pendingRtl.html, next)) {
        diagBreadcrumb('rtl.fix.persisted', { ...(pendingRtl.meta || {}), revision: startedRevision, mode: 'already-native' });
        root.__RetKitPendingRtlVerification = null;
      }
      status('Already in sync', 'ok');
      return true;
    }
    diagBreadcrumb('sync.start', { revision: startedRevision, length: next.length, force: Boolean(force) });

    STATE.applying = true;
    STATE.syncingToNative = true;
    const beforeRendered = getRenderedPreviewHtml();
    STATE.renderedBeforeEdit = beforeRendered;
    STATE.awaitingRenderedUpdate = true;
    STATE.localPreviewUntil = Date.now() + 1800;
    status('Applying through MoEngage…', 'neutral');

    try {
      const result = await commitThroughFroala(next);
      const stillCurrent = shouldApplyNativeResult({ startedRevision, currentRevision: STATE.editRevision });

      // The user may keep typing while Froala/React is processing an older
      // revision. Never let the result of that older commit change local state.
      if (!stillCurrent) {
        STATE.pendingApply = true;
        diagBreadcrumb('sync.stale-result', { startedRevision, currentRevision: STATE.editRevision });
        status('Newer local edit waiting to sync…', 'neutral');
        return false;
      }

      if (!result.ok) {
        STATE.dirty = true;
        const reason = result.reason || 'MoEngage rejected the edit';
        const pendingRtl = root.__RetKitPendingRtlVerification;
        if (pendingRtl && htmlEquivalentForSync(pendingRtl.html, next)) {
          diagBreadcrumb('rtl.fix.sync-rejected', { ...(pendingRtl.meta || {}), revision: startedRevision, reason });
        }
        diagIncident('moengage_sync_rejected', reason, { revision: startedRevision, durationMs: Date.now() - startedAt, html: next });
        status(reason, 'error');
        return false;
      }

      STATE.dirty = false;
      STATE.lastAppliedRevision = startedRevision;
      STATE.lastAppliedAt = Date.now();
      const durationMs = STATE.lastAppliedAt - startedAt;
      diagBreadcrumb('sync.done', { revision: startedRevision, durationMs });
      const pendingRtl = root.__RetKitPendingRtlVerification;
      if (pendingRtl && htmlEquivalentForSync(pendingRtl.html, next)) {
        const actualNative = (getNativeEditor() || native)?.getValue?.() || '';
        const persisted = htmlEquivalentForSync(actualNative, pendingRtl.html);
        diagBreadcrumb(persisted ? 'rtl.fix.persisted' : 'rtl.fix.sync-mismatch', { ...(pendingRtl.meta || {}), revision: startedRevision, durationMs });
        if (persisted) root.__RetKitPendingRtlVerification = null;
      }
      if (durationMs > 3500) diagIncident('slow_sync', `MoEngage sync took ${durationMs}ms`, { revision: startedRevision, durationMs, html: next });
      status('Applied to MoEngage', 'ok');

      for (const delay of [250, 700, 1400]) {
        setTimeout(() => refreshPreviewFromMoEngage(false), delay);
      }
      return true;
    } catch (error) {
      STATE.dirty = true;
      console.error('[RetKit] apply failed', error);
      diagIncident('sync_exception', error?.message || String(error), { revision: startedRevision, durationMs: Date.now() - startedAt });
      status(`Apply failed: ${error?.message || error}`, 'error');
      return false;
    } finally {
      STATE.syncingToNative = false;
      STATE.applying = false;
      if (STATE.pendingApply) {
        STATE.pendingApply = false;
        if (STATE.dirty && !STATE.composing) setTimeout(() => pushOverlayToNative(false), 50);
      }
    }
  }

  function pullNativeToOverlay() {
    if (!shouldPullNativeIntoOverlay({
      focused: STATE.overlayFocused,
      dirty: STATE.dirty,
      composing: STATE.composing,
      applying: STATE.applying || STATE.syncingToNative,
      multiLocaleBusy: STATE.multiLocaleBusy,
    })) return;
    const overlay = STATE.overlayEditor;
    const native = STATE.nativeEditor;
    if (!overlay || !native) return;
    const next = beautifyEmailHtml(native.getValue());
    const current = overlay.getValue();
    if (htmlEquivalentForSync(next, current)) return;
    const nextLang = String(next.match(/<html\b[^>]*\blang=["']([^"']+)/i)?.[1] || '').toLowerCase();
    const currentLang = String(current.match(/<html\b[^>]*\blang=["']([^"']+)/i)?.[1] || '').toLowerCase();
    const looksLikeLocaleSwitch = Boolean(nextLang && currentLang && nextLang !== currentLang);
    if (!looksLikeLocaleSwitch && shouldTreatNativeMismatchAsLateRevert({
      sameContent: false,
      lastAppliedRevision: STATE.lastAppliedRevision,
      currentRevision: STATE.editRevision,
      lastAppliedAt: STATE.lastAppliedAt,
      now: Date.now(),
    })) {
      STATE.dirty = true;
      diagIncident('late_native_revert', 'MoEngage changed the HTML shortly after RetKit applied it', { revision: STATE.editRevision, nativeHtml: next, localHtml: current });
      status('MoEngage reverted the latest revision · local code preserved', 'error');
      return;
    }
    STATE.syncingFromNative = true;
    const cursor = overlay.getCursor();
    try {
      overlay.setValue(next);
      overlay.setCursor(cursor);
      STATE.dirty = false;
      scheduleFoldRefresh();
      status('Updated from MoEngage', 'ok');
    } finally {
      setTimeout(() => { STATE.syncingFromNative = false; }, 0);
    }
  }


  function rebindNativeEditorFromMoEngage(options = {}) {
    const overlay = STATE.overlayEditor;
    const nextNative = getNativeEditor();
    if (!overlay || !nextNative) return false;

    if (STATE.nativeEditor && STATE.nativeChangeHandler) {
      try { STATE.nativeEditor.off?.('change', STATE.nativeChangeHandler); } catch {}
    }

    STATE.nativeEditor = nextNative;
    STATE.syncingFromNative = true;
    try {
      const next = beautifyEmailHtml(nextNative.getValue());
      if (overlay.getValue() !== next) {
        const previousCursor = overlay.getCursor?.() || { line: 0, ch: 0 };
        overlay.setValue(next);
        if (options.preserveCursor === true) {
          const lastLine = Math.max(0, overlay.lineCount() - 1);
          const line = Math.min(previousCursor.line || 0, lastLine);
          const ch = Math.min(previousCursor.ch || 0, (overlay.getLine(line) || '').length);
          overlay.setCursor({ line, ch });
        } else {
          overlay.setCursor({ line: 0, ch: 0 });
        }
      }
      STATE.dirty = false;
      STATE.awaitingRenderedUpdate = false;
      STATE.renderedBeforeEdit = '';
      STATE.localPreviewUntil = 0;
      STATE.previewHtml = '';
      clearSearchMarks();
      clearFoldMarks();
      scheduleFoldRefresh();
      scheduleValidation();
      refreshPreviewFromMoEngage(true);
    } finally {
      setTimeout(() => { STATE.syncingFromNative = false; }, 0);
    }

    STATE.nativeChangeHandler = () => {
      if (STATE.syncingToNative) return;
      pullNativeToOverlay();
    };
    nextNative.on?.('change', STATE.nativeChangeHandler);
    nextNative.refresh?.();
    STATE.overlayEditor?.refresh?.();
    scheduleWorkspaceLayoutRefresh();
    status('Updated from MoEngage', 'ok');
    return true;
  }

  function makeFoldMarker(collapsed = false) {
    const marker = document.createElement('div');
    marker.className = 'rk-fold-marker';
    marker.textContent = collapsed ? '▸' : '▾';
    marker.title = collapsed ? 'Expand block' : 'Fold block';
    return marker;
  }

  function clearFoldMarks() {
    const editor = STATE.overlayEditor;
    if (!editor) return;
    for (const [line, item] of STATE.foldMarks.entries()) {
      try { item.mark?.clear?.(); } catch {}
      try { editor.setGutterMarker(line, 'rk-foldgutter', null); } catch {}
    }
    STATE.foldMarks.clear();
  }

  function foldLine(line) {
    const editor = STATE.overlayEditor;
    if (!editor) return;
    const existing = STATE.foldMarks.get(line);
    if (existing?.mark) {
      existing.mark.clear();
      STATE.foldMarks.delete(line);
      refreshFoldGutters();
      return;
    }

    const source = editor.getValue();
    const lineStart = editor.indexFromPos({ line, ch: 0 });
    const lineEnd = editor.indexFromPos({ line, ch: editor.getLine(line).length });
    const range = findFoldRangeForLine(source, lineStart, lineEnd);
    if (!range) return;

    const from = editor.posFromIndex(range.openEnd);
    const to = editor.posFromIndex(range.closeStart);
    if (from.line === to.line) return;

    const widget = document.createElement('span');
    widget.className = 'CodeMirror-foldmarker';
    widget.textContent = ` … </${range.tag}> `;
    widget.title = `Expand <${range.tag}>`;
    const mark = editor.markText(from, to, {
      collapsed: true,
      replacedWith: widget,
      clearOnEnter: false,
    });
    mark.on?.('clear', () => {
      STATE.foldMarks.delete(line);
      refreshFoldGutters();
    });
    STATE.foldMarks.set(line, { mark, tag: range.tag });
    refreshFoldGutters();
  }

  function refreshFoldGutters() {
    const editor = STATE.overlayEditor;
    if (!editor) return;
    const source = editor.getValue();
    for (let line = 0; line < editor.lineCount(); line += 1) {
      const lineStart = editor.indexFromPos({ line, ch: 0 });
      const lineEnd = editor.indexFromPos({ line, ch: editor.getLine(line).length });
      const range = findFoldRangeForLine(source, lineStart, lineEnd);
      if (!range) {
        editor.setGutterMarker(line, 'rk-foldgutter', null);
        continue;
      }
      editor.setGutterMarker(line, 'rk-foldgutter', makeFoldMarker(Boolean(STATE.foldMarks.get(line)?.mark)));
    }
  }

  function scheduleFoldRefresh() {
    clearTimeout(STATE.foldTimer);
    STATE.foldTimer = setTimeout(refreshFoldGutters, 80);
  }

  function attachEditorSync() {
    const overlay = STATE.overlayEditor;
    const native = STATE.nativeEditor;
    if (!overlay || !native) return;

    overlay.on('gutterClick', (_cm, line, gutter) => {
      if (gutter === 'rk-foldgutter') foldLine(line);
    });

    overlay.on('focus', () => { STATE.overlayFocused = true; diagBreadcrumb('editor.focus', { revision: STATE.editRevision }); });
    overlay.on('blur', () => {
      STATE.overlayFocused = false;
      diagBreadcrumb('editor.blur', { revision: STATE.editRevision, dirty: STATE.dirty });
      if (STATE.dirty && !STATE.composing) scheduleNativeSync(40);
    });

    const inputField = overlay.getInputField?.();
    inputField?.addEventListener?.('compositionstart', () => {
      STATE.composing = true;
      diagBreadcrumb('editor.compositionstart', { revision: STATE.editRevision });
      clearTimeout(STATE.syncTimer);
      STATE.syncTimer = null;
    });
    inputField?.addEventListener?.('compositionend', () => {
      STATE.composing = false;
      diagBreadcrumb('editor.compositionend', { revision: STATE.editRevision });
      if (STATE.dirty) scheduleNativeSync();
    });

    overlay.on('change', (_cm, change) => {
      if (STATE.syncingFromNative) return;
      clearTimeout(STATE.syncTimer);
      STATE.syncTimer = null;
      STATE.editRevision = nextEditRevision(STATE.editRevision);
      STATE.dirty = true;
      diagBreadcrumb('editor.change', { revision: STATE.editRevision, origin: change?.origin || '', length: overlay.getValue().length });
      if (STATE.applying) STATE.pendingApply = true;
      scheduleFoldRefresh();
      scheduleValidation();

      const findValue = document.getElementById(IDS.findInput)?.value || '';
      if (findValue) updateSearchHighlights(findValue, -1);

      STATE.renderedBeforeEdit = getRenderedPreviewHtml();
      STATE.awaitingRenderedUpdate = true;
      STATE.localPreviewUntil = Date.now() + 1800;
      scheduleLocalPreview(overlay.getValue());

      if (change?.origin === 'setValue' && !STATE.dirty) return;
      if (!STATE.composing) scheduleNativeSync();
    });

    STATE.nativeChangeHandler = () => {
      pullNativeToOverlay();
    };
    native.on?.('change', STATE.nativeChangeHandler);
    scheduleFoldRefresh();
    scheduleValidation();
  }

  function createOverlayEditor(host, value) {
    if (typeof root.CodeMirror !== 'function') throw new Error('MoEngage CodeMirror constructor is not available');
    const native = STATE.nativeEditor;
    const options = {
      value: beautifyEmailHtml(value),
      lineNumbers: true,
      lineWrapping: STATE.wrap,
      mode: native?.getOption?.('mode') || 'htmlmixed',
      theme: native?.getOption?.('theme') || 'default',
      indentUnit: 2,
      tabSize: 2,
      indentWithTabs: false,
      autofocus: true,
      viewportMargin: 40,
      gutters: ['CodeMirror-linenumbers', 'rk-foldgutter'],
      extraKeys: {
        'Cmd-F': () => openFindBar(),
        'Ctrl-F': () => openFindBar(),
        'Cmd-Alt-F': () => openFindBar(),
        'Ctrl-H': () => openFindBar(),
      },
    };
    const editor = root.CodeMirror(host, options);
    editor.setSize('100%', '100%');
    return editor;
  }

  function buildWorkspaceBody(workspace) {
    const split = document.createElement('div');
    split.id = IDS.split;
    split.style.setProperty('--rk-left', `${STATE.splitPercent}%`);

    const editorPane = document.createElement('section');
    editorPane.id = IDS.editorPane;
    editorPane.innerHTML = '<div class="rk-pane-head"><strong>HTML</strong><span>Beautified working copy</span><span class="rk-kbd">⌘F Find / Replace · gutter arrows fold blocks</span></div>';
    buildFindBar(editorPane);
    const sourceHost = document.createElement('div');
    sourceHost.id = IDS.sourceHost;
    editorPane.appendChild(sourceHost);

    // RetKit AI is optional. The ordinary editor remains fully usable if the
    // AI module/bridge is absent. The AI module moves sourceHost into its own
    // vertically resizable stack without recreating CodeMirror.
    root.__RetKitAiUi?.mountAiPanel?.({
      getWorkspaceElement: () => workspace,
      getEditorPaneElement: () => editorPane,
      getSourceHostElement: () => sourceHost,
      refreshEditorLayout: () => scheduleWorkspaceLayoutRefresh(),
    });

    const grip = document.createElement('div');
    grip.className = 'rk-grip';
    let dragging = false;
    grip.addEventListener('pointerdown', (event) => {
      dragging = true;
      grip.setPointerCapture(event.pointerId);
    });
    grip.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const rect = split.getBoundingClientRect();
      setSplitPercent(((event.clientX - rect.left) / rect.width) * 100);
    });
    grip.addEventListener('pointerup', () => { dragging = false; scheduleWorkspaceLayoutRefresh(); });
    grip.addEventListener('pointercancel', () => { dragging = false; scheduleWorkspaceLayoutRefresh(); });

    const previewPane = document.createElement('section');
    previewPane.id = IDS.previewPane;
    const previewHead = document.createElement('div');
    previewHead.className = 'rk-pane-head';
    previewHead.innerHTML = '<strong>Preview</strong><span>Rendered by MoEngage</span><span>Click an element to jump to its HTML</span><span class="rk-pane-spacer"></span>';
    const desktopIcon = makePreviewModeButton('desktop', 'Desktop preview');
    desktopIcon.dataset.rkPreviewMode = 'desktop';
    const mobileIcon = makePreviewModeButton('mobile', 'Mobile preview');
    mobileIcon.dataset.rkPreviewMode = 'mobile';
    previewHead.append(desktopIcon, mobileIcon);
    previewPane.appendChild(previewHead);
    const canvas = document.createElement('div');
    canvas.id = IDS.previewCanvas;
    const shell = document.createElement('div');
    shell.className = 'rk-preview-shell';
    shell.dataset.mode = STATE.previewMode;
    const frame = document.createElement('iframe');
    frame.id = IDS.previewFrame;
    // Same-origin so RetKit can read/patch the preview DOM; no allow-scripts so
    // email HTML never executes code with MoEngage dashboard privileges.
    frame.setAttribute('sandbox', 'allow-same-origin');
    shell.appendChild(frame);
    canvas.appendChild(shell);
    previewPane.appendChild(canvas);
    updatePreviewModeButtons();

    split.append(editorPane, grip, previewPane);
    workspace.appendChild(split);

    STATE.overlayEditor = createOverlayEditor(sourceHost, STATE.nativeEditor.getValue());
    attachEditorSync();
    if (getRenderedPreviewHtml()) {
      refreshPreviewFromMoEngage(true);
    } else {
      applyPreviewHtml(STATE.overlayEditor.getValue(), true);
      status('Native preview unavailable · showing local HTML preview', 'neutral');
    }

    STATE.pollTimer = setInterval(() => {
      if (document.hidden || !document.getElementById(IDS.workspace)) return;
      refreshPreviewFromMoEngage(false);
    }, 500);
  }

  function openWorkspace() {
    if (document.getElementById(IDS.workspace)) return;
    const native = getNativeEditor();
    const rendered = getRenderedPreviewHtml();
    const readiness = previewReadinessAction({ native: Boolean(native), rendered: Boolean(rendered) });
    if (!readiness.open) {
      diagIncident('native_editor_missing', 'MoEngage CodeMirror editor was not found', {});
      alert('RetKit: MoEngage CodeMirror editor was not found.');
      return;
    }
    if (readiness.mode === 'local-fallback') {
      diagIncident('preview_not_ready', 'MoEngage preview was not ready; RetKit opened with local HTML preview', { html: native?.getValue?.() || '' });
    }

    STATE.nativeEditor = native;
    STATE.previewHtml = '';
    STATE.previewPendingHtml = '';
    STATE.previewLastValidHtml = '';
    clearTimeout(STATE.previewTimer);
    STATE.previewTimer = null;
    STATE.syncPaused = false;
    STATE.dirty = false;
    STATE.applying = false;
    STATE.pendingApply = false;
    STATE.editRevision = 0;
    STATE.lastAppliedRevision = 0;
    STATE.lastAppliedAt = 0;
    STATE.composing = false;
    STATE.overlayFocused = false;
    STATE.awaitingRenderedUpdate = false;
    STATE.renderedBeforeEdit = '';
    STATE.localPreviewUntil = 0;

    const workspace = document.createElement('div');
    workspace.id = IDS.workspace;
    buildToolbar(workspace);
    document.body.appendChild(workspace);
    try {
      buildWorkspaceBody(workspace);
      document.body.style.overflow = 'hidden';
      status('Loaded from MoEngage', 'ok');
    } catch (error) {
      console.error('[RetKit] workspace failed', error);
      workspace.remove();
      alert(`RetKit: ${error.message || error}`);
    }
  }

  function closeWorkspace() {
    if (STATE.dirty) pushOverlayToNative(true);
    if (STATE.pollTimer) clearInterval(STATE.pollTimer);
    if (STATE.syncTimer) clearTimeout(STATE.syncTimer);
    if (STATE.foldTimer) clearTimeout(STATE.foldTimer);
    if (STATE.validatorTimer) clearTimeout(STATE.validatorTimer);
    if (STATE.previewTimer) clearTimeout(STATE.previewTimer);
    if (STATE.layoutRefreshTimer) clearTimeout(STATE.layoutRefreshTimer);
    if (STATE.nativeEditor && STATE.nativeChangeHandler) {
      try { STATE.nativeEditor.off?.('change', STATE.nativeChangeHandler); } catch {}
    }
    STATE.pollTimer = null;
    STATE.syncTimer = null;
    STATE.foldTimer = null;
    STATE.validatorTimer = null;
    STATE.previewTimer = null;
    STATE.layoutRefreshTimer = null;
    clearSearchMarks();
    clearFoldMarks();
    closeFloatingPopovers();
    document.getElementById(IDS.multiLocaleDrawer)?.remove();
    STATE.nativeChangeHandler = null;
    STATE.overlayEditor = null;
    STATE.previewElement = null;
    document.getElementById(IDS.workspace)?.remove();
    document.body.style.overflow = '';
    STATE.nativeEditor?.refresh?.();
    STATE.nativeEditor = null;
  }

  async function aiSetHtml(nextHtml) {
    const editor = STATE.overlayEditor;
    if (!editor) return false;
    const next = String(nextHtml ?? '');
    STATE.syncingFromNative = true;
    try {
      editor.setValue(next);
      STATE.dirty = true;
      applyPreviewHtml(next, true);
      scheduleFoldRefresh();
      scheduleValidation();
    } finally {
      STATE.syncingFromNative = false;
    }
    const result = await pushOverlayToNative(true);
    return result !== false;
  }

  function aiGetSelectedSource() {
    const editor = STATE.overlayEditor;
    if (!editor) return null;
    try {
      const from = editor.getCursor('from');
      const to = editor.getCursor('to');
      const text = editor.getRange(from, to);
      if (!text) return null;
      return { text, from: editor.indexFromPos(from), to: editor.indexFromPos(to) };
    } catch { return null; }
  }

  function aiGetPreviewDom(maxChars = 120000) {
    const frame = document.getElementById(IDS.previewFrame);
    let html = '';
    try { html = frame?.contentDocument?.documentElement?.outerHTML || frame?.srcdoc || ''; } catch { html = frame?.srcdoc || ''; }
    const cap = Math.max(1000, Math.min(500000, Number(maxChars) || 120000));
    return html.length > cap ? `${html.slice(0, cap)}\n<!-- RetKit AI preview truncated -->` : html;
  }

  async function aiGetPreviewScreenshot() {
    // A userscript cannot reliably rasterize an arbitrary email DOM containing
    // cross-origin images without tainting a canvas. User drag/drop screenshots
    // are fully supported; this explicit result prevents the agent from assuming
    // it received pixels when it did not.
    return { supported: false, reason: 'Automatic preview screenshot capture is unavailable for cross-origin email assets; attach or paste a screenshot into RetKit AI.' };
  }

  // Models use the same ⌘F → Across locales flow as people: RetKit fills the
  // find bar, scans every locale and shows the chips. Writing stays a user click.
  async function aiAcrossLocales({ query = '', replacement, mode = 'text', perLocale = null } = {}) {
    const text = String(query || '');
    if (!text) throw new Error('query is empty');
    if (!document.getElementById(IDS.findBar)?.classList.contains('rk-open')) openFindBar();
    const find = document.getElementById(IDS.findInput);
    const replace = document.getElementById(IDS.replaceInput);
    if (find) find.value = text;
    if (replace && replacement !== undefined) replace.value = String(replacement ?? '');
    updateSearchHighlights(text, -1);
    renderMultiLocaleDrawer(true);
    const toggle = document.getElementById(IDS.multiLocaleModeToggle);
    if (toggle) toggle.checked = mode === 'filename' && Boolean(replaceCore()?.looksLikeImage?.(text));
    clearTimeout(STATE.multiLocaleAutoScanTimer);
    for (let i = 0; i < 100 && STATE.multiLocaleBusy; i += 1) await sleep(150);
    await scanMultiLocaleReplace();
    if (perLocale && typeof perLocale === 'object') {
      STATE.multiLocaleOverrides = {};
      for (const [locale, value] of Object.entries(perLocale)) STATE.multiLocaleOverrides[String(locale).toUpperCase()] = String(value ?? '');
      STATE.multiLocaleOverridesQuery = text;
      renderMultiLocalePlanRows();
    }
    const summary = summarizeLocaleReplacePlan(STATE.multiLocalePlan);
    return {
      overrides: { ...STATE.multiLocaleOverrides },
      query: text,
      mode: multiLocaleMode(),
      ...summary,
      locales: STATE.multiLocalePlan.map((item) => ({
        locale: item.locale,
        count: item.count,
        hits: (item.hits || []).slice(0, 3).map((hit) => ({ kind: hit.kind, context: `${String(hit.before).slice(-30)}[[${hit.match}]]${String(hit.after).slice(0, 30)}` })),
      })),
      imageModeAvailable: Boolean(replaceCore()?.looksLikeImage?.(text)),
      error: STATE.multiLocaleScanError || undefined,
    };
  }

  root.__RetKitAiWorkspaceApi = {
    acrossLocales: aiAcrossLocales,
    getCurrentHtml: () => STATE.overlayEditor?.getValue?.() || '',
    setHtml: aiSetHtml,
    getSelectedSource: aiGetSelectedSource,
    getValidatorIssues: () => (STATE.validatorIssues || []).map((issue) => ({ ...issue })),
    getPreviewDom: aiGetPreviewDom,
    getPreviewScreenshot: aiGetPreviewScreenshot,
    getPreviewMode: () => STATE.previewMode,
    getEmailIdentity,
    getSubject: () => root.__RetKitMoEngageBridgeApi?.getSubject?.() || '',
    setSubject: (value) => root.__RetKitMoEngageBridgeApi?.setSubject?.(value) || false,
    getActiveLocale: () => root.__RetKitMoEngageBridgeApi?.getActiveLocale?.() || '',
    listLocales: () => root.__RetKitMoEngageBridgeApi?.listLocales?.() || [],
    listAvailableLocales: () => root.__RetKitMoEngageBridgeApi?.listAvailableLocales?.() || [],
    addLocales: (locales) => root.__RetKitMoEngageBridgeApi?.addLocales?.(locales) || { ok: false, reason: 'MoEngage locale bridge unavailable' },
    removeLocale: (locale) => root.__RetKitMoEngageBridgeApi?.removeLocale?.(locale) || { ok: false, reason: 'MoEngage locale bridge unavailable' },
    getLocaleHtml: (locale) => root.__RetKitMoEngageBridgeApi?.getLocaleHtml?.(locale) || '',
    setLocaleHtml: (locale, html, options) => root.__RetKitMoEngageBridgeApi?.setLocaleHtml?.(locale, html, options) || { ok: false, reason: 'MoEngage locale bridge unavailable' },
    switchLocale: (locale) => root.__RetKitMoEngageBridgeApi?.switchLocale?.(locale) || false,
  };

  function installKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
      const workspace = document.getElementById(IDS.workspace);
      if (!workspace) return;
      const key = event.key.toLowerCase();

      if (event.metaKey && event.altKey && key === 'f') {
        event.preventDefault();
        event.stopPropagation();
        openFindBar(true);
        return;
      }
      if (event.ctrlKey && key === 'h') {
        event.preventDefault();
        event.stopPropagation();
        openFindBar(true);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && key === 'f') {
        event.preventDefault();
        event.stopPropagation();
        openFindBar(false);
        return;
      }
      if (event.key === 'Escape' && event.shiftKey) {
        closeWorkspace();
      }
    }, true);
  }

  function boot() {
    injectStyle();
    installKeyboardShortcuts();
    root.addEventListener?.('resize', scheduleWorkspaceLayoutRefresh);
    STATE.launcherRoute = currentRouteKey();
    syncLauncherPresence();
    STATE.launcherTimer = root.setInterval?.(syncLauncherPresence, 800) || null;
    root.addEventListener?.('popstate', syncLauncherPresence);
    root.addEventListener?.('hashchange', syncLauncherPresence);
    root.addEventListener?.('beforeunload', () => {
      if (STATE.launcherTimer) root.clearInterval?.(STATE.launcherTimer);
    }, { once: true });
    console.log('[RetKit] MoEngage workspace v0.8.1 loaded');
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);

/*! RetKit replace-across — one smart find/replace core for every RetKit tool
 *  (RetKit for MoEngage, Retention Future Studio, model tools).
 *  Pure logic, no DOM. Source of truth: retkit-moeng/src/shared/replace-across.js
 *
 *  Modes:
 *   - 'text'     : literal text, but & and &amp; are the same (and the
 *                  replacement keeps the encoding of what it replaces);
 *   - 'filename' : for images/files — finds every URL that ends with the same
 *                  file name (icon1.png) even if each locale uploaded it to a
 *                  different path, and replaces the whole URL.
 */
(function (root) {
  'use strict';

  const MAX_HITS = 20;
  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const encodeAmp = (s) => String(s).replace(/&(?!(?:amp|lt|gt|quot|apos|#39|#\d+|#x[0-9a-f]+);)/gi, '&amp;');
  const decodeAmp = (s) => String(s).replace(/&amp;/gi, '&');
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;

  function fileNameOf(value) {
    const text = String(value || '').trim().split(/[?#]/)[0];
    const name = text.split('/').pop() || '';
    return /\.[a-z0-9]{2,5}$/i.test(name) ? name : '';
  }

  // Can the filename mode help? (the query is an image URL or an image file name)
  function looksLikeImage(find) {
    return IMAGE_EXT.test(fileNameOf(find));
  }

  function variants(find) {
    const needle = String(find || '');
    if (!needle) return [];
    const list = [
      { needle, encode: (r) => r },
      { needle: encodeAmp(needle), encode: encodeAmp },
      { needle: decodeAmp(needle), encode: decodeAmp },
    ];
    const seen = new Set();
    return list.filter((v) => v.needle && !seen.has(v.needle) && seen.add(v.needle))
      .sort((a, b) => b.needle.length - a.needle.length);
  }

  // Returns { re, encodeFor(hit) } or null.
  function compile(find, mode = 'text') {
    if (mode === 'filename') {
      const name = fileNameOf(find);
      if (!name) return null;
      const re = new RegExp(`(?:https?:)?//[^\\s"'()<>]*?/${escapeRegExp(name)}(?:[?#][^\\s"'()<>]*)?(?=[\\s"'()<>]|$)`, 'gi');
      return { re, encodeFor: (hit) => (/&amp;/i.test(hit) ? encodeAmp : (r) => r) };
    }
    const vs = variants(find);
    if (!vs.length) return null;
    const byNeedle = new Map(vs.map((v) => [v.needle, v.encode]));
    return { re: new RegExp(vs.map((v) => escapeRegExp(v.needle)).join('|'), 'g'), encodeFor: (hit) => byNeedle.get(hit) || ((r) => r) };
  }

  function kindAt(text, index) {
    const before = text.slice(Math.max(0, index - 60), index).toLowerCase();
    if (/\bsrc(?:set)?\s*=\s*["']?[^"'>]*$/.test(before)) return 'image';
    if (/url\(\s*["']?[^)"']*$/.test(before)) return 'background';
    if (/\bhref\s*=\s*["']?[^"'>]*$/.test(before)) return 'link';
    if (/<[^>]*$/.test(before)) return 'attribute';
    return 'text';
  }

  // { count, hits: [{ index, match, kind, before, after }] }
  function scan(text, find, options = {}) {
    const source = String(text ?? '');
    const compiled = compile(find, options.mode);
    const out = { count: 0, hits: [] };
    if (!compiled) return out;
    const radius = Number(options.radius) || 40;
    for (const m of source.matchAll(compiled.re)) {
      out.count += 1;
      if (out.hits.length < (options.maxHits || MAX_HITS)) {
        out.hits.push({
          index: m.index,
          match: m[0],
          kind: kindAt(source, m.index),
          before: source.slice(Math.max(0, m.index - radius), m.index),
          after: source.slice(m.index + m[0].length, m.index + m[0].length + radius),
        });
      }
    }
    return out;
  }

  function countIn(text, find, options = {}) {
    const compiled = compile(find, options.mode);
    if (!compiled) return 0;
    return (String(text ?? '').match(compiled.re) || []).length;
  }

  // Single pass: a replacement that contains the needle is never re-matched.
  function replaceIn(text, find, replacement, options = {}) {
    const source = String(text ?? '');
    const compiled = compile(find, options.mode);
    if (!compiled) return { value: source, count: 0 };
    let count = 0;
    const value = source.replace(compiled.re, (hit) => {
      count += 1;
      return compiled.encodeFor(hit)(String(replacement ?? ''));
    });
    return { value, count };
  }

  // ── Studio shape: code + namespaces { id, name, builtin?, locales: { code: [blocks] } } ──
  function plan({ code = '', namespaces = [], find = '', mode = 'text' } = {}) {
    const result = { find: String(find || ''), mode, code: null, locales: [], total: 0, editableTotal: 0 };
    if (!result.find) return result;
    const codeScan = scan(code, find, { mode });
    result.code = { count: codeScan.count, hits: codeScan.hits };
    result.total += codeScan.count;
    result.editableTotal += codeScan.count;
    for (const ns of namespaces || []) {
      if (!ns || !ns.locales) continue;
      for (const [locale, blocks] of Object.entries(ns.locales)) {
        const list = Array.isArray(blocks) ? blocks : [];
        let count = 0;
        const hits = [];
        const blockIndexes = [];
        list.forEach((block, index) => {
          const s = scan(block, find, { mode, maxHits: 5 });
          if (!s.count) return;
          count += s.count;
          blockIndexes.push(index);
          for (const hit of s.hits) if (hits.length < 5) hits.push({ ...hit, block: index });
        });
        if (!count) continue;
        const locked = Boolean(ns.builtin);
        result.locales.push({ nsId: ns.id, nsName: ns.name, locale, count, blockIndexes, hits, locked });
        result.total += count;
        if (!locked) result.editableTotal += count;
      }
    }
    result.locales.sort((a, b) => (a.nsName === b.nsName ? a.locale.localeCompare(b.locale) : a.nsName.localeCompare(b.nsName)));
    return result;
  }

  // selection: { code: bool, locales: Set|Array of 'nsId|locale' }
  // replacements: optional own value per place: { code: '…', 'nsId|locale': '…' }
  function apply({ code = '', namespaces = [], find = '', replacement = '', mode = 'text', selection = {}, replacements = null } = {}) {
    const out = { code, codeCount: 0, patches: [], undo: { code, locales: [] }, total: 0 };
    const own = replacements && typeof replacements === 'object' ? replacements : {};
    const valueFor = (key) => (Object.prototype.hasOwnProperty.call(own, key) ? String(own[key]) : replacement);
    if (selection.code) {
      const r = replaceIn(code, find, valueFor('code'), { mode });
      out.code = r.value;
      out.codeCount = r.count;
      out.total += r.count;
    }
    const wanted = selection.locales instanceof Set ? selection.locales : new Set(selection.locales || []);
    for (const ns of namespaces || []) {
      if (!ns || ns.builtin || !ns.locales) continue;
      for (const [locale, blocks] of Object.entries(ns.locales)) {
        if (!wanted.has(`${ns.id}|${locale}`)) continue;
        const before = Array.isArray(blocks) ? blocks.slice() : [];
        let count = 0;
        const value = valueFor(`${ns.id}|${locale}`);
        const after = before.map((block) => {
          const r = replaceIn(block, find, value, { mode });
          count += r.count;
          return r.value;
        });
        if (!count) continue;
        out.patches.push({ nsId: ns.id, locale, blocks: after, count });
        out.undo.locales.push({ nsId: ns.id, locale, blocks: before });
        out.total += count;
      }
    }
    return out;
  }

  // ── MoEngage shape: { LOCALE: html } ──
  function planLocales(htmlByLocale = {}, find = '', options = {}) {
    return Object.entries(htmlByLocale || {}).map(([locale, html]) => {
      const s = scan(html, find, { mode: options.mode, maxHits: 5 });
      return { locale, count: s.count, hits: s.hits };
    });
  }

  root.RetKitReplaceAcross = {
    version: 2, MAX_HITS, fileNameOf, looksLikeImage, variants, scan, countIn, replaceIn, plan, apply, planLocales,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

(function (root) {
  'use strict';

  // "Original" snapshots: the first version of an email RetKit saw for a
  // campaign + locale, captured right before RetKit's first write. Lets the
  // user return to it with one click. Stored in IndexedDB (never in MoEngage's
  // own localStorage) and pruned automatically: unused snapshots expire, and
  // the store has a size cap. HTML never leaves the browser.

  const DB_NAME = 'retkit-originals';
  const STORE = 'snapshots';
  const DEFAULT_LIMITS = Object.freeze({
    ttlMs: 14 * 24 * 60 * 60 * 1000, // forgotten after 14 days without use
    maxEntries: 300,
    maxBytes: 40 * 1024 * 1024,
  });

  // MoEngage campaign URLs carry a 24-hex id; prefer it so wizard steps and
  // query noise do not split one campaign into several keys.
  function campaignKeyFromUrl(href) {
    const text = String(href || '');
    const id = text.match(/\b[0-9a-f]{24}\b/i);
    if (id) return `campaign:${id[0].toLowerCase()}`;
    try {
      const url = new URL(text);
      return `path:${url.pathname}${url.search}${url.hash}`;
    } catch {
      return `path:${text}`;
    }
  }

  function snapshotKey(campaign, locale) {
    return `${campaign}|${String(locale || 'default').toUpperCase()}`;
  }

  function byteLength(value) {
    const text = String(value || '');
    try { return new TextEncoder().encode(text).length; } catch { return text.length; }
  }

  // Pure: which keys to delete. Expired first, then least recently used until
  // both caps hold. `protectKey` (the one in use right now) is never evicted.
  function planPrune(entries, now, limits = DEFAULT_LIMITS, protectKey = '') {
    const list = [...(entries || [])].sort((a, b) => (a.lastSeenAt || 0) - (b.lastSeenAt || 0));
    const remove = new Set();
    for (const entry of list) {
      if (entry.key !== protectKey && now - (entry.lastSeenAt || entry.capturedAt || 0) > limits.ttlMs) remove.add(entry.key);
    }
    const kept = list.filter((entry) => !remove.has(entry.key));
    let bytes = kept.reduce((sum, entry) => sum + (entry.bytes || 0), 0);
    let count = kept.length;
    for (const entry of kept) {
      if (count <= limits.maxEntries && bytes <= limits.maxBytes) break;
      if (entry.key === protectKey) continue;
      remove.add(entry.key);
      bytes -= entry.bytes || 0;
      count -= 1;
    }
    return [...remove];
  }

  function memoryBackend() {
    const map = new Map();
    return {
      async get(key) { return map.has(key) ? { ...map.get(key) } : null; },
      async put(entry) { map.set(entry.key, { ...entry }); },
      async delete(key) { map.delete(key); },
      async all() { return [...map.values()].map((entry) => ({ ...entry })); },
    };
  }

  function indexedDbBackend(idb = root.indexedDB) {
    if (!idb) return null;
    let opening = null;
    const open = () => {
      opening = opening || new Promise((resolve, reject) => {
        const request = idb.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return opening;
    };
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    };
    return {
      get: (key) => run('readonly', (store) => store.get(key)).then((value) => value || null),
      put: (entry) => run('readwrite', (store) => store.put(entry)),
      delete: (key) => run('readwrite', (store) => store.delete(key)),
      all: () => run('readonly', (store) => store.getAll()).then((value) => value || []),
    };
  }

  function createStore(options = {}) {
    const backend = options.backend || indexedDbBackend(options.indexedDB) || memoryBackend();
    const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
    const now = options.now || (() => Date.now());
    const version = String(options.version || '');
    const pendingCaptures = new Map();

    // Keep only the first version: an existing snapshot is never overwritten.
    async function captureIfMissing({ campaign, locale, html }) {
      const value = String(html ?? '');
      if (!campaign || !value.trim()) return { captured: false, reason: 'empty' };
      const key = snapshotKey(campaign, locale);
      if (pendingCaptures.has(key)) return pendingCaptures.get(key);
      const job = (async () => {
        const existing = await backend.get(key);
        if (existing) {
          existing.lastSeenAt = now();
          await backend.put(existing);
          return { captured: false, reason: 'exists', entry: existing };
        }
        const entry = {
          key, campaign, locale: String(locale || 'default').toUpperCase(), html: value,
          bytes: byteLength(value), capturedAt: now(), lastSeenAt: now(), version,
        };
        await backend.put(entry);
        await prune(key);
        return { captured: true, entry };
      })().finally(() => pendingCaptures.delete(key));
      pendingCaptures.set(key, job);
      return job;
    }

    async function get(campaign, locale) {
      const entry = await backend.get(snapshotKey(campaign, locale));
      if (entry) {
        entry.lastSeenAt = now();
        await backend.put(entry);
      }
      return entry;
    }

    async function discard(campaign, locale) {
      await backend.delete(snapshotKey(campaign, locale));
    }

    async function prune(protectKey = '') {
      const entries = await backend.all();
      const remove = planPrune(entries, now(), limits, protectKey);
      for (const key of remove) await backend.delete(key);
      return remove;
    }

    async function stats() {
      const entries = await backend.all();
      return { count: entries.length, bytes: entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0) };
    }

    return { captureIfMissing, get, discard, prune, stats, limits };
  }

  const api = {
    DEFAULT_LIMITS, campaignKeyFromUrl, snapshotKey, planPrune, createStore, memoryBackend,
    store: null,
    // Set by the MoEngage bridge: returns { campaign, locale } for the open email.
    contextProvider: null,
    // Called by the core right before RetKit writes HTML into MoEngage.
    captureBeforeCommit(html, options = {}) {
      try {
        const store = api.store;
        if (!store) return null;
        const context = api.contextProvider ? api.contextProvider() : null;
        const campaign = context?.campaign || '';
        const locale = options.locale || context?.locale || '';
        if (!campaign) return null;
        return store.captureIfMissing({ campaign, locale, html })
          .then((result) => { try { api.onChange?.(); } catch {} return result; })
          .catch(() => null);
      } catch {
        return null;
      }
    },
    onChange: null,
    // Restore hands the exact original bytes to the next commit, so MoEngage
    // gets the author's original formatting back rather than a re-indent.
    pendingExactRestore: null,
    takeExactRestore(next, equivalent) {
      const pending = api.pendingExactRestore;
      if (!pending) return null;
      if (Date.now() - (pending.at || 0) > 60000) { api.pendingExactRestore = null; return null; }
      try {
        if (typeof equivalent === 'function' && equivalent(next, pending.html)) {
          api.pendingExactRestore = null;
          return pending.html;
        }
      } catch {}
      return null;
    },
  };

  root.__RetKitOriginals = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

(function (root) {
  'use strict';

  // RetKit AI Workbench browser/bridge protocol.
  const PROTOCOL_VERSION = 1;
  const BRIDGE_WS_URL = 'ws://127.0.0.1:43118/ws';
  const BRIDGE_HTTP_URL = 'http://127.0.0.1:43118';
  const CLIENT_TYPES = new Set([
    'hello', 'provider.connect', 'provider.disconnect', 'provider.select',
    'chat.send', 'chat.cancel', 'tool.result', 'proposal.apply', 'proposal.cancel',
  ]);

  function makeClientMessage(type, payload = {}) {
    if (!CLIENT_TYPES.has(type)) throw new Error(`Unknown RetKit AI client message: ${type}`);
    return { type, protocol: PROTOCOL_VERSION, ...payload };
  }

  function isBridgeEvent(value) {
    return Boolean(value && typeof value === 'object' && typeof value.type === 'string');
  }

  root.__RetKitAiProtocol = {
    PROTOCOL_VERSION,
    BRIDGE_WS_URL,
    BRIDGE_HTTP_URL,
    makeClientMessage,
    isBridgeEvent,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

(function (root) {
  'use strict';

  function nextConnectionState(current, event, detail = null) {
    const status = typeof current === 'string' ? current : current?.status || 'offline';
    if (event === 'connect') return { status: 'connecting' };
    if (event === 'open') return { status: 'connected' };
    if (event === 'close') return { status: 'offline' };
    if (event === 'error') return { status: 'error', ...(detail ? { detail: String(detail) } : {}) };
    return { status };
  }

  function reconnectDelay(attempt) {
    return Math.min(8000, 1000 * (2 ** Math.max(0, Number(attempt) || 0)));
  }

  function shouldRecordBridgeFailure(hadSuccessfulConnection, status) {
    return Boolean(hadSuccessfulConnection) && String(status || '') === 'error';
  }

  root.__RetKitAiBridgeCore = { nextConnectionState, reconnectDelay, shouldRecordBridgeFailure };

  const protocol = root.__RetKitAiProtocol;
  if (!protocol) return;

  function createBridgeClient(options = {}) {
    const listeners = new Set();
    const stateListeners = new Set();
    let socket = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let desired = false;
    let state = { status: 'offline' };
    let sessionSecret = '';
    let bridgeSessionId = '';
    let hadSuccessfulConnection = false;

    const wsUrl = options.wsUrl || protocol.BRIDGE_WS_URL;
    const httpUrl = options.httpUrl || protocol.BRIDGE_HTTP_URL;
    const workspaceId = options.workspaceId || `rk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    function notifyState(next) {
      state = next;
      if (shouldRecordBridgeFailure(hadSuccessfulConnection, next?.status)) {
        try { root.__RetKitDiagnostics?.incident?.('ai_bridge_error', next.detail || 'AI bridge connection error', { status: next.status }); } catch {}
      }
      for (const listener of stateListeners) {
        try { listener({ ...state }); } catch (error) { console.error('[RetKit AI] state listener failed', error); }
      }
    }

    function emit(event) {
      if (!protocol.isBridgeEvent(event)) return;
      if (event.type === 'bridge.error') {
        try { root.__RetKitDiagnostics?.incident?.('ai_bridge_event_error', event.message || event.code || 'Bridge error', { code: event.code || '', requestType: event.requestType || '' }); } catch {}
      }
      if (event.type === 'bridge.ready') {
        sessionSecret = String(event.sessionSecret || '');
        bridgeSessionId = String(event.sessionId || '');
      }
      for (const listener of listeners) {
        try { listener(event); } catch (error) { console.error('[RetKit AI] event listener failed', error); }
      }
    }

    function clearReconnect() {
      if (reconnectTimer) root.clearTimeout?.(reconnectTimer);
      reconnectTimer = null;
    }

    function scheduleReconnect() {
      if (!desired || reconnectTimer) return;
      const delay = reconnectDelay(reconnectAttempt++);
      reconnectTimer = root.setTimeout?.(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function connect() {
      desired = true;
      clearReconnect();
      if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
      if (typeof root.WebSocket !== 'function') {
        notifyState(nextConnectionState(state, 'error', 'WebSocket unavailable'));
        scheduleReconnect();
        return;
      }
      notifyState(nextConnectionState(state, 'connect'));
      try {
        socket = new root.WebSocket(wsUrl);
      } catch (error) {
        notifyState(nextConnectionState(state, 'error', error?.message || error));
        scheduleReconnect();
        return;
      }
      socket.addEventListener('open', () => {
        reconnectAttempt = 0;
        hadSuccessfulConnection = true;
        notifyState(nextConnectionState(state, 'open'));
        const hello = protocol.makeClientMessage('hello', {
          workspaceId,
          page: String(root.location?.href || ''),
          clientVersion: '0.8.1',
        });
        socket.send(JSON.stringify(hello));
      });
      socket.addEventListener('message', (message) => {
        try { emit(JSON.parse(String(message.data || ''))); } catch (error) { emit({ type: 'bridge.error', code: 'BAD_JSON', message: String(error?.message || error) }); }
      });
      socket.addEventListener('error', () => {
        notifyState(nextConnectionState(state, 'error', 'Bridge connection error'));
      });
      socket.addEventListener('close', () => {
        socket = null;
        sessionSecret = '';
        bridgeSessionId = '';
        notifyState(nextConnectionState(state, 'close'));
        scheduleReconnect();
      });
    }

    function disconnect() {
      desired = false;
      clearReconnect();
      try { socket?.close?.(); } catch {}
      socket = null;
      sessionSecret = '';
      bridgeSessionId = '';
      notifyState({ status: 'offline' });
    }

    function send(type, payload = {}) {
      if (!socket || socket.readyState !== 1 || state.status !== 'connected') {
        return Promise.reject(new Error('Bridge offline'));
      }
      const message = protocol.makeClientMessage(type, payload);
      socket.send(JSON.stringify(message));
      return Promise.resolve(message);
    }

    async function uploadAttachment(file) {
      if (state.status !== 'connected' || !sessionSecret) throw new Error('Bridge offline');
      if (typeof root.fetch !== 'function') throw new Error('Fetch unavailable');
      const response = await root.fetch(`${httpUrl}/attachments`, {
        method: 'POST',
        headers: {
          'Content-Type': file?.type || 'application/octet-stream',
          'X-RetKit-Session': sessionSecret,
          'X-RetKit-Name': encodeURIComponent(file?.name || 'attachment'),
        },
        body: file,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.message || `Attachment upload failed (${response.status})`);
      return data;
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function subscribeState(listener) {
      stateListeners.add(listener);
      try { listener({ ...state }); } catch {}
      return () => stateListeners.delete(listener);
    }

    function getState() {
      return { ...state, sessionSecret: Boolean(sessionSecret), sessionId: bridgeSessionId, workspaceId };
    }

    return { connect, disconnect, send, uploadAttachment, subscribe, subscribeState, getState };
  }

  root.__RetKitAiBridge = { createBridgeClient };
})(typeof globalThis !== 'undefined' ? globalThis : this);

(function (root) {
  'use strict';

  function stableHash(value) {
    const input = String(value ?? '');
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${(hash >>> 0).toString(36)}:${input.length}`;
  }

  async function resolve(value) {
    return await Promise.resolve(typeof value === 'function' ? value() : value);
  }

  async function buildInitialContext(api = {}) {
    const [currentHtml, subject, activeLocale, locales, selectedSource, issues, previewMode] = await Promise.all([
      resolve(api.getCurrentHtml || ''),
      resolve(api.getSubject || ''),
      resolve(api.getActiveLocale || ''),
      resolve(api.listLocales || []),
      resolve(api.getSelectedSource || null),
      resolve(api.getValidatorIssues || []),
      resolve(api.getPreviewMode || 'desktop'),
    ]);
    const normalizedIssues = Array.isArray(issues) ? issues : [];
    return {
      activeLocale: String(activeLocale || ''),
      subject: String(subject || ''),
      currentHtml: String(currentHtml || ''),
      currentHtmlHash: stableHash(currentHtml),
      locales: Array.isArray(locales) ? locales.map(String) : [],
      selectedSource: selectedSource || null,
      validator: {
        count: normalizedIssues.length,
        issues: normalizedIssues.slice(0, 50).map((issue) => ({
          severity: issue?.severity || 'warning', code: issue?.code || '', line: Number(issue?.line || 0), message: String(issue?.message || ''),
        })),
      },
      previewMode: String(previewMode || 'desktop'),
    };
  }

  function proposalError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function createProposalStore(api = {}) {
    const proposals = new Map();
    let lastApplied = null;

    function newId() {
      return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    }

    function proposeHtml({ baseHash, html, summary = '' } = {}) {
      const proposal = { id: newId(), kind: 'html', baseHash: String(baseHash || ''), html: String(html || ''), summary: String(summary || ''), status: 'pending', createdAt: Date.now() };
      proposals.set(proposal.id, proposal);
      return { ...proposal };
    }

    function proposeSubject({ baseSubject, subject, summary = '' } = {}) {
      const proposal = { id: newId(), kind: 'subject', baseSubject: String(baseSubject ?? ''), subject: String(subject ?? ''), summary: String(summary || ''), status: 'pending', createdAt: Date.now() };
      proposals.set(proposal.id, proposal);
      return { ...proposal };
    }

    function get(id) { const proposal = proposals.get(String(id)); return proposal ? { ...proposal } : null; }
    function cancel(id) { const p = proposals.get(String(id)); if (!p) return false; p.status = 'cancelled'; return true; }

    async function apply(id) {
      const proposal = proposals.get(String(id));
      if (!proposal) throw proposalError('UNKNOWN_PROPOSAL', 'Proposal not found');
      if (proposal.status !== 'pending') throw proposalError('PROPOSAL_NOT_PENDING', 'Proposal is no longer pending');
      const beforeHtml = String(await resolve(api.getCurrentHtml || ''));
      const beforeSubject = String(await resolve(api.getSubject || ''));
      const locale = String(await resolve(api.getActiveLocale || ''));
      if (proposal.kind === 'html' && proposal.baseHash !== stableHash(beforeHtml)) {
        throw proposalError('STALE_PROPOSAL', 'HTML changed after the AI proposal was created');
      }
      if (proposal.kind === 'subject' && proposal.baseSubject !== beforeSubject) {
        throw proposalError('STALE_PROPOSAL', 'Subject changed after the AI proposal was created');
      }
      await Promise.resolve(api.saveAiSnapshot?.({ html: beforeHtml, subject: beforeSubject, locale, proposalId: proposal.id }));
      if (proposal.kind === 'html') await Promise.resolve(api.setHtml?.(proposal.html));
      else await Promise.resolve(api.setSubject?.(proposal.subject));
      proposal.status = 'applied';
      lastApplied = { proposalId: proposal.id, beforeHtml, beforeSubject, locale, appliedAt: Date.now(), kind: proposal.kind };
      return { ...proposal };
    }

    async function undo() {
      if (!lastApplied) throw proposalError('NOTHING_TO_UNDO', 'There is no AI change to undo');
      const currentLocale = String(await resolve(api.getActiveLocale || ''));
      if (lastApplied.locale && currentLocale && lastApplied.locale !== currentLocale) {
        throw proposalError('LOCALE_CHANGED', `Switch back to ${lastApplied.locale} before undoing this AI change`);
      }
      if (typeof api.setHtml === 'function') await Promise.resolve(api.setHtml(lastApplied.beforeHtml));
      if (typeof api.setSubject === 'function') await Promise.resolve(api.setSubject(lastApplied.beforeSubject));
      const undone = { ...lastApplied };
      lastApplied = null;
      return undone;
    }

    return { proposeHtml, proposeSubject, get, cancel, apply, undo, list: () => [...proposals.values()].map((p) => ({ ...p })), getLastApplied: () => lastApplied ? { ...lastApplied } : null };
  }

  root.__RetKitAiContextCore = { stableHash, buildInitialContext, createProposalStore };
  if (typeof document === 'undefined') return;

  let workspaceApi = null;
  let bridgeClient = null;
  let unsubscribe = null;
  let store = null;
  let mode = 'agent';

  function getApi() {
    workspaceApi = workspaceApi || root.__RetKitAiWorkspaceApi;
    return workspaceApi;
  }

  function ensureStore() {
    const api = getApi();
    if (!store && api) store = createProposalStore(api);
    return store;
  }

  async function getInitialContext() {
    const api = getApi();
    if (!api) return null;
    return buildInitialContext(api);
  }

  async function executeTool(tool, args = {}) {
    const api = getApi();
    if (!api) throw proposalError('WORKSPACE_UNAVAILABLE', 'RetKit workspace is not open');
    const proposalStore = ensureStore();
    switch (tool) {
      case 'get_current_html': return { html: String(await resolve(api.getCurrentHtml || '')), hash: stableHash(await resolve(api.getCurrentHtml || '')) };
      case 'get_subject': return { subject: String(await resolve(api.getSubject || '')) };
      case 'get_active_locale': return { locale: String(await resolve(api.getActiveLocale || '')) };
      case 'list_locales': return { locales: await resolve(api.listLocales || []) };
      case 'list_available_locales': return { locales: await Promise.resolve(api.listAvailableLocales?.() || []) };
      case 'add_locale': {
        if (mode !== 'agent') throw proposalError('MODE_DENIED', 'Adding a locale is a structural change. Switch RetKit AI to Agent mode first.');
        const locale = String(args.locale || '').trim().toUpperCase();
        if (!locale) throw proposalError('BAD_LOCALE', 'Locale is required');
        const available = await Promise.resolve(api.listAvailableLocales?.() || []);
        if (!available.map((item) => String(item).toUpperCase()).includes(locale)) {
          throw proposalError('LOCALE_NOT_AVAILABLE', `MoEngage does not currently offer ${locale} in + Locale`);
        }
        if (typeof root.confirm === 'function' && !root.confirm(`RetKit AI wants to add MoEngage locale ${locale}. Continue?`)) {
          throw proposalError('USER_CANCELLED', `Adding ${locale} was cancelled`);
        }
        return await Promise.resolve(api.addLocales?.([locale]) || { ok: false, reason: 'Locale bridge unavailable' });
      }
      case 'remove_locale': {
        if (mode !== 'agent') throw proposalError('MODE_DENIED', 'Removing a locale is a structural change. Switch RetKit AI to Agent mode first.');
        const locale = String(args.locale || '').trim().toUpperCase();
        if (!locale || locale === 'EN' || locale === 'DEFAULT') throw proposalError('BAD_LOCALE', 'Default/EN locale cannot be removed');
        const existing = await Promise.resolve(api.listLocales?.() || []);
        if (!existing.map((item) => String(item).toUpperCase()).includes(locale)) return { ok: true, removed: false, reason: 'Locale is not present' };
        if (typeof root.confirm === 'function' && !root.confirm(`RetKit AI wants to remove MoEngage locale ${locale}. Continue?`)) {
          throw proposalError('USER_CANCELLED', `Removing ${locale} was cancelled`);
        }
        return await Promise.resolve(api.removeLocale?.(locale) || { ok: false, reason: 'Locale bridge unavailable' });
      }
      case 'get_locale_html': return { locale: String(args.locale || ''), html: String(await Promise.resolve(api.getLocaleHtml?.(args.locale) || '')) };
      case 'get_selected_source': return await resolve(api.getSelectedSource || null);
      case 'get_validator_issues': return { issues: await resolve(api.getValidatorIssues || []) };
      case 'get_preview_dom': return { html: String(await Promise.resolve(api.getPreviewDom?.(args.maxChars) || '')) };
      case 'get_preview_screenshot': return await Promise.resolve(api.getPreviewScreenshot?.() || { supported: false, reason: 'Preview capture unavailable' });
      case 'get_email_context_summary': return await getInitialContext();
      case 'switch_locale': return { ok: Boolean(await Promise.resolve(api.switchLocale?.(args.locale))) };
      case 'propose_html_patch': {
        if (mode === 'ask') throw proposalError('MODE_DENIED', 'Ask mode does not allow change proposals');
        const proposal = proposalStore.proposeHtml(args);
        root.__RetKitAiDiff?.showProposal?.(proposal, {
          before: String(await resolve(api.getCurrentHtml || '')),
          after: proposal.html,
          apply: () => approveProposal(proposal.id),
          cancel: () => cancelProposal(proposal.id),
        });
        return { proposalId: proposal.id, status: proposal.status };
      }
      case 'propose_subject_change': {
        if (mode === 'ask') throw proposalError('MODE_DENIED', 'Ask mode does not allow change proposals');
        const proposal = proposalStore.proposeSubject(args);
        root.__RetKitAiDiff?.showProposal?.(proposal, {
          before: String(await resolve(api.getSubject || '')),
          after: proposal.subject,
          apply: () => approveProposal(proposal.id),
          cancel: () => cancelProposal(proposal.id),
        });
        return { proposalId: proposal.id, status: proposal.status };
      }
      case 'find_across_locales':
        if (typeof api.acrossLocales !== 'function') throw proposalError('UNSUPPORTED', 'Across-locales search is unavailable');
        return await api.acrossLocales({ query: args.query, mode: args.mode });
      case 'propose_replace_across_locales': {
        if (mode === 'ask') throw proposalError('MODE_DENIED', 'Ask mode does not allow change proposals');
        if (typeof api.acrossLocales !== 'function') throw proposalError('UNSUPPORTED', 'Across-locales replace is unavailable');
        const plan = await api.acrossLocales({ query: args.search, replacement: String(args.replace ?? ''), mode: args.mode, perLocale: args.perLocale && typeof args.perLocale === 'object' ? args.perLocale : null });
        return { ...plan, status: 'awaiting_user', note: 'RetKit filled ⌘F with this search/replacement and scanned every locale. The user reviews the chips and clicks “Replace … in … locales”; the model cannot write to MoEngage by itself.' };
      }
      case 'apply_approved_patch':
        throw proposalError('USER_APPROVAL_REQUIRED', 'AI cannot approve its own proposal');
      case 'undo_last_ai_change':
        throw proposalError('USER_APPROVAL_REQUIRED', 'Undo is a user action');
      default: throw proposalError('UNKNOWN_TOOL', `Unknown RetKit AI tool: ${tool}`);
    }
  }

  async function onBridgeEvent(event) {
    if (event?.type !== 'tool.call') return;
    const callId = String(event.callId || '');
    try {
      const result = await executeTool(event.tool, event.args || {});
      await bridgeClient?.send?.('tool.result', { callId, ok: true, result });
    } catch (error) {
      await bridgeClient?.send?.('tool.result', { callId, ok: false, error: { code: error?.code || 'TOOL_ERROR', message: error?.message || String(error) } }).catch(() => {});
    }
  }

  function attach(options = {}) {
    workspaceApi = options.workspaceApi || root.__RetKitAiWorkspaceApi || workspaceApi;
    const nextClient = options.bridgeClient || bridgeClient;
    if (nextClient !== bridgeClient) {
      unsubscribe?.();
      bridgeClient = nextClient;
      unsubscribe = bridgeClient?.subscribe?.(onBridgeEvent) || null;
    }
    ensureStore();
    return Boolean(workspaceApi);
  }

  async function approveProposal(id) {
    const result = await ensureStore().apply(id);
    root.__RetKitAiDiff?.markApplied?.(id, () => undoLastAiChange());
    return result;
  }
  function cancelProposal(id) { const ok = ensureStore().cancel(id); root.__RetKitAiDiff?.dismiss?.(id); return ok; }
  async function undoLastAiChange() { const result = await ensureStore().undo(); root.__RetKitAiDiff?.dismissAll?.(); return result; }
  function setMode(value) {
    mode = 'agent';
    try { root.localStorage?.setItem('retkit-ai-mode', mode); } catch {}
    return mode;
  }

  root.__RetKitAiContext = { attach, getInitialContext, executeTool, approveProposal, cancelProposal, undoLastAiChange, setMode, getMode: () => mode, stableHash };
})(typeof globalThis !== 'undefined' ? globalThis : this);

(function (root) {
  'use strict';

  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const TEXT_TYPES = new Set(['text/plain', 'text/html', 'text/css', 'text/javascript', 'application/javascript', 'application/json', 'text/markdown']);
  const TEXT_EXTENSIONS = new Set(['txt', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'md', 'markdown']);
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  const MAX_TEXT_BYTES = 512 * 1024;
  const MAX_COUNT = 4;

  function extensionOf(name) {
    const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
  }

  function attachmentKind(file) {
    const type = String(file?.type || file?.mime || '').split(';')[0].trim().toLowerCase();
    if (IMAGE_TYPES.has(type)) return 'image';
    if (TEXT_TYPES.has(type) || TEXT_EXTENSIONS.has(extensionOf(file?.name))) return 'text';
    return '';
  }

  function validateAttachmentMeta(file) {
    const kind = attachmentKind(file);
    const size = Number(file?.size || 0);
    if (!kind) return { ok: false, reason: 'Drop an image or HTML/TXT/JSON/CSS/JS/MD file' };
    if (size <= 0) return { ok: false, reason: 'File is empty' };
    const max = kind === 'image' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
    if (size > max) return { ok: false, reason: kind === 'image' ? 'Image is larger than 12 MiB' : 'Text file is larger than 512 KiB' };
    return { ok: true, reason: '', kind };
  }

  function limitAttachments(items) {
    return Array.from(items || []).slice(0, MAX_COUNT);
  }

  root.__RetKitAiAttachmentCore = {
    validateAttachmentMeta,
    limitAttachments,
    attachmentKind,
    MAX_BYTES: MAX_IMAGE_BYTES,
    MAX_IMAGE_BYTES,
    MAX_TEXT_BYTES,
    MAX_COUNT,
  };
  if (typeof document === 'undefined') return;

  const STYLE_ID = 'retkit-ai-attachment-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .rk-ai-attachment-bar { display:flex; align-items:center; gap:6px; margin-bottom:6px; min-height:28px; }
      .rk-ai-attachment-bar[hidden] { display:none !important; }
      .rk-ai-attachment-chips { flex:1; min-width:0; display:flex; gap:5px; overflow-x:auto; }
      .rk-ai-chip { display:flex; align-items:center; gap:5px; max-width:190px; height:28px; padding:3px 6px; border:1px solid #334155; border-radius:7px; background:#111a26; color:#aebdce; font-size:10px; }
      .rk-ai-chip img { width:20px; height:20px; object-fit:cover; border-radius:4px; }
      .rk-ai-file-icon { min-width:24px; font-size:8px; font-weight:800; color:#8fa2b8; text-align:center; }
      .rk-ai-chip span { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
      .rk-ai-chip button { border:0; background:transparent; color:#8fa2b8; cursor:pointer; padding:0; }
      .rk-ai-chat { position:relative; }
      .rk-ai-drop-active { outline:2px dashed #5682ff; outline-offset:-4px; }
      .rk-ai-drop-active::after { content:"Drop files into chat"; position:absolute; inset:8px; z-index:20; display:grid; place-items:center; pointer-events:none; border-radius:10px; background:rgba(13,20,30,.88); color:#dfe8f7; font:700 13px/1.2 Inter,ui-sans-serif,sans-serif; }
      .rk-ai-attachment-error { color:#ff8d94; font-size:10px; margin-left:auto; }
    `;
    document.head.appendChild(style);
  }

  function createAttachmentTray({ bridgeClient, dropTarget } = {}) {
    injectStyle();
    const bar = document.createElement('div');
    bar.className = 'rk-ai-attachment-bar';
    bar.hidden = true;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    input.style.setProperty('display', 'none', 'important');
    const chips = document.createElement('div');
    chips.className = 'rk-ai-attachment-chips';
    const error = document.createElement('div');
    error.className = 'rk-ai-attachment-error';
    bar.append(input, chips, error);

    const pending = [];

    function updateVisibility() {
      bar.hidden = pending.length === 0 && !error.textContent;
    }

    function setError(message) {
      error.textContent = String(message || '');
      updateVisibility();
      if (message) root.setTimeout?.(() => {
        if (error.textContent === message) {
          error.textContent = '';
          updateVisibility();
        }
      }, 4500);
    }

    function render() {
      chips.replaceChildren();
      for (const item of pending) {
        const chip = document.createElement('div');
        chip.className = 'rk-ai-chip';
        if (item.kind === 'image') {
          const img = document.createElement('img');
          try { img.src = item.previewUrl || (item.previewUrl = URL.createObjectURL(item.file)); } catch {}
          chip.appendChild(img);
        } else {
          const icon = document.createElement('span');
          icon.className = 'rk-ai-file-icon';
          icon.textContent = (extensionOf(item.name) || 'FILE').slice(0, 4).toUpperCase();
          chip.appendChild(icon);
        }
        const name = document.createElement('span');
        name.textContent = item.name;
        name.title = item.name;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.title = `Remove ${item.name}`;
        remove.addEventListener('click', () => {
          const index = pending.indexOf(item);
          if (index >= 0) pending.splice(index, 1);
          if (item.previewUrl) try { URL.revokeObjectURL(item.previewUrl); } catch {}
          render();
        });
        chip.append(name, remove);
        chips.appendChild(chip);
      }
      updateVisibility();
    }

    async function addFiles(fileList) {
      const files = limitAttachments(Array.from(fileList || []));
      for (const file of files) {
        if (pending.length >= MAX_COUNT) { setError('Maximum 4 files per message'); break; }
        const valid = validateAttachmentMeta(file);
        if (!valid.ok) { setError(valid.reason); continue; }
        const localId = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const item = {
          localId,
          file,
          kind: valid.kind,
          name: file.name || (valid.kind === 'image' ? 'image' : 'file'),
          mime: file.type || '',
          size: file.size,
          status: 'uploading',
          attachmentId: null,
        };
        pending.push(item);
        render();
        try {
          const uploaded = await bridgeClient.uploadAttachment(file);
          item.status = 'ready';
          item.attachmentId = uploaded.attachmentId;
        } catch (uploadError) {
          item.status = 'error';
          setError(uploadError?.message || String(uploadError));
        }
        render();
      }
      return pending;
    }

    input.addEventListener('change', async () => { await addFiles(input.files); input.value = ''; });

    const target = dropTarget || document;
    let dragDepth = 0;
    target.addEventListener?.('dragenter', (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      dragDepth += 1;
      dropTarget?.classList?.add('rk-ai-drop-active');
    });
    target.addEventListener?.('dragover', (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      dropTarget?.classList?.add('rk-ai-drop-active');
    });
    target.addEventListener?.('dragleave', (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dropTarget?.classList?.remove('rk-ai-drop-active');
    });
    target.addEventListener?.('drop', async (event) => {
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      event.preventDefault();
      dragDepth = 0;
      dropTarget?.classList?.remove('rk-ai-drop-active');
      await addFiles(files);
    });
    target.addEventListener?.('paste', async (event) => {
      const files = Array.from(event.clipboardData?.files || []);
      if (!files.length) return;
      event.preventDefault();
      await addFiles(files);
    });

    function clearPending() {
      for (const item of pending) if (item.previewUrl) try { URL.revokeObjectURL(item.previewUrl); } catch {}
      pending.length = 0;
      render();
    }

    return { element: bar, addFiles, getPending: () => pending.slice(), clearPending, setError };
  }

  root.__RetKitAiAttachments = { createAttachmentTray };
})(typeof globalThis !== 'undefined' ? globalThis : this);

(function (root) {
  'use strict';

  function makeLineDiff(before, after, maxLines = 120) {
    const a = String(before ?? '').split('\n');
    const b = String(after ?? '').split('\n');
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
    const rows = [];
    const contextStart = Math.max(0, prefix - 2);
    for (let i = contextStart; i < prefix; i += 1) rows.push({ type: 'same', text: a[i] });
    for (const line of a.slice(prefix, Math.max(prefix, a.length - suffix))) rows.push({ type: 'remove', text: line });
    for (const line of b.slice(prefix, Math.max(prefix, b.length - suffix))) rows.push({ type: 'add', text: line });
    const suffixStart = Math.max(prefix, b.length - suffix);
    for (let i = suffixStart; i < Math.min(b.length, suffixStart + 2); i += 1) rows.push({ type: 'same', text: b[i] });
    if (rows.length > maxLines) return [...rows.slice(0, maxLines), { type: 'same', text: `… ${rows.length - maxLines} more changed/context lines` }];
    return rows;
  }

  root.__RetKitAiDiffCore = { makeLineDiff };
  if (typeof document === 'undefined') return;

  const cards = new Map();
  function ensureStyle() {
    if (document.getElementById('retkit-ai-diff-style')) return;
    const style = document.createElement('style');
    style.id = 'retkit-ai-diff-style';
    style.textContent = `
      .rk-ai-proposal { flex:0 0 auto; max-height:42%; overflow:auto; border-bottom:1px solid #334155; background:#0c131d; padding:8px; }
      .rk-ai-proposal-head { display:flex; align-items:center; gap:6px; margin-bottom:6px; }
      .rk-ai-proposal-head strong { font-size:11px; color:#dce6f4; }
      .rk-ai-proposal-summary { flex:1; color:#8fa2b8; font-size:10px; }
      .rk-ai-diff { max-height:180px; overflow:auto; margin:6px 0; border:1px solid #263140; border-radius:7px; background:#080d13; font:10px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; }
      .rk-ai-diff-row { white-space:pre-wrap; padding:1px 6px; }
      .rk-ai-diff-row[data-type="add"] { background:rgba(57,151,94,.18); color:#9ae5b8; }
      .rk-ai-diff-row[data-type="remove"] { background:rgba(188,67,76,.18); color:#ffabb0; }
      .rk-ai-diff-row[data-type="same"] { color:#697b90; }
      .rk-ai-proposal-actions { display:flex; gap:6px; }
      .rk-ai-proposal-actions button { height:27px; border:1px solid #334155; border-radius:7px; padding:0 9px; background:#172130; color:#dce6f4; cursor:pointer; font:700 10px inherit; }
      .rk-ai-proposal-actions .rk-ai-apply { background:#315be9; border-color:#4c75e7; color:#fff; }
      .rk-ai-proposal-actions .rk-ai-undo { background:#5e3e16; border-color:#8a642b; color:#ffe2aa; }
    `;
    document.head.appendChild(style);
  }

  function dismiss(id) { const card = cards.get(String(id)); card?.remove(); cards.delete(String(id)); }
  function dismissAll() { for (const id of [...cards.keys()]) dismiss(id); }

  function showProposal(proposal, options = {}) {
    ensureStyle();
    dismiss(proposal.id);
    const panel = document.getElementById('retkit-ai-panel');
    const body = document.getElementById('retkit-ai-body');
    if (!panel || !body) return false;
    const card = document.createElement('section');
    card.className = 'rk-ai-proposal';
    card.dataset.proposalId = proposal.id;
    const head = document.createElement('div');
    head.className = 'rk-ai-proposal-head';
    head.innerHTML = `<strong>${proposal.kind === 'subject' ? 'Subject proposal' : 'HTML proposal'}</strong><span class="rk-ai-proposal-summary"></span>`;
    head.querySelector('.rk-ai-proposal-summary').textContent = proposal.summary || 'AI suggested a change';
    const diff = document.createElement('div');
    diff.className = 'rk-ai-diff';
    for (const row of makeLineDiff(options.before, options.after)) {
      const line = document.createElement('div');
      line.className = 'rk-ai-diff-row';
      line.dataset.type = row.type;
      line.textContent = `${row.type === 'add' ? '+' : row.type === 'remove' ? '-' : ' '} ${row.text}`;
      diff.appendChild(line);
    }
    const actions = document.createElement('div');
    actions.className = 'rk-ai-proposal-actions';
    const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'rk-ai-apply'; apply.textContent = 'Apply';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      try { await options.apply?.(); } catch (error) { apply.disabled = false; apply.textContent = error?.code === 'STALE_PROPOSAL' ? 'Stale – ask AI again' : 'Apply failed'; }
    });
    cancel.addEventListener('click', () => { options.cancel?.(); dismiss(proposal.id); });
    actions.append(apply, cancel);
    card.append(head, diff, actions);
    panel.insertBefore(card, body);
    cards.set(proposal.id, card);
    return true;
  }

  function markApplied(id, onUndo) {
    const card = cards.get(String(id));
    if (!card) return;
    const actions = card.querySelector('.rk-ai-proposal-actions');
    if (!actions) return;
    actions.replaceChildren();
    const label = document.createElement('span'); label.textContent = 'Applied'; label.style.color = '#72d6a0'; label.style.fontSize = '10px';
    const undo = document.createElement('button'); undo.type = 'button'; undo.className = 'rk-ai-undo'; undo.textContent = 'Undo AI change';
    undo.addEventListener('click', async () => { undo.disabled = true; try { await onUndo?.(); } catch { undo.disabled = false; } });
    actions.append(label, undo);
  }

  root.__RetKitAiDiff = { showProposal, markApplied, dismiss, dismissAll };
})(typeof globalThis !== 'undefined' ? globalThis : this);

(function (root) {
  'use strict';

  // "Connect Claude / Codex" card shown inside RetKit AI while the local bridge
  // is not running (or the model CLI is missing / not logged in). The browser
  // cannot install programs by itself, so the card does the most it can:
  // detects Mac / Windows, gives the one installer for that system (copy one
  // line on Mac, download a .cmd on Windows) and waits for the bridge to come up.

  const INSTALL_BASE = 'https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/install';
  const CARD_ID = 'retkit-ai-connect-card';

  function detectOs(nav = root.navigator) {
    const raw = String(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '').toLowerCase();
    if (raw.includes('win')) return 'windows';
    if (raw.includes('mac') || raw.includes('darwin')) return 'mac';
    if (raw.includes('linux')) return 'linux';
    return 'mac';
  }

  function installCommand(os, { codex = false } = {}) {
    if (os === 'windows') {
      const prefix = codex ? '$env:RETKIT_CODEX="1"; ' : '';
      return `${prefix}irm ${INSTALL_BASE}/install-windows.ps1 | iex`;
    }
    return `curl -fsSL ${INSTALL_BASE}/install-mac.sh | bash${codex ? ' -s -- --codex' : ''}`;
  }

  function windowsCmdFile({ codex = false } = {}) {
    return [
      '@echo off',
      'rem RetKit AI setup: installs Claude Code, the RetKit bridge and autostart.',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${codex ? '$env:RETKIT_CODEX=\'1\'; ' : ''}irm ${INSTALL_BASE}/install-windows.ps1 | iex"`,
      'echo.',
      'pause',
      '',
    ].join('\r\n');
  }

  // What the card should say for the current bridge/provider state.
  function connectView({ bridge = {}, provider = {}, providerId = 'claude' } = {}) {
    const name = providerId === 'codex' ? 'Codex' : 'Claude';
    if (String(bridge.status || '') !== 'connected') return { step: 'install', title: `Подключить ${name}` };
    if (!provider.detected) return { step: 'install', title: `${name} не найден на этом компьютере` };
    if (provider.authenticated === 'no') return { step: 'login', title: `Войдите в ${name}` };
    return null;
  }

  function render(host, state = {}) {
    if (typeof document === 'undefined' || !host) return;
    const view = connectView(state);
    let card = document.getElementById(CARD_ID);
    if (!view) { card?.remove(); return; }
    const os = detectOs();
    const key = `${view.step}|${view.title}|${os}`;
    if (card && card.dataset.key === key) return;
    card?.remove();
    card = document.createElement('div');
    card.id = CARD_ID;
    card.dataset.key = key;
    card.className = 'rk-ai-connect';

    const title = document.createElement('strong');
    title.textContent = view.title;
    card.appendChild(title);

    if (view.step === 'login') {
      const text = document.createElement('p');
      text.textContent = state.providerId === 'codex'
        ? 'Откройте Терминал, введите codex login и войдите в браузере. RetKit подхватит вход сам.'
        : 'Откройте Терминал, введите claude и войдите в браузере (потом /exit). RetKit подхватит вход сам.';
      card.appendChild(text);
      host.prepend(card);
      return;
    }

    // Work machines: no installers, no autostart from inside the page.
    const intro = document.createElement('p');
    intro.textContent = 'RetKit AI работает через вашу модель на этом компьютере. Запустите связку RetKit в Терминале из папки RetKit и оставьте окно открытым:';
    const code = document.createElement('code');
    code.className = 'rk-ai-connect-note';
    code.textContent = 'npm run bridge';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'rk-ai-connect-secondary';
    copy.textContent = 'Скопировать';
    copy.addEventListener('click', async () => { try { await root.navigator.clipboard.writeText('npm run bridge'); copy.textContent = 'Скопировано'; } catch {} });
    const row = document.createElement('div');
    row.className = 'rk-ai-connect-row';
    row.append(code, copy);
    const wait = document.createElement('p');
    wait.className = 'rk-ai-connect-wait';
    wait.textContent = 'Нужен установленный и залогиненный Claude Code (или Codex). На рабочем компьютере — только с согласия IT. RetKit подключится сам, как только связка запущена.';
    card.append(intro, row, wait);
    host.prepend(card);
  }

  root.__RetKitAiConnect = { detectOs, installCommand, windowsCmdFile, connectView, render, INSTALL_BASE };
})(typeof globalThis !== 'undefined' ? globalThis : this);

(function (root) {
  'use strict';

  function keyAction(event) {
    if (event?.key !== 'Enter') return 'none';
    return event.shiftKey ? 'newline' : 'send';
  }

  function normalizeMessage(input) {
    return {
      id: String(input?.id || `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`),
      role: ['user', 'assistant', 'system'].includes(input?.role) ? input.role : 'system',
      text: String(input?.text || ''),
      attachments: Array.isArray(input?.attachments) ? input.attachments : [],
      status: String(input?.status || 'done'),
    };
  }

  root.__RetKitAiChatCore = { keyAction, normalizeMessage };
  if (typeof document === 'undefined') return;

  const STYLE_ID = 'retkit-ai-chat-style';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .rk-ai-chat { height:100%; display:flex; flex-direction:column; min-height:0; }
      .rk-ai-messages { flex:1; min-height:0; overflow:auto; padding:10px; display:flex; flex-direction:column; gap:8px; }
      .rk-ai-msg { max-width:92%; padding:8px 10px; border-radius:10px; white-space:pre-wrap; word-break:break-word; font:12px/1.45 Inter,ui-sans-serif,sans-serif; }
      .rk-ai-msg[data-role="user"] { align-self:flex-end; background:#21468f; color:#eef4ff; }
      .rk-ai-msg[data-role="assistant"] { align-self:flex-start; background:#172130; color:#dce6f4; border:1px solid #29384c; }
      .rk-ai-msg[data-role="system"] { align-self:center; background:transparent; color:#8395aa; font-size:11px; }
      .rk-ai-msg[data-status="error"] { border-color:#7b3037; color:#ffabb0; }
      .rk-ai-composer { flex:0 0 auto; border-top:1px solid #263140; padding:8px; background:#0e1621; }
      .rk-ai-composer-row { display:flex; align-items:flex-end; gap:6px; }
      .rk-ai-input { flex:1; min-height:38px; max-height:120px; resize:vertical; border:1px solid #334155; border-radius:9px; padding:8px 9px; background:#0a111a; color:#e7edf6; outline:none; font:12px/1.4 inherit; }
      .rk-ai-input:focus { border-color:#5f83ff; box-shadow:0 0 0 2px rgba(72,111,255,.14); }
      .rk-ai-send,.rk-ai-stop { min-width:58px; height:36px; border:1px solid #466ed9; border-radius:8px; background:#315be9; color:#fff; cursor:pointer; font:700 11px inherit; }
      .rk-ai-stop { background:#7c3038; border-color:#a64650; display:none; }
      .rk-ai-chat[data-busy="1"] .rk-ai-send { display:none; }
      .rk-ai-chat[data-busy="1"] .rk-ai-stop { display:block; }
      .rk-ai-chat-hint { margin-top:5px; color:#64768c; font-size:10px; }
    `;
    document.head.appendChild(style);
  }

  function createChatView(options = {}) {
    injectStyle();
    const bridgeClient = options.bridgeClient;
    const rootEl = document.createElement('div');
    rootEl.className = 'rk-ai-chat';
    rootEl.dataset.busy = '0';
    const messagesEl = document.createElement('div');
    messagesEl.className = 'rk-ai-messages';
    const composer = document.createElement('div');
    composer.className = 'rk-ai-composer';
    const row = document.createElement('div');
    row.className = 'rk-ai-composer-row';
    const textarea = document.createElement('textarea');
    textarea.className = 'rk-ai-input';
    textarea.placeholder = 'Ask Codex or Claude about this email…';
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'rk-ai-send';
    sendBtn.textContent = 'Send';
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'rk-ai-stop';
    stopBtn.textContent = 'Stop';
    row.append(textarea, sendBtn, stopBtn);
    const hint = document.createElement('div');
    hint.className = 'rk-ai-chat-hint';
    hint.textContent = 'Enter sends · Shift+Enter adds a new line';
    const attachmentTray = root.__RetKitAiAttachments?.createAttachmentTray?.({ bridgeClient, dropTarget: rootEl });
    if (attachmentTray?.element) composer.append(attachmentTray.element);
    composer.append(row, hint);
    rootEl.append(messagesEl, composer);

    const messages = [];
    let busy = false;
    let currentAssistant = null;
    let activeProvider = options.provider || 'codex';
    let activeMode = 'agent';

    function renderMessage(message) {
      let el = messagesEl.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = 'rk-ai-msg';
        el.dataset.messageId = message.id;
        el.dataset.role = message.role;
        messagesEl.appendChild(el);
      }
      el.dataset.status = message.status;
      el.textContent = message.text || (message.status === 'streaming' ? '…' : '');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function addMessage(input) {
      const message = normalizeMessage(input);
      messages.push(message);
      renderMessage(message);
      return message;
    }

    function setBusy(value) {
      busy = Boolean(value);
      rootEl.dataset.busy = busy ? '1' : '0';
      textarea.disabled = busy;
    }

    async function send() {
      const text = textarea.value.trim();
      if (!text || busy) return false;
      const bridgeState = bridgeClient?.getState?.();
      if (bridgeState?.status !== 'connected') {
        addMessage({ role: 'system', text: 'Bridge offline. Start RetKit AI Bridge and retry.', status: 'error' });
        return false;
      }
      const context = await options.getContext?.().catch?.(() => null) || await Promise.resolve(options.getContext?.()) || null;
      const attachments = attachmentTray?.getPending?.() || options.getAttachments?.() || [];
      addMessage({ role: 'user', text, attachments, status: 'done' });
      currentAssistant = addMessage({ role: 'assistant', text: '', status: 'streaming' });
      textarea.value = '';
      setBusy(true);
      try {
        await bridgeClient.send('chat.send', {
          provider: activeProvider,
          mode: activeMode,
          text,
          context,
          attachmentIds: attachments.map((item) => item.attachmentId).filter(Boolean),
        });
        attachmentTray?.clearPending?.();
        options.onSent?.();
        return true;
      } catch (error) {
        currentAssistant.text = error?.message || String(error);
        currentAssistant.status = 'error';
        renderMessage(currentAssistant);
        setBusy(false);
        return false;
      }
    }

    function handleEvent(event) {
      if (!event) return;
      if (event.type === 'chat.delta') {
        if (!currentAssistant) currentAssistant = addMessage({ role: 'assistant', text: '', status: 'streaming' });
        currentAssistant.text += String(event.text || '');
        currentAssistant.status = 'streaming';
        renderMessage(currentAssistant);
      } else if (event.type === 'chat.done') {
        if (currentAssistant) {
          currentAssistant.status = 'done';
          renderMessage(currentAssistant);
        }
        currentAssistant = null;
        setBusy(false);
      } else if (event.type === 'chat.error' || (event.type === 'bridge.error' && busy)) {
        if (!currentAssistant) currentAssistant = addMessage({ role: 'assistant', text: '', status: 'error' });
        currentAssistant.text += String(event.message || event.code || 'AI error');
        currentAssistant.status = 'error';
        renderMessage(currentAssistant);
        currentAssistant = null;
        setBusy(false);
      }
    }

    const unsubscribe = bridgeClient?.subscribe?.(handleEvent) || (() => {});
    textarea.addEventListener('keydown', (event) => {
      const action = keyAction(event);
      if (action === 'send') {
        event.preventDefault();
        send();
      }
    });
    sendBtn.addEventListener('click', send);
    stopBtn.addEventListener('click', async () => {
      try { await bridgeClient?.send?.('chat.cancel', { provider: activeProvider }); } catch {}
      setBusy(false);
    });

    return {
      element: rootEl,
      messages,
      send,
      handleEvent,
      setProvider(provider) { activeProvider = provider === 'claude' ? 'claude' : 'codex'; },
      getProvider() { return activeProvider; },
      setMode() { activeMode = 'agent'; },
      getMode() { return activeMode; },
      destroy() { unsubscribe(); },
      focus() { textarea.focus(); },
      get busy() { return busy; },
    };
  }

  root.__RetKitAiChat = { createChatView };
})(typeof globalThis !== 'undefined' ? globalThis : this);

(function (root) {
  'use strict';

  const IDS = {
    style: 'retkit-ai-style',
    stack: 'retkit-ai-left-stack',
    panel: 'retkit-ai-panel',
    grip: 'retkit-ai-vertical-grip',
    toggle: 'retkit-ai-toggle',
    header: 'retkit-ai-header',
    body: 'retkit-ai-body',
    status: 'retkit-ai-status',
    usage: 'retkit-ai-usage',
  };
  const STORAGE = {
    open: 'retkit-ai-panel-open',
    height: 'retkit-ai-panel-height',
  };
  const DEFAULT_HEIGHT = 320;
  const MIN_CHAT = 180;
  const MIN_CODE = 180;

  function clampAiHeight(value, totalHeight) {
    const total = Math.max(MIN_CHAT + MIN_CODE, Number(totalHeight) || (MIN_CHAT + MIN_CODE));
    const max = Math.max(MIN_CHAT, total - MIN_CODE);
    return Math.max(MIN_CHAT, Math.min(max, Number(value) || DEFAULT_HEIGHT));
  }

  function nextAiPanelState(state, action) {
    const current = { open: Boolean(state?.open), height: Number(state?.height) || DEFAULT_HEIGHT };
    if (action?.type === 'toggle') return { ...current, open: !current.open };
    if (action?.type === 'open') return { ...current, open: true };
    if (action?.type === 'close') return { ...current, open: false };
    if (action?.type === 'height') return { ...current, height: Number(action.height) || current.height };
    return current;
  }

  function providerStatusView(provider = {}, runtime = {}) {
    const state = String(runtime?.state || '');
    if (state === 'error') return { label: 'Error', tone: 'error', ...(runtime.detail ? { detail: String(runtime.detail) } : {}) };
    if (state === 'connecting') return { label: 'Connecting', tone: 'warning' };
    if (state === 'busy') return { label: 'Busy', tone: 'ok' };
    if (state === 'connected') return { label: 'Connected', tone: 'ok' };
    if (!provider?.detected) return { label: 'Not detected', tone: 'error' };
    if (provider?.authenticated === 'no') return { label: 'Authentication required', tone: 'error' };
    return { label: 'Detected', tone: 'warning' };
  }

  function providerButtonView(provider = {}, runtime = {}, bridge = {}) {
    if (String(bridge?.status || '') !== 'connected') {
      return { label: 'Bridge offline', tone: 'error', detail: bridge?.detail ? String(bridge.detail) : 'Start the local RetKit AI bridge' };
    }
    return providerStatusView(provider, runtime);
  }

  function normalizeAiMode(value) {
    const mode = String(value || '').toLowerCase();
    return ['ask', 'suggest', 'agent'].includes(mode) ? mode : 'agent';
  }

  function compactNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return null;
    if (number >= 1000000) return `${(number / 1000000).toFixed(number >= 10000000 ? 0 : 1).replace(/\.0$/, '')}m`;
    if (number >= 1000) return `${(number / 1000).toFixed(number >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
    return String(Math.round(number));
  }

  function usageStatusText(usage) {
    if (!usage || typeof usage !== 'object') return '';
    const input = usage.input_tokens ?? usage.inputTokens ?? usage.input ?? usage.prompt_tokens ?? usage.promptTokens;
    const output = usage.output_tokens ?? usage.outputTokens ?? usage.output ?? usage.completion_tokens ?? usage.completionTokens;
    const total = usage.total_tokens ?? usage.totalTokens ?? ((Number.isFinite(Number(input)) || Number.isFinite(Number(output))) ? (Number(input) || 0) + (Number(output) || 0) : null);
    const shown = compactNumber(total);
    return shown == null ? '' : `Usage ${shown} tokens`;
  }

  root.__RetKitAiUiCore = { clampAiHeight, nextAiPanelState, providerStatusView, providerButtonView, normalizeAiMode, usageStatusText };

  if (typeof document === 'undefined') return;

  let workspaceApi = null;
  let bridgeClient = null;
  let state = {
    open: root.localStorage?.getItem(STORAGE.open) === '1',
    height: Number(root.localStorage?.getItem(STORAGE.height)) || DEFAULT_HEIGHT,
  };
  let bridgeState = { status: 'offline' };
  const providerInfo = {
    codex: { id: 'codex', detected: false, authenticated: 'unknown', version: null, detail: null },
    claude: { id: 'claude', detected: false, authenticated: 'unknown', version: null, detail: null },
  };
  const providerRuntime = { codex: { state: '' }, claude: { state: '' } };
  const providerUsage = { codex: null, claude: null };
  let activeProvider = root.localStorage?.getItem('retkit-ai-provider') === 'claude' ? 'claude' : 'codex';
  const activeMode = 'agent';
  let chat = null;

  function injectStyle() {
    if (document.getElementById(IDS.style)) return;
    const style = document.createElement('style');
    style.id = IDS.style;
    style.textContent = `
      #retkit-mo-editor-pane { position:relative; }
      .rk-ai-connect { margin:10px; padding:12px 14px; border:1px solid #2f4b7a; border-radius:12px; background:#101c2d; color:#dce6f4; font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; display:grid; gap:8px; }
      .rk-ai-connect strong { font-size:14px; }
      .rk-ai-connect p { margin:0; color:#a9b8cc; }
      .rk-ai-connect-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
      .rk-ai-connect-primary { border:1px solid #4c75e7; background:#315be9; color:#fff; border-radius:8px; padding:8px 12px; cursor:pointer; font-weight:700; }
      .rk-ai-connect-secondary { border:1px solid #334155; background:#172130; color:#dce6f4; border-radius:8px; padding:7px 10px; cursor:pointer; }
      .rk-ai-connect-opt { color:#a9b8cc; cursor:pointer; }
      .rk-ai-connect-note { color:#91ddb0; word-break:break-all; }
      .rk-ai-connect-wait { font-size:11.5px; color:#7f8ea3 !important; }
      #${IDS.stack} { flex:1; min-height:0; display:grid; grid-template-rows:minmax(0,1fr) 0 38px; overflow:hidden; }
      #${IDS.stack}[data-ai-open="1"] { grid-template-rows:minmax(0,1fr) 6px var(--rk-ai-height,320px); }
      #${IDS.panel} { min-height:0; overflow:hidden; display:flex; flex-direction:column; background:#0d141e; border-top:1px solid #263140; }
      #${IDS.panel}[data-open="0"] #${IDS.body} { display:none; }
      #${IDS.panel}[data-open="0"] .rk-ai-provider-switch, #${IDS.panel}[data-open="0"] #${IDS.usage} { display:none; }
      #${IDS.header} { height:36px; flex:0 0 36px; display:flex; align-items:center; gap:8px; padding:0 9px; border-bottom:1px solid #263140; background:#101925; }
      #${IDS.header} strong { font-size:12px; color:#e8eef8; }
      .rk-ai-provider-switch { display:flex; align-items:center; gap:4px; }
      .rk-ai-choice { height:25px; border:1px solid #3b4b61; border-radius:7px; background:#172130; color:#b9c7d8; font:700 10px inherit; padding:0 8px; cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
      .rk-ai-choice:hover { background:#223149; color:#fff; }
      .rk-ai-choice.rk-active { background:#315fd6; border-color:#6388ef; color:#fff; box-shadow:0 0 0 1px rgba(99,136,239,.15) inset; }
      .rk-ai-provider-dot { width:7px; height:7px; border-radius:999px; background:#708198; box-shadow:0 0 0 1px rgba(255,255,255,.08); }
      .rk-ai-choice[data-tone="ok"] .rk-ai-provider-dot { background:#55cf91; }
      .rk-ai-choice[data-tone="warning"] .rk-ai-provider-dot { background:#e5b858; }
      .rk-ai-choice[data-tone="error"] .rk-ai-provider-dot { background:#ed6f78; }
      #${IDS.usage} { margin-left:auto; font-size:10px; color:#71839a; white-space:nowrap; }
      #${IDS.status} { font-size:10px; color:#8fa2b8; white-space:nowrap; max-width:190px; overflow:hidden; text-overflow:ellipsis; }
      #${IDS.status}[data-tone="ok"] { color:#66d49b; }
      #${IDS.status}[data-tone="warning"] { color:#f0bd62; }
      #${IDS.status}[data-tone="error"] { color:#ff858c; }
      #${IDS.body} { flex:1; min-height:0; overflow:hidden; padding:0; color:#9fb0c4; font-size:12px; display:flex; flex-direction:column; }
      #${IDS.body} > .rk-ai-chat { flex:1 1 auto; min-height:0; }
      #${IDS.grip} { background:#202a37; cursor:row-resize; position:relative; }
      #${IDS.grip}:hover { background:#4368d8; }
      #${IDS.grip}[aria-hidden="true"] { visibility:hidden; pointer-events:none; }
      #${IDS.toggle} { width:28px; height:26px; border:0; border-radius:7px; background:transparent; color:#8fa2b8; font:700 15px/1 inherit; cursor:pointer; margin-left:2px; }
      #${IDS.toggle}:hover { background:#1e2b3d; color:#fff; }
    `;
    document.head.appendChild(style);
  }

  function persist() {
    try {
      root.localStorage?.setItem(STORAGE.open, state.open ? '1' : '0');
      root.localStorage?.setItem(STORAGE.height, String(Math.round(state.height)));
    } catch {}
  }

  function refreshLayout() {
    try { workspaceApi?.refreshEditorLayout?.(); } catch {}
  }

  function renderState() {
    const stack = document.getElementById(IDS.stack);
    const panel = document.getElementById(IDS.panel);
    const grip = document.getElementById(IDS.grip);
    const toggle = document.getElementById(IDS.toggle);
    if (!stack) return;
    const rect = stack.getBoundingClientRect?.();
    const total = rect?.height || 720;
    state.height = clampAiHeight(state.height, total);
    stack.style.setProperty('--rk-ai-height', `${Math.round(state.height)}px`);
    stack.dataset.aiOpen = state.open ? '1' : '0';
    if (panel) panel.dataset.open = state.open ? '1' : '0';
    grip?.setAttribute('aria-hidden', state.open ? 'false' : 'true');
    const title = document.getElementById('retkit-ai-title');
    if (title) title.textContent = state.open ? 'RetKit AI' : '✦ Ask AI…';
    if (toggle) {
      toggle.dataset.open = state.open ? '1' : '0';
      toggle.textContent = state.open ? '⌄' : '⌃';
      toggle.title = state.open ? 'Collapse RetKit AI' : 'Open RetKit AI';
    }
    persist();
    refreshLayout();
  }

  function toggleAiPanel(force) {
    state = nextAiPanelState(state, typeof force === 'boolean' ? { type: force ? 'open' : 'close' } : { type: 'toggle' });
    renderState();
    if (state.open) ensureBridgeConnection();
    return getAiPanelState();
  }

  function setAiPanelHeight(px) {
    const stack = document.getElementById(IDS.stack);
    const total = stack?.getBoundingClientRect?.().height || 720;
    state = nextAiPanelState(state, { type: 'height', height: clampAiHeight(px, total) });
    renderState();
    return state.height;
  }

  function getAiPanelState() {
    return { open: state.open, height: state.height, provider: activeProvider, mode: activeMode };
  }

  function selectedProviderButton() {
    return document.querySelector(`[data-provider-choice="${activeProvider}"]`);
  }

  function renderProviders() {
    for (const id of ['claude', 'codex']) {
      const button = document.querySelector(`[data-provider-choice="${id}"]`);
      if (!button) continue;
      const view = providerButtonView(providerInfo[id], providerRuntime[id], bridgeState);
      button.classList.toggle('rk-active', id === activeProvider);
      button.dataset.tone = view.tone;
      const detail = view.detail || providerRuntime[id]?.detail || providerInfo[id]?.detail || providerInfo[id]?.version || '';
      button.title = `${id === 'claude' ? 'Claude' : 'Codex'} · ${view.label}${detail ? ` · ${detail}` : ''}`;
      button.setAttribute('aria-label', button.title);
    }

    const selected = activeProvider;
    const selectedView = providerButtonView(providerInfo[selected], providerRuntime[selected], bridgeState);
    const status = document.getElementById(IDS.status);
    if (status) {
      status.textContent = selectedView.label;
      status.dataset.tone = selectedView.tone;
      status.title = selectedProviderButton()?.title || selectedView.label;
    }
    try {
      root.__RetKitAiConnect?.render?.(document.getElementById(IDS.body), {
        bridge: bridgeState,
        provider: providerInfo[selected] || {},
        providerId: selected,
      });
    } catch {}
    const usageEl = document.getElementById(IDS.usage);
    if (usageEl) {
      usageEl.textContent = usageStatusText(providerUsage[selected]);
      usageEl.title = usageEl.textContent ? 'Provider-reported usage for the last completed turn' : '';
    }
  }

  function handleBridgeUiEvent(event) {
    if (!event) return;
    if (event.type === 'provider.status' && event.provider?.id && providerInfo[event.provider.id]) {
      providerInfo[event.provider.id] = { ...providerInfo[event.provider.id], ...event.provider };
    } else if (event.type === 'provider.state' && providerRuntime[event.provider]) {
      providerRuntime[event.provider] = { state: String(event.state || ''), ...(event.detail ? { detail: String(event.detail) } : {}) };
    } else if (event.type === 'provider.connected' && providerRuntime[event.provider]) {
      providerRuntime[event.provider] = { state: 'connected' };
      if (event.status) providerInfo[event.provider] = { ...providerInfo[event.provider], ...event.status };
    } else if (event.type === 'provider.disconnected' && providerRuntime[event.provider]) {
      providerRuntime[event.provider] = { state: '' };
    } else if (event.type === 'chat.done' && event.provider && Object.hasOwn(providerUsage, event.provider)) {
      providerUsage[event.provider] = event.usage || null;
    }
    renderProviders();
  }

  function ensureBridgeClient() {
    if (bridgeClient || !root.__RetKitAiBridge?.createBridgeClient) return bridgeClient;
    bridgeClient = root.__RetKitAiBridge.createBridgeClient();
    bridgeClient.subscribeState((connection) => {
      bridgeState = { ...connection };
      renderProviders();
    });
    bridgeClient.subscribe((event) => {
      handleBridgeUiEvent(event);
      root.__RetKitAiUi?.onBridgeEvent?.(event);
    });
    root.__RetKitAiContext?.attach?.({ bridgeClient, workspaceApi: root.__RetKitAiWorkspaceApi });
    return bridgeClient;
  }

  function ensureBridgeConnection() {
    const client = ensureBridgeClient();
    if (!client) return null;
    const connection = client.getState?.() || bridgeState;
    if (!['connected', 'connecting'].includes(String(connection?.status || ''))) client.connect();
    return client;
  }

  function selectAndConnectProvider(provider) {
    activeProvider = provider === 'claude' ? 'claude' : 'codex';
    try { root.localStorage?.setItem('retkit-ai-provider', activeProvider); } catch {}
    chat?.setProvider?.(activeProvider);
    renderProviders();
    ensureBridgeConnection();
    if (bridgeState.status !== 'connected') return;
    bridgeClient?.send?.('provider.select', { provider: activeProvider }).catch(() => {});
    if (['connected', 'busy', 'connecting'].includes(providerRuntime[activeProvider]?.state)) return;
    if (!providerInfo[activeProvider]?.detected) return;
    providerRuntime[activeProvider] = { state: 'connecting' };
    renderProviders();
    bridgeClient?.send?.('provider.connect', { provider: activeProvider }).catch((error) => {
      providerRuntime[activeProvider] = { state: 'error', detail: error?.message || String(error) };
      renderProviders();
    });
  }

  function mountAiPanel(api) {
    workspaceApi = api || workspaceApi;
    injectStyle();
    const editorPane = workspaceApi?.getEditorPaneElement?.() || document.getElementById('retkit-mo-editor-pane');
    const sourceHost = workspaceApi?.getSourceHostElement?.() || document.getElementById('retkit-mo-source-host');
    if (!editorPane || !sourceHost) return false;
    if (document.getElementById(IDS.stack)) {
      renderState();
      return true;
    }

    const stack = document.createElement('div');
    stack.id = IDS.stack;
    const panel = document.createElement('section');
    panel.id = IDS.panel;
    panel.innerHTML = `<div id="${IDS.header}"><strong id="retkit-ai-title">RetKit AI</strong><div class="rk-ai-provider-switch" aria-label="AI provider"><button type="button" class="rk-ai-choice" data-provider-choice="claude"><span class="rk-ai-provider-dot" aria-hidden="true"></span><span>Claude</span></button><button type="button" class="rk-ai-choice" data-provider-choice="codex"><span class="rk-ai-provider-dot" aria-hidden="true"></span><span>Codex</span></button></div><span id="${IDS.usage}"></span><span id="${IDS.status}">Bridge offline</span><button type="button" id="${IDS.toggle}" title="Open or collapse AI">⌄</button></div><div id="${IDS.body}"></div>`;
    const grip = document.createElement('div');
    grip.id = IDS.grip;
    grip.title = 'Drag to resize AI chat and code';

    sourceHost.parentElement?.insertBefore(stack, sourceHost);
    stack.append(sourceHost, grip, panel);

    root.__RetKitAiContext?.setMode?.('agent');
    chat = root.__RetKitAiChat?.createChatView?.({
      bridgeClient: ensureBridgeClient(),
      provider: activeProvider,
      mode: 'agent',
      getContext: () => root.__RetKitAiContext?.getInitialContext?.() || null,
    });
    const body = panel.querySelector(`#${IDS.body}`);
    if (body && chat?.element) body.appendChild(chat.element);

    panel.querySelectorAll('[data-provider-choice]').forEach((button) => {
      button.addEventListener('click', () => selectAndConnectProvider(button.dataset.providerChoice));
    });
    panel.querySelector(`#${IDS.toggle}`)?.addEventListener('click', (event) => { event.stopPropagation(); toggleAiPanel(); });
    panel.querySelector(`#${IDS.header}`)?.addEventListener('dblclick', () => toggleAiPanel());

    let dragging = false;
    grip.addEventListener('pointerdown', (event) => {
      if (!state.open) return;
      dragging = true;
      grip.setPointerCapture?.(event.pointerId);
      event.preventDefault?.();
    });
    grip.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const rect = stack.getBoundingClientRect();
      setAiPanelHeight(rect.bottom - event.clientY);
    });
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      refreshLayout();
    };
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);

    renderState();
    if (state.open) ensureBridgeConnection();
    renderProviders();
    return true;
  }

  root.__RetKitAiUi = {
    mountAiPanel,
    toggleAiPanel,
    setAiPanelHeight,
    getAiPanelState,
    getBridgeClient: () => bridgeClient,
    onBridgeEvent: null,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

(function (root) {
  'use strict';

  const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
  const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  // Языки, которые RetKit знает. Локаль — это язык и, с недавних пор у
  // MoEngage, регион: вкладки «Default, en_US, es_ES, ar_KW…». Раньше всё
  // сводилось к двум буквам, и en_US сливалась с Default в одну «EN».
  const KNOWN_LOCALES = new Set(['DEFAULT', 'EN', 'AR', 'ES', 'FR', 'ID', 'PT', 'TH', 'VI', 'DE', 'HI', 'TL', 'UR', 'BN', 'SV', 'JA']);

  /** Точный ключ локали: DEFAULT, EN, AR_KW, PT_PT. */
  function normaliseLocale(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^default$/i.test(raw)) return 'DEFAULT';
    const match = raw.match(/^([a-z]{2,3})(?:[-_]([a-z]{2,4}))?$/i);
    if (match) return match[2] ? `${match[1].toUpperCase()}_${match[2].toUpperCase()}` : match[1].toUpperCase();
    return raw.toUpperCase();
  }

  /** Язык локали: AR_KW → AR, DEFAULT → EN. */
  function localeLanguage(value) {
    const locale = normaliseLocale(value);
    if (!locale) return '';
    if (locale === 'DEFAULT') return 'EN';
    return locale.split('_')[0];
  }

  function isKnownLocale(value) {
    const locale = normaliseLocale(value);
    return Boolean(locale) && (locale === 'DEFAULT' || KNOWN_LOCALES.has(locale.split('_')[0]));
  }

  /** Как вкладка подписана в MoEngage: ar_KW, Default, AR. */
  function nativeLocaleLabels(value) {
    const locale = normaliseLocale(value);
    if (!locale) return [];
    if (locale === 'DEFAULT' || locale === 'EN') return ['Default', 'EN', 'en'];
    const [lang, region] = locale.split('_');
    if (!region) return [lang, lang.toLowerCase()];
    return [`${lang.toLowerCase()}_${region}`, locale, `${lang.toLowerCase()}-${region}`, `${lang.toLowerCase()}_${region.toLowerCase()}`];
  }

  function localeFromHtml(html) {
    const match = String(html || '').match(/<html\b[^>]*\blang\s*=\s*(["'])(.*?)\1/i);
    return match ? normaliseLocale(match[2]) : '';
  }

  function isArabicLocale(locale) {
    return localeLanguage(locale) === 'AR';
  }

  function displayLocale(value) {
    const locale = normaliseLocale(value);
    return locale === 'DEFAULT' ? 'EN' : locale;
  }

  function localeAliases(value) {
    const locale = normaliseLocale(value);
    if (locale === 'EN') return ['EN', 'DEFAULT'];
    if (locale === 'DEFAULT') return ['DEFAULT', 'EN'];
    return locale ? [locale] : [];
  }

  function filterKnownLocales(values) {
    const seen = new Set();
    const result = [];
    for (const value of values || []) {
      const locale = normaliseLocale(value);
      if (!isKnownLocale(locale)) continue;
      const shown = displayLocale(locale);
      if (!shown || seen.has(shown)) continue;
      seen.add(shown);
      result.push(shown);
    }
    return result;
  }

  function sortLocalesForUi(values) {
    const locales = filterKnownLocales(values);
    // Default (EN) первой, за ней английские с регионом, дальше по алфавиту.
    const rest = locales.filter((locale) => locale !== 'EN')
      .sort((a, b) => (localeLanguage(a) === 'EN' ? 0 : 1) - (localeLanguage(b) === 'EN' ? 0 : 1) || a.localeCompare(b, 'en'));
    return locales.includes('EN') ? ['EN', ...rest] : rest;
  }

  /** Подпись в RetKit как во вкладке MoEngage: Default, en_US, ar_KW, AR. */
  function localeUiLabel(value) {
    const locale = displayLocale(value);
    if (!locale) return '';
    if (locale === 'EN') return 'Default';
    const [lang, region] = locale.split('_');
    return region ? `${lang.toLowerCase()}_${region}` : lang;
  }

  function resolveActiveLocale(renderedHtml, editorHtml, nativeLocale) {
    const htmlLocale = localeFromHtml(renderedHtml) || localeFromHtml(editorHtml);
    const native = nativeLocale ? displayLocale(nativeLocale) : '';
    if (!htmlLocale) return native;
    if (!native) return displayLocale(htmlLocale);
    // Тот же язык — берём точную вкладку (lang="ar" во вкладке ar_KW).
    if (localeLanguage(htmlLocale) === localeLanguage(native)) return native;
    // Шаблон часто оставляет lang="en" во всех локалях: так вкладка ar_KW
    // показывалась в RetKit как EN. Английский lang вкладку не перебивает.
    if (localeLanguage(htmlLocale) === 'EN') return native;
    // Иной язык в HTML — вкладка MoEngage отстала после перерисовки.
    return displayLocale(htmlLocale);
  }

  /** Двухбуквенный язык → точная вкладка, если вкладка этого языка одна. */
  function matchLocaleToTabs(locale, tabLocales) {
    const key = displayLocale(locale);
    if (!key || key.includes('_')) return key;
    const tabs = (tabLocales || []).map(displayLocale);
    if (tabs.includes(key)) return key;
    const same = tabs.filter((tab) => tab !== 'EN' && localeLanguage(tab) === key);
    return same.length === 1 ? same[0] : key;
  }

  function stripHtmlText(value) {
    return String(value || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseTagName(token) {
    const match = String(token || '').match(/^<\/?\s*([a-zA-Z][\w:-]*)/);
    return match ? match[1].toLowerCase() : '';
  }

  function scanElementRanges(source) {
    const input = String(source || '');
    const stack = [];
    const ranges = [];
    const tokenRe = /<!--[\s\S]*?-->|<\/?\s*[a-zA-Z][\w:-]*\b[^>]*>/g;
    let match;

    while ((match = tokenRe.exec(input))) {
      const token = match[0];
      if (token.startsWith('<!--')) continue;
      const tag = parseTagName(token);
      if (!tag) continue;
      const closing = /^<\//.test(token);
      const selfClosing = /\/\s*>$/.test(token) || VOID_TAGS.has(tag);

      if (!closing) {
        const node = {
          tag,
          openStart: match.index,
          openEnd: match.index + token.length,
          closeStart: match.index + token.length,
          closeEnd: match.index + token.length,
          parent: stack.length ? stack[stack.length - 1] : null,
        };
        ranges.push(node);
        if (!selfClosing) stack.push(node);
        continue;
      }

      let index = stack.length - 1;
      while (index >= 0 && stack[index].tag !== tag) index -= 1;
      if (index < 0) continue;
      const node = stack[index];
      node.closeStart = match.index;
      node.closeEnd = match.index + token.length;
      stack.length = index;
    }

    return ranges;
  }

  function isTextLikeSubjectFieldMeta(meta = {}) {
    const tagName = String(meta.tagName || '').toUpperCase();
    const placeholder = String(meta.placeholder || '');
    const contentEditable = String(meta.contentEditable ?? '').toLowerCase();
    if (tagName === 'TEXTAREA') return true;
    if (tagName === 'DIV' && contentEditable === 'true' && /subject/i.test(placeholder)) return true;
    if (tagName !== 'INPUT') return false;
    const type = String(meta.type || 'text').toLowerCase();
    return ['', 'text', 'search', 'email', 'url', 'tel'].includes(type);
  }

  function isTextLikeSubjectFieldElement(element) {
    if (!element) return false;
    return isTextLikeSubjectFieldMeta({
      tagName: element.tagName,
      type: element.getAttribute?.('type') || element.type || '',
      placeholder: element.getAttribute?.('placeholder') || '',
      contentEditable: element.getAttribute?.('contenteditable') || element.contentEditable || '',
    });
  }

  function isMdsDropdownMeta(meta = {}) {
    return /(?:^|\s)mds-dropdown(?:\s|$)/.test(String(meta.className || ''));
  }

  function isMdsPopupOptionMeta(meta = {}, wantedLabel = '') {
    const className = String(meta.className || '');
    const text = String(meta.text || '').replace(/\s+/g, ' ').trim();
    const wanted = String(wantedLabel || '').replace(/\s+/g, ' ').trim();
    return /(?:^|\s)mds-dropdown__popup__list__item(?:\s|$)/.test(className) && text === wanted;
  }

  function rtlToggleDecision(beforeHtml, afterHtml, currentHtml) {
    const equivalent = (left, right) => {
      try {
        const compare = root.__RetKitMoEngageCore?.htmlEquivalentForSync;
        if (typeof compare === 'function') return Boolean(compare(left, right));
      } catch {}
      return String(left ?? '') === String(right ?? '');
    };
    return equivalent(afterHtml, currentHtml) && !equivalent(beforeHtml, afterHtml)
      ? 'revert'
      : 'apply';
  }

  function ensureRtlOpeningTag(openingTag) {
    const original = String(openingTag || '');
    if (!/^<\s*[a-zA-Z]/.test(original)) return { value: original, changed: false };
    let value = original;

    if (/\bdir\s*=\s*(["'])[^"']*\1/i.test(value)) {
      value = value.replace(/\bdir\s*=\s*(["'])[^"']*\1/i, 'dir="rtl"');
    } else {
      value = value.replace(/^(<\s*[a-zA-Z][\w:-]*)/, '$1 dir="rtl"');
    }

    value = value.replace(/\balign\s*=\s*(["'])\s*left\s*\1/gi, 'align="right"');

    const styleMatch = value.match(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i);
    if (styleMatch) {
      const nextStyle = styleMatch[2].replace(/text-align\s*:\s*left\b/gi, 'text-align: right');
      if (nextStyle !== styleMatch[2]) {
        const replacement = `style=${styleMatch[1]}${nextStyle}${styleMatch[1]}`;
        value = value.slice(0, styleMatch.index) + replacement + value.slice(styleMatch.index + styleMatch[0].length);
      }
    }

    return { value, changed: value !== original };
  }

  function nearestAncestor(node, tagName) {
    let cursor = node?.parent || null;
    const wanted = String(tagName || '').toLowerCase();
    while (cursor) {
      if (cursor.tag === wanted) return cursor;
      cursor = cursor.parent;
    }
    return null;
  }

  function transformRtlHtml(source, options = {}) {
    const input = String(source || '');
    const allParagraphs = options?.allParagraphs === true;
    const ranges = scanElementRanges(input);
    const paragraphTargets = [];
    const cellTargets = new Set();

    for (const node of ranges) {
      if (node.tag !== 'p' || node.closeStart <= node.openEnd) continue;
      const text = stripHtmlText(input.slice(node.openEnd, node.closeStart));
      if (!text) continue;
      if (!allParagraphs && !ARABIC_RE.test(text)) continue;
      paragraphTargets.push(node);
      const cell = nearestAncestor(node, 'td');
      if (cell) cellTargets.add(cell);
    }

    const replacementsByStart = new Map();
    let paragraphCount = 0;
    let cellCount = 0;
    let alignCount = 0;

    const queueOpeningTag = (node, counter) => {
      const opening = input.slice(node.openStart, node.openEnd);
      const result = ensureRtlOpeningTag(opening);
      if (!result.changed) return;
      if (replacementsByStart.has(node.openStart)) return;
      replacementsByStart.set(node.openStart, { start: node.openStart, end: node.openEnd, value: result.value });
      counter();
    };

    for (const node of paragraphTargets) queueOpeningTag(node, () => { paragraphCount += 1; });
    for (const node of cellTargets) queueOpeningTag(node, () => { cellCount += 1; });

    // Email templates often position CTA/button tables with legacy align="left".
    // Flip only explicit left alignment, without rewriting unrelated containers.
    for (const node of ranges) {
      const opening = input.slice(node.openStart, node.openEnd);
      if (!/\balign\s*=\s*(["'])\s*left\s*\1/i.test(opening)) continue;
      if (replacementsByStart.has(node.openStart)) continue;
      queueOpeningTag(node, () => { alignCount += 1; });
    }

    const replacements = [...replacementsByStart.values()].sort((a, b) => b.start - a.start);
    let html = input;
    for (const replacement of replacements) {
      html = html.slice(0, replacement.start) + replacement.value + html.slice(replacement.end);
    }

    return {
      html,
      paragraphCount,
      cellCount,
      alignCount,
      totalCount: paragraphCount + cellCount + alignCount,
    };
  }

  function normaliseTestPreferences(value) {
    const input = value || {};
    const locales = [];
    const seen = new Set();
    for (const item of Array.isArray(input.locales) ? input.locales : []) {
      const locale = displayLocale(item);
      if (!locale || !isKnownLocale(item) || seen.has(locale)) continue;
      seen.add(locale);
      locales.push(locale);
    }
    const sendViaOptions = new Set([
      'Custom Segment',
      'Email ID (Registered users)',
      'Email ID (Non-registered users)',
      'Unique ID',
      'Mobile Number',
    ]);
    const sendVia = sendViaOptions.has(String(input.sendVia || '').trim())
      ? String(input.sendVia).trim()
      : 'Email ID (Non-registered users)';
    return {
      email: String(input.email || '').trim(),
      locales,
      personalise: input.personalise !== false,
      sendVia,
    };
  }

  function shouldAllowRtlFix(activeLocale, html) {
    if (isArabicLocale(activeLocale)) return true;
    if (isArabicLocale(localeFromHtml(html))) return true;
    return ARABIC_RE.test(stripHtmlText(html));
  }

  function labeledControlGeometryScore(labelRect, controlRect) {
    if (!labelRect || !controlRect) return Infinity;
    const vertical = Math.max(0, controlRect.top - labelRect.bottom);
    const reverse = Math.max(0, labelRect.top - controlRect.bottom);
    const leftDelta = Math.abs(controlRect.left - labelRect.left);
    const labelCenter = (labelRect.left + labelRect.right) / 2;
    const controlCenter = (controlRect.left + controlRect.right) / 2;
    const centerDelta = Math.abs(controlCenter - labelCenter);
    return vertical * 4 + reverse * 14 + leftDelta * 1.2 + centerDelta * 0.05;
  }

  function createNativeActivationEvent(type) {
    const init = { bubbles: true, cancelable: true, view: root };
    try {
      const Ctor = type.startsWith('pointer') ? root.PointerEvent : root.MouseEvent;
      if (Ctor) return new Ctor(type, init);
    } catch {}
    try {
      if (root.MouseEvent) return new root.MouseEvent(type, init);
    } catch {}
    try {
      if (root.Event) return new root.Event(type, { bubbles: true, cancelable: true });
    } catch {}
    return { type };
  }

  function activateNativeControl(element, eventFactory = createNativeActivationEvent) {
    if (!element) return false;
    try { element.focus?.({ preventScroll: true }); } catch { try { element.focus?.(); } catch {} }
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      try { element.dispatchEvent?.(eventFactory(type)); } catch {}
    }
    try { element.click?.(); } catch {
      try { element.dispatchEvent?.(eventFactory('click')); } catch {}
    }
    return true;
  }

  function reactPropsOf(element) {
    if (!element) return null;
    const directKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
    if (directKey && element[directKey]) return element[directKey];
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    return fiberKey ? (element[fiberKey]?.memoizedProps || null) : null;
  }

  function invokeReactHandler(element, handlerName, target = element) {
    const handler = reactPropsOf(element)?.[handlerName];
    if (typeof handler !== 'function') return false;

    const eventType = handlerName === 'onMouseDown' ? 'mousedown' : 'click';
    const eventTarget = target || element;
    const rect = eventTarget?.getBoundingClientRect?.();
    const clientX = rect ? rect.left + rect.width / 2 : 100;
    const clientY = rect ? rect.top + rect.height / 2 : 100;
    const buttons = handlerName === 'onMouseDown' ? 1 : 0;

    // Live MoEngage MDS reads mouse metadata from nativeEvent, not only from
    // React's synthetic wrapper. A synthetic event with an empty nativeEvent
    // reports success but does not open the dropdown.
    let nativeEvent = null;
    try {
      const Ctor = root.MouseEvent || MouseEvent;
      nativeEvent = new Ctor(eventType, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons,
        clientX,
        clientY,
        view: root,
      });
    } catch {
      try { nativeEvent = createNativeActivationEvent(eventType); } catch {}
    }

    const synthetic = {
      type: eventType,
      button: 0,
      buttons,
      clientX,
      clientY,
      target: eventTarget,
      currentTarget: element,
      nativeEvent,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; try { nativeEvent?.preventDefault?.(); } catch {} },
      stopPropagation() { this.propagationStopped = true; try { nativeEvent?.stopPropagation?.(); } catch {} },
      isDefaultPrevented() { return this.defaultPrevented; },
      isPropagationStopped() { return this.propagationStopped; },
      persist() {},
    };
    try {
      handler(synthetic);
      return true;
    } catch (error) {
      diagBreadcrumb('react-handler.invoke-failed', { handlerName, message: error?.message || String(error) });
      return false;
    }
  }

  function activateReactClickable(element) {
    if (!element) return false;
    const clickable = element.closest?.('[role="button"],button') || element;
    if (invokeReactHandler(clickable, 'onClick', clickable)) return true;
    if (invokeReactHandler(element, 'onClick', element)) return true;
    return activateNativeControl(clickable);
  }

  function mdsDropdownHost(control) {
    const trigger = dropdownClickable(control) || control;
    return trigger?.closest?.('.mds-dropdown') || control?.closest?.('.mds-dropdown') || null;
  }

  function activateMdsDropdown(control) {
    const trigger = dropdownClickable(control) || control;
    const host = mdsDropdownHost(control);
    if (!trigger && !host) return false;
    const target = host || trigger;
    try { target.focus?.({ preventScroll: true }); } catch { try { target.focus?.(); } catch {} }

    // Live MoEngage MDS dropdowns keep the actual toggle callback on the
    // parent .mds-dropdown React onMouseDown prop. A DOM dispatchEvent() can
    // succeed without opening the portal, so calling it first created a false
    // positive and RetKit then searched an empty/non-existent popup. Prefer the
    // verified React handler and keep DOM activation only as a fallback for
    // other MDS builds.
    if (host && invokeReactHandler(host, 'onMouseDown', trigger || host)) return true;
    if (host && invokeReactHandler(host, 'onClick', trigger || host)) return true;

    try {
      target.dispatchEvent?.(createNativeActivationEvent('mousedown'));
      return true;
    } catch {}
    return activateNativeControl(trigger || target);
  }

  function testLocaleLabelToDisplay(label) {
    const raw = String(label || '').replace(/\s+/g, ' ').trim();
    if (/^default$/i.test(raw)) return 'EN';
    return displayLocale(raw);
  }

  function localeCodeFromLabel(value) {
    const raw = String(value || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    if (/^(?:add|new|all)$/i.test(raw)) return '';
    if (/^default$/i.test(raw)) return 'EN';
    if (!/^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/i.test(raw)) return '';
    return displayLocale(normaliseLocale(raw));
  }

  function normaliseAddableLocaleLabels(labels, existingLocales = []) {
    const existing = new Set((existingLocales || []).map(localeCodeFromLabel).filter(Boolean));
    const seen = new Set();
    const result = [];
    for (const label of labels || []) {
      const locale = localeCodeFromLabel(label);
      if (!locale || existing.has(locale) || seen.has(locale)) continue;
      seen.add(locale);
      result.push(locale);
    }
    return result.sort((a, b) => a.localeCompare(b, 'en'));
  }

  function addLocaleTriggerLabelMatches(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return /^(?:\+\s*)?locale$/.test(text) || /^(?:add|new)\s+locale$/.test(text);
  }

  function canRemoveLocale(value) {
    const locale = normaliseLocale(value);
    return Boolean(locale && locale !== 'EN' && locale !== 'DEFAULT');
  }

  function localeAddSelectionPlan(existingLocales, availableLocales, requestedLocales) {
    const existing = new Set((existingLocales || []).map(localeCodeFromLabel).filter(Boolean));
    const available = new Set((availableLocales || []).map(localeCodeFromLabel).filter(Boolean));
    const selected = [];
    const alreadyPresent = [];
    const missing = [];
    const seen = new Set();
    for (const raw of requestedLocales || []) {
      const locale = localeCodeFromLabel(raw);
      if (!locale || seen.has(locale)) continue;
      seen.add(locale);
      if (existing.has(locale)) alreadyPresent.push(locale);
      else if (available.has(locale)) selected.push(locale);
      else missing.push(locale);
    }
    return { selected, alreadyPresent, missing };
  }

  function localeAddActivationTarget(item = {}) {
    const row = item?.row || null;
    const control = item?.control || null;
    const rowTag = String(row?.tagName || '').toUpperCase();
    const rowRole = String(row?.getAttribute?.('role') || '').toLowerCase();
    if (row && (rowTag === 'LABEL' || rowRole === 'option' || rowRole === 'menuitem' || rowRole === 'checkbox')) return row;
    return row || control || null;
  }

  function resolveTestLocaleSelectionPlan(requestedLocales, popupLabels) {
    const requested = filterKnownLocales(requestedLocales || []);
    const labelByLocale = new Map();
    for (const rawLabel of popupLabels || []) {
      const label = String(rawLabel || '').replace(/\s+/g, ' ').trim();
      const locale = testLocaleLabelToDisplay(label);
      if (!locale || labelByLocale.has(locale)) continue;
      labelByLocale.set(locale, label);
    }
    const labels = [];
    const missing = [];
    for (const locale of requested) {
      let label = labelByLocale.get(locale);
      // Сохранённый выбор из старых двухбуквенных времён («AR»), а в окне
      // теста теперь «ar_KW»: берём единственную локаль этого языка.
      if (!label && !locale.includes('_')) {
        const sameLanguage = [...labelByLocale.keys()].filter((key) => key !== 'EN' && localeLanguage(key) === locale);
        if (sameLanguage.length === 1) label = labelByLocale.get(sameLanguage[0]);
      }
      if (!label) missing.push(locale);
      else labels.push(label);
    }
    const available = [...labelByLocale.keys()];
    const useSelectAll = requested.length > 1 && missing.length === 0 && available.length > 0 && requested.length === available.length
      && requested.every((locale) => labelByLocale.has(locale));
    return { requested, labels, missing, available, useSelectAll };
  }

  const core = {
    normaliseLocale,
    localeLanguage,
    isKnownLocale,
    localeUiLabel,
    nativeLocaleLabels,
    localeFromHtml,
    isArabicLocale,
    displayLocale,
    localeAliases,
    filterKnownLocales,
    sortLocalesForUi,
    resolveActiveLocale,
    matchLocaleToTabs,
    transformRtlHtml,
    normaliseTestPreferences,
    shouldAllowRtlFix,
    scanElementRanges,
    ensureRtlOpeningTag,
    isTextLikeSubjectFieldMeta,
    isMdsDropdownMeta,
    isMdsPopupOptionMeta,
    rtlToggleDecision,
    testLocaleLabelToDisplay,
    localeCodeFromLabel,
    normaliseAddableLocaleLabels,
    addLocaleTriggerLabelMatches,
    canRemoveLocale,
    localeAddSelectionPlan,
    localeAddActivationTarget,
    resolveTestLocaleSelectionPlan,
    labeledControlGeometryScore,
    activateNativeControl,
    setTextContentIfChanged,
    buildStoredZip,
    safeBackupName,
    findTestCampaignLocaleControl,
  };
  root.__RetKitMoEngageBridgeCore = core;

  if (typeof document === 'undefined' || !root.location || root.location.hostname !== 'dashboard-02.moengage.com') return;

  const IDS = {
    workspace: 'retkit-mo-workspace',
    sourceHost: 'retkit-mo-source-host',
    status: 'retkit-mo-status',
    localeRow: 'retkit-mo-locale-row',
    localeStrip: 'retkit-mo-locale-strip',
    localeLoading: 'retkit-mo-locale-loading',
    subjectRow: 'retkit-mo-subject-row',
    subjectInput: 'retkit-mo-subject-input',
    rtlButton: 'retkit-mo-rtl-button',
    testButton: 'retkit-mo-test-button',
    originalButton: 'retkit-mo-original-button',
    originalPopover: 'retkit-mo-original-popover',
    testPopover: 'retkit-mo-test-popover',
    addLocaleButton: 'retkit-mo-add-locale-button',
    backupLocalesButton: 'retkit-mo-backup-locales-button',
    addLocalePopover: 'retkit-mo-add-locale-popover',
    nativeLocaleAssist: 'retkit-mo-native-locale-assist',
    bridgeStyle: 'retkit-mo-v050-style',
  };

  const STORAGE = {
    testPrefs: 'retkit-mo-v050-test-prefs',
  };

  let localeTimer = null;
  let subjectTimer = null;
  const rtlToggleStates = new Map();
  let nativeLocaleBarCache = null;

  function diagBreadcrumb(type, meta = {}) {
    try { root.__RetKitDiagnostics?.breadcrumb?.(type, meta); } catch {}
  }

  function diagIncident(type, message, meta = {}) {
    try { root.__RetKitDiagnostics?.incident?.(type, message, meta); } catch {}
  }

  function zipDosTimeDate(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((Math.floor(date.getSeconds() / 2)) & 31);
    const day = ((year - 1980) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
    return { time, day };
  }

  function crc32Bytes(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function concatBytes(parts) {
    const size = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  }

  function zipHeader(size) {
    return new Uint8Array(size);
  }

  function setU16(view, offset, value) { view.setUint16(offset, value >>> 0, true); }
  function setU32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

  function buildStoredZip(entries = []) {
    const encoder = new TextEncoder();
    const locals = [];
    const centrals = [];
    let localOffset = 0;
    const stamp = zipDosTimeDate(new Date());
    for (const entry of entries) {
      const nameBytes = encoder.encode(String(entry.name || 'file'));
      const dataBytes = encoder.encode(String(entry.text ?? ''));
      const crc = crc32Bytes(dataBytes);
      const local = zipHeader(30);
      const lv = new DataView(local.buffer);
      setU32(lv, 0, 0x04034b50);
      setU16(lv, 4, 20);
      setU16(lv, 6, 0x0800);
      setU16(lv, 8, 0);
      setU16(lv, 10, stamp.time);
      setU16(lv, 12, stamp.day);
      setU32(lv, 14, crc);
      setU32(lv, 18, dataBytes.length);
      setU32(lv, 22, dataBytes.length);
      setU16(lv, 26, nameBytes.length);
      setU16(lv, 28, 0);
      const localRecord = concatBytes([local, nameBytes, dataBytes]);
      locals.push(localRecord);

      const central = zipHeader(46);
      const cv = new DataView(central.buffer);
      setU32(cv, 0, 0x02014b50);
      setU16(cv, 4, 20);
      setU16(cv, 6, 20);
      setU16(cv, 8, 0x0800);
      setU16(cv, 10, 0);
      setU16(cv, 12, stamp.time);
      setU16(cv, 14, stamp.day);
      setU32(cv, 16, crc);
      setU32(cv, 20, dataBytes.length);
      setU32(cv, 24, dataBytes.length);
      setU16(cv, 28, nameBytes.length);
      setU16(cv, 30, 0);
      setU16(cv, 32, 0);
      setU16(cv, 34, 0);
      setU16(cv, 36, 0);
      setU32(cv, 38, 0);
      setU32(cv, 42, localOffset);
      centrals.push(concatBytes([central, nameBytes]));
      localOffset += localRecord.length;
    }
    const localBytes = concatBytes(locals);
    const centralBytes = concatBytes(centrals);
    const end = zipHeader(22);
    const ev = new DataView(end.buffer);
    setU32(ev, 0, 0x06054b50);
    setU16(ev, 4, 0);
    setU16(ev, 6, 0);
    setU16(ev, 8, entries.length);
    setU16(ev, 10, entries.length);
    setU32(ev, 12, centralBytes.length);
    setU32(ev, 16, localBytes.length);
    setU16(ev, 20, 0);
    return concatBytes([localBytes, centralBytes, end]);
  }

  function safeBackupName(value) {
    const cleaned = String(value || '').trim().replace(/[\\/:*?\"<>|]+/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    return cleaned || 'retkit-locale-backup';
  }

  function backupDownloadIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11"></path><path d="m8 10 4 4 4-4"></path><path d="M5 18v2h14v-2"></path></svg>';
  }

  function knownLocaleBackupFallback() {
    const strip = document.getElementById(IDS.localeStrip);
    const values = String(strip?.dataset?.locales || '')
      .split(',')
      .map((item) => displayLocale(item))
      .filter(Boolean);
    return [...new Set(values)];
  }

  async function downloadLocaleBackup() {
    const button = document.getElementById(IDS.backupLocalesButton);
    if (button?.disabled) return;
    if (button) button.disabled = true;

    let locales = [];
    let origin = '';
    let saveHandle = null;
    let folder = '';
    let filename = '';
    diagBreadcrumb('locale.backup.start', {});

    try {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const suggested = `retkit-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

      // Chrome requires the native save picker to be opened while the original
      // user click is still active. Reserve the destination before any locale
      // switching/await-heavy backup work begins.
      if (typeof root.showSaveFilePicker === 'function') {
        try {
          saveHandle = await root.showSaveFilePicker({
            suggestedName: `${suggested}.zip`,
            types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
          });
        } catch (error) {
          if (error?.name === 'AbortError') {
            workspaceStatus('Backup cancelled', 'neutral');
            diagBreadcrumb('locale.backup.cancelled', {});
            return;
          }
          throw error;
        }
        filename = String(saveHandle?.name || `${suggested}.zip`);
        folder = safeBackupName(filename.replace(/\.zip$/i, ''));
      } else {
        const entered = typeof root.prompt === 'function' ? root.prompt('Backup name', suggested) : suggested;
        if (entered == null) return;
        folder = safeBackupName(entered);
        filename = `${folder}.zip`;
      }

      try {
        await discoverNativeLocalesDeep();
        locales = discoverNativeLocales();
      } catch (error) {
        diagBreadcrumb('locale.backup.discovery-fallback', { reason: error?.message || String(error) });
      }
      if (!locales.length) locales = knownLocaleBackupFallback();
      if (!locales.length) throw new Error('No MoEngage locales found to back up');

      origin = getNativeSelectedLocale() || getNativeEditorLocale() || getActiveLocale();
      const entries = [];
      workspaceStatus(`Backing up ${locales.length} locale(s)…`, 'neutral');
      for (let index = 0; index < locales.length; index += 1) {
        const locale = displayLocale(locales[index]);
        workspaceStatus(`Backup ${index + 1}/${locales.length} · ${locale}`, 'neutral');
        const html = String(await readNativeLocaleHtmlFast(locale) || '');
        entries.push({ name: `${folder}/${locale}/index.html`, text: html });
      }
      if (origin) await switchNativeLocale(origin, { rebind: false, preferNative: true, timeoutMs: 2400 });

      const bytes = buildStoredZip(entries);
      const blob = new Blob([bytes], { type: 'application/zip' });
      if (saveHandle?.createWritable) {
        const writable = await saveHandle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename || `${folder}.zip`;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      }
      workspaceStatus(`Downloaded backup · ${locales.length} locale(s)`, 'ok');
      diagBreadcrumb('locale.backup.downloaded', { localeCount: locales.length, filename: filename || `${folder}.zip` });
    } catch (error) {
      try { if (origin) await switchNativeLocale(origin, { rebind: false, preferNative: true, timeoutMs: 2400 }); } catch {}
      diagIncident('locale_backup_failed', error?.message || String(error), { localeCount: locales.length });
      workspaceStatus(`Backup failed: ${error?.message || error}`, 'error');
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }

  function workspaceStatus(message, tone = 'neutral') {
    const el = document.getElementById(IDS.status);
    if (!el) return;
    el.textContent = message;
    el.dataset.tone = tone;
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const style = root.getComputedStyle?.(element);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    const rect = element.getBoundingClientRect?.();
    return !rect || rect.width > 0 || rect.height > 0;
  }

  function textOf(element) {
    return String(element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function setTextContentIfChanged(element, value) {
    if (!element) return false;
    const next = String(value ?? '');
    if (element.textContent === next) return false;
    element.textContent = next;
    return true;
  }

  function exactLocaleFromText(value) {
    const raw = String(value || '').trim();
    if (/^default$/i.test(raw)) return 'DEFAULT';
    if (/^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/i.test(raw)) return normaliseLocale(raw);
    return '';
  }

  function localeCodeFromOptionElement(element) {
    if (!element) return '';
    return localeCodeFromLabel(textOf(element)) || localeCodeFromLabel(element.getAttribute?.('value'));
  }

  function injectBridgeStyle() {
    if (document.getElementById(IDS.bridgeStyle)) return;
    const style = document.createElement('style');
    style.id = IDS.bridgeStyle;
    style.textContent = `
      .rk-v050-popover { position:fixed; top:58px; right:12px; z-index:2147483647; width:min(430px,calc(100vw - 24px));
        max-height:72vh; overflow:auto; padding:10px; color:#dce6f4; background:#111823; border:1px solid #334155;
        border-radius:10px; box-shadow:0 18px 50px rgba(0,0,0,.42); font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      .rk-v050-head { display:flex; align-items:center; gap:8px; margin-bottom:9px; padding-bottom:8px; border-bottom:1px solid #263140; }
      .rk-v050-head strong { flex:1; }
      .rk-v050-grid { display:grid; gap:8px; }
      .rk-v050-input, .rk-v050-select { width:100%; min-height:34px; border:1px solid #334155; border-radius:8px; padding:6px 8px;
        background:#0b111a; color:#e9eef7; outline:none; }
      .rk-v050-row { display:flex; align-items:center; gap:8px; }
      .rk-v050-hint { color:#8293a8; font-size:11px; line-height:1.35; }
      #${IDS.nativeLocaleAssist} { position:fixed; top:12px; left:50%; transform:translateX(-50%); z-index:2147483647; display:flex; align-items:center; gap:10px;
        max-width:min(720px,calc(100vw - 24px)); padding:9px 11px; border:1px solid #3b4d66; border-radius:10px; background:#111b28; color:#dce6f4;
        box-shadow:0 12px 34px rgba(0,0,0,.35); font:600 12px/1.35 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      #${IDS.nativeLocaleAssist} span { min-width:0; }
      #${IDS.nativeLocaleAssist} button { flex:0 0 auto; border:1px solid #4c75e7; background:#315be9; color:#fff; border-radius:7px; padding:6px 9px; cursor:pointer; font:700 11px/1 inherit; }
      #${IDS.localeRow} { min-height:40px; flex:0 0 40px; display:flex; align-items:center; gap:10px; padding:0 12px; background:#0f1620; border-bottom:1px solid #263140; }
      #${IDS.subjectRow} { min-height:44px; flex:0 0 44px; display:flex; align-items:center; gap:10px; padding:0 12px; background:#0d141e; border-bottom:1px solid #263140; }
      #${IDS.subjectInput} { flex:1 1 auto; min-width:120px; height:30px; border:1px solid #334155; border-radius:7px; padding:5px 9px; background:#0b111a; color:#e9eef7; outline:none; font:500 12px/1.2 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      #${IDS.subjectInput}:focus { border-color:#4f7cff; box-shadow:0 0 0 2px rgba(79,124,255,.16); }
      #${IDS.localeLoading} { position:absolute; inset:52px 0 0; z-index:30; display:grid; place-items:center; background:rgba(13,17,24,.94); color:#dce6f4; font:700 14px/1.3 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; backdrop-filter:blur(1px); }
      .rk-v054-test-locales { display:flex; flex-wrap:wrap; gap:6px; padding:2px 0; }
      .rk-v054-test-locale { display:inline-flex; align-items:center; gap:5px; border:1px solid #334155; border-radius:7px; padding:5px 7px; background:#0b111a; color:#dce6f4; font-size:11px; cursor:pointer; }
      .rk-v054-test-actions { display:flex; gap:6px; flex-wrap:wrap; }
      .rk-v053-locale-label { color:#71839a; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
      #${IDS.localeStrip} { display:flex; align-items:stretch; gap:2px; min-width:0; overflow-x:auto; overflow-y:hidden; scrollbar-width:thin; flex:1 1 auto; }
      #${IDS.localeStrip}::-webkit-scrollbar { height:4px; }
      #${IDS.localeStrip}::-webkit-scrollbar-thumb { background:#334155; border-radius:8px; }
      #${IDS.addLocaleButton} { flex:0 0 auto; border:1px solid #334155; border-radius:7px; background:#111b28; color:#a9b9cd; padding:6px 9px; cursor:pointer; font:600 11px/1 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif; }
      #${IDS.addLocaleButton}:hover { color:#fff; border-color:#4f7cff; }
      #${IDS.backupLocalesButton} { flex:0 0 auto; min-width:92px; height:30px; display:inline-flex; align-items:center; justify-content:center; gap:5px;
        padding:0; border:1px solid #334155; border-radius:7px; background:#111b28; color:#a9b9cd; cursor:pointer; appearance:none; -webkit-appearance:none; }
      #${IDS.backupLocalesButton}:hover { color:#fff; border-color:#4f7cff; background:#162131; }
      #${IDS.backupLocalesButton}:disabled { opacity:.5; cursor:default; }
      #${IDS.backupLocalesButton} span { font:600 11px/1 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif; }\n      #${IDS.backupLocalesButton} svg { width:15px; height:15px; display:block; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
      .rk-v060-locale-list { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px; }
      .rk-v060-locale-choice { display:flex; align-items:center; gap:6px; min-height:30px; padding:5px 7px; border:1px solid #334155; border-radius:7px; background:#0b111a; color:#dce6f4; font-size:11px; }
      .rk-v061-locale-wrap { display:inline-flex; align-items:center; flex:0 0 auto; border-radius:7px; }
      .rk-v061-locale-wrap:hover { background:#162131; }
      .rk-v061-locale-remove { border:0; background:transparent; color:#657890; width:20px; height:26px; padding:0; cursor:pointer; font:700 14px/1 inherit; border-radius:5px; }
      .rk-v061-locale-remove:hover { color:#ff858c; background:rgba(255,133,140,.08); }
      .rk-v052-locale-tab { position:relative; flex:0 0 auto; border:0; background:transparent; color:#91a0b5; padding:8px 9px 7px; cursor:pointer; font:600 12px/1.1 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      .rk-v052-locale-tab:hover { color:#dce6f4; }
      .rk-v052-locale-tab.rk-active { color:#fff; }
      .rk-v052-locale-tab.rk-active::after { content:""; position:absolute; left:7px; right:7px; bottom:1px; height:2px; border-radius:2px; background:#4f7cff; }
      .rk-v050-primary { border:1px solid #4c75e7; background:#315be9; color:white; border-radius:8px; padding:8px 11px; cursor:pointer; font-weight:700; }
      .rk-v050-secondary { border:1px solid #334155; background:#172130; color:#dce6f4; border-radius:8px; padding:7px 10px; cursor:pointer; }
      #${IDS.rtlButton}.rk-active { background:#284fbe; border-color:#4c75e7; color:#fff; }
    `;
    document.head.appendChild(style);
  }

  function getOverlayEditor() {
    return document.querySelector(`#${IDS.sourceHost} .CodeMirror`)?.CodeMirror || null;
  }

  function getNativeEditorOutsideWorkspace() {
    const workspace = document.getElementById(IDS.workspace);
    const node = [...document.querySelectorAll('.CodeMirror')].find((candidate) => !workspace?.contains(candidate) && candidate?.CodeMirror);
    return node?.CodeMirror || null;
  }

  function getNativeEditorLocale() {
    return displayLocale(localeFromHtml(getNativeEditorOutsideWorkspace()?.getValue?.() || ''));
  }

  async function waitForNativeLocaleActivation(locale, timeoutMs = 2600) {
    const wanted = displayLocale(locale);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const nativeSelected = getNativeSelectedLocale();
      const nativeEditorLocale = getNativeEditorLocale();
      const rendered = displayLocale(localeFromHtml(getRenderedHtml()));
      if (nativeSelected === wanted || nativeEditorLocale === wanted || rendered === wanted) return true;
      await wait(80);
    }
    return false;
  }

  function getRenderedHtml() {
    return document.querySelector('#sidePreview')?.getAttribute('srcdoc') || '';
  }

  function getActiveLocale() {
    const renderedHtml = getRenderedHtml();
    const editorHtml = getOverlayEditor()?.getValue?.() || '';
    // MoEngage can leave selected-tab metadata stale while React remounts a
    // locale editor. The actual rendered/source HTML is the authoritative state.
    // The HTML lang is only a hint now: templates often keep lang="en" in every
    // locale, so the native tab wins unless the HTML names another language.
    const native = typeof getNativeSelectedLocale === 'function' ? getNativeSelectedLocale() : '';
    const resolved = resolveActiveLocale(renderedHtml, editorHtml, native);
    let tabs = [];
    try { tabs = discoverNativeLocaleTabs().map((item) => item.locale); } catch {}
    return matchLocaleToTabs(resolved, tabs);
  }

  function pruneLegacyToolbarButtons() {
    const bar = document.querySelector(`#${IDS.workspace} .rk-topbar`);
    if (!bar) return false;
    const obsolete = ['Save', 'Apply now'];
    for (const button of [...bar.querySelectorAll('button')]) {
      if (obsolete.includes(textOf(button))) button.remove();
    }
    const version = bar.querySelector('.rk-version');
    setTextContentIfChanged(version, 'v0.8.1');
    return true;
  }

  function makeToolbarButton(id, text, handler, title = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = 'rk-btn';
    button.textContent = text;
    if (title) button.title = title;
    button.addEventListener('click', handler);
    return button;
  }

  function closeBridgePopovers(except = '') {
    for (const id of [IDS.testPopover, IDS.originalPopover]) {
      if (id !== except) document.getElementById(id)?.remove();
    }
  }

  function getTestCampaignHeading() {
    const candidates = document.querySelectorAll('h1,h2,h3,h4,h5,h6,strong,div,span');
    return [...candidates].find((el) => textOf(el) === 'Test Campaign') || null;
  }

  function findExactMarker(label) {
    const candidates = document.querySelectorAll('label,span,div,p,strong,h1,h2,h3,h4,h5,h6');
    return [...candidates].find((el) => !isRetKitElement(el) && textOf(el) === label) || null;
  }

  function smallestCommonAncestor(elements) {
    const nodes = elements.filter(Boolean);
    if (!nodes.length) return null;
    let cursor = nodes[0];
    while (cursor && cursor !== document.body && cursor !== document.documentElement) {
      if (nodes.every((node) => cursor.contains(node))) return cursor;
      cursor = cursor.parentElement;
    }
    return null;
  }

  function findTestCampaignSection() {
    const direct = document.querySelector('.test_email_wrapper .mds-test__wrapper');
    if (direct && !isRetKitElement(direct) && /Test Campaign/i.test(textOf(direct))) return direct;

    const heading = getTestCampaignHeading();
    const locales = findExactMarker('Locales and Variations');
    const sendVia = findExactMarker('Send via');
    const email = findExactMarker('Enter user email');
    const personalise = [...document.querySelectorAll('label,span,div,p')]
      .find((el) => !isRetKitElement(el) && /^Personalise with a random user$/i.test(textOf(el))) || null;

    const strongMarkers = [locales, sendVia, email].filter(Boolean);
    if (strongMarkers.length >= 2) {
      const common = smallestCommonAncestor(heading ? [heading, ...strongMarkers] : strongMarkers);
      if (common && /Locales and Variations/.test(textOf(common)) && /Send via/.test(textOf(common))) return common;
      const fallback = smallestCommonAncestor(strongMarkers);
      if (fallback) return fallback;
    }

    if (heading) {
      let cursor = heading;
      for (let depth = 0; cursor && depth < 10; depth += 1, cursor = cursor.parentElement) {
        const text = textOf(cursor);
        if (text.includes('Locales and Variations') && text.includes('Send via')) return cursor;
      }
    }

    if (personalise && locales) return smallestCommonAncestor([personalise, locales]);
    return null;
  
  }

  function findTestCampaignLocaleControl(section) {
    if (!section?.querySelector) return null;
    return section.querySelector('[data-testid="test-campaign-variation-locale-dropdown"]')
      || findLabeledControl(section, 'Locales and Variations');
  }

  function isInsideTestCampaign(element) {
    const section = findTestCampaignSection();
    return Boolean(section && element && section.contains(element));
  }

  function localeFromOptionElement(element) {
    if (!element) return '';
    const textLocale = exactLocaleFromText(textOf(element));
    const valueLocale = exactLocaleFromText(element.getAttribute?.('value'));
    const locale = textLocale || valueLocale;
    return isKnownLocale(locale) ? locale : '';
  }

  function isRetKitElement(element) {
    return Boolean(element && (
      document.getElementById(IDS.workspace)?.contains(element) ||
      document.getElementById(IDS.testPopover)?.contains?.(element) ||
      document.getElementById(IDS.addLocalePopover)?.contains?.(element) ||
      document.getElementById(IDS.localeLoading)?.contains?.(element) ||
      document.getElementById('retkit-mo-launcher')?.contains?.(element)
    ));
  }

  function limitedElementWalk(rootNode, maxNodes = 500) {
    const out = [];
    const queue = rootNode?.children ? [...rootNode.children] : [];
    let visited = 0;
    while (queue.length && visited < maxNodes) {
      const node = queue.shift();
      if (!node || node === document.body || node === document.documentElement) continue;
      visited += 1;
      out.push(node);
      if (node.children?.length) queue.push(...node.children);
    }
    return out;
  }

  function nativeEditorSearchRoots() {
    const workspace = document.getElementById(IDS.workspace);
    const nativeNode = [...document.querySelectorAll('.CodeMirror')].find((node) => !workspace?.contains(node));
    const roots = [];
    let cursor = nativeNode?.parentElement || null;
    for (let depth = 0; cursor && depth < 5 && cursor !== document.body && cursor !== document.documentElement; depth += 1, cursor = cursor.parentElement) {
      roots.push(cursor);
    }
    return roots;
  }

  let nativeLocaleDeepCache = [];
  let nativeLocaleElementCache = new Map();
  let nativeLocaleDiscoveryPromise = null;
  let nativeLocaleDiscoveryTimer = null;
  let nativeLocaleDiscoveryAt = 0;

  function directElementText(element) {
    let value = '';
    for (const node of element?.childNodes || []) if (node.nodeType === 3) value += node.nodeValue || '';
    return value.replace(/\s+/g, ' ').trim();
  }

  function invalidateNativeLocaleDiscovery() {
    nativeLocaleDiscoveryAt = 0;
    nativeLocaleDeepCache = [];
    nativeLocaleElementCache = new Map();
    nativeLocaleBarCache = null;
  }

  async function discoverNativeLocalesDeep(force = false) {
    if (!force && nativeLocaleDeepCache.length && Date.now() - nativeLocaleDiscoveryAt < 10000) return nativeLocaleDeepCache;
    if (nativeLocaleDiscoveryPromise) return nativeLocaleDiscoveryPromise;
    nativeLocaleDiscoveryPromise = (async () => {
      const fastTabs = discoverNativeLocaleTabs();
      const candidates = fastTabs.map((item) => ({ locale: item.locale, element: item.element }));
      const seenElements = new Set(candidates.map((item) => item.element));
      const rootNode = document.body;
      const workspace = document.getElementById(IDS.workspace);
      if (rootNode && typeof document.createTreeWalker === 'function') {
        const walker = document.createTreeWalker(rootNode, root.NodeFilter?.SHOW_ELEMENT || 1);
        let node = walker.nextNode();
        let processed = 0;
        while (node) {
          if (!workspace?.contains(node) && !isRetKitElement(node) && !seenElements.has(node)) {
            const text = directElementText(node);
            if (text && text.length <= 18) {
              const locale = displayLocale(localeCodeFromLabel(text));
              if (locale && isKnownLocale(locale)) {
                candidates.push({ locale, element: node });
                seenElements.add(node);
              }
            }
          }
          processed += 1;
          if (processed % 500 === 0) await wait(0);
          node = walker.nextNode();
        }
      }

      // Pick a compact DOM cluster containing multiple locale labels instead of
      // treating every two-letter string on the page as a locale.
      const scores = new Map();
      for (const item of candidates) {
        let cursor = item.element?.parentElement;
        for (let depth = 0; cursor && depth < 6 && cursor !== document.body && cursor !== document.documentElement; depth += 1, cursor = cursor.parentElement) {
          if (workspace?.contains(cursor) || isRetKitElement(cursor)) continue;
          let entry = scores.get(cursor);
          if (!entry) { entry = { locales: new Set(), items: [], depth }; scores.set(cursor, entry); }
          entry.locales.add(item.locale);
          entry.items.push(item);
        }
      }
      let best = null;
      for (const [container, entry] of scores) {
        if (entry.locales.size < 2) continue;
        const compactness = Math.min(1000, String(container.textContent || '').length);
        const score = entry.locales.size * 1000 - compactness - entry.depth * 10;
        if (!best || score > best.score) best = { container, entry, score };
      }

      const found = new Map();
      if (best) {
        nativeLocaleBarCache = best.container;
        for (const item of best.entry.items) if (best.container.contains(item.element) && !found.has(item.locale)) found.set(item.locale, item.element);
      } else {
        for (const item of fastTabs) if (!found.has(item.locale)) found.set(item.locale, item.element);
      }
      const active = getActiveLocale();
      if (active && !found.has(active)) found.set(active, null);
      nativeLocaleDeepCache = sortLocalesForUi([...found.keys()]);
      nativeLocaleElementCache = found;
      nativeLocaleDiscoveryAt = Date.now();
      return nativeLocaleDeepCache;
    })().finally(() => { nativeLocaleDiscoveryPromise = null; });
    return nativeLocaleDiscoveryPromise;
  }

  function scheduleNativeLocaleDiscovery(delayMs = 20) {
    clearTimeout(nativeLocaleDiscoveryTimer);
    nativeLocaleDiscoveryTimer = setTimeout(async () => {
      nativeLocaleDiscoveryTimer = null;
      const locales = await discoverNativeLocalesDeep();
      const strip = document.getElementById(IDS.localeStrip);
      if (strip && locales.length) {
        const next = locales.join(',');
        if ((strip.dataset.locales || '') !== next) {
          strip.dataset.locales = next;
          strip.dataset.signature = '';
          renderLocaleStrip(false);
        }
      }
    }, Math.max(0, Number(delayMs) || 0));
  }

  async function findNativeAddLocaleTriggerDeep() {
    const immediate = findNativeAddLocaleTrigger();
    if (immediate) return immediate;
    const rootNode = document.body;
    const workspace = document.getElementById(IDS.workspace);
    if (!rootNode || typeof document.createTreeWalker !== 'function') return null;
    const walker = document.createTreeWalker(rootNode, root.NodeFilter?.SHOW_ELEMENT || 1);
    let node = walker.nextNode();
    let processed = 0;
    while (node) {
      if (!workspace?.contains(node) && !isRetKitElement(node)) {
        const labels = [directElementText(node), node.getAttribute?.('aria-label') || '', node.getAttribute?.('title') || '', node.getAttribute?.('data-testid') || ''];
        if (labels.some(addLocaleTriggerLabelMatches)) {
          const clickable = node.closest?.('button,a,[role="button"],[tabindex]') || node;
          if (!isRetKitElement(clickable)) return clickable;
        }
      }
      processed += 1;
      if (processed % 500 === 0) await wait(0);
      node = walker.nextNode();
    }
    return null;
  }

  function collectNativeLocaleCandidates() {
    const candidates = [];
    const seen = new Set();
    const consider = (el) => {
      if (!el || seen.has(el) || !isVisible(el) || isRetKitElement(el)) return;
      seen.add(el);
      const tag = String(el.tagName || '').toUpperCase();
      const role = String(el.getAttribute?.('role') || '').toLowerCase();
      const semantic = tag === 'BUTTON' || tag === 'A' || role === 'tab' || role === 'button' || el.hasAttribute?.('aria-selected');
      const scopedGeneric = tag === 'DIV' || tag === 'SPAN';
      if (!semantic && !scopedGeneric) return;
      const locale = localeFromOptionElement(el);
      if (!locale) return;
      const childWithSameLabel = [...el.children].some((child) => localeFromOptionElement(child) === locale);
      if (childWithSameLabel) return;
      candidates.push({ element: el, locale });
    };

    // Stay close to the native CodeMirror tree first. This keeps the expensive
    // locale detection bounded even on very large MoEngage React pages.
    for (const rootNode of nativeEditorSearchRoots()) {
      for (const el of limitedElementWalk(rootNode, 520)) consider(el);
      if (new Set(candidates.map((item) => displayLocale(item.locale))).size >= 2) return candidates;
    }

    // Last-resort fallback is semantic controls only — never every div/span.
    for (const el of document.querySelectorAll('button,a,[role="tab"],[role="button"],[aria-selected]')) consider(el);
    return candidates;
  }

  function findNativeLocaleBar() {
    if (nativeLocaleBarCache?.isConnected && isVisible(nativeLocaleBarCache)) return nativeLocaleBarCache;
    nativeLocaleBarCache = null;
    const candidates = collectNativeLocaleCandidates();
    if (candidates.length < 2) return null;
    const scores = new Map();
    for (const item of candidates) {
      let cursor = item.element.parentElement;
      for (let depth = 0; cursor && depth < 6 && cursor !== document.body && cursor !== document.documentElement; depth += 1, cursor = cursor.parentElement) {
        if (isRetKitElement(cursor)) continue;
        let entry = scores.get(cursor);
        if (!entry) {
          entry = { locales: new Set(), items: [], depthScore: depth };
          scores.set(cursor, entry);
        }
        entry.locales.add(displayLocale(item.locale));
        entry.items.push(item);
      }
    }

    let best = null;
    for (const [container, entry] of scores) {
      if (entry.locales.size < 2) continue;
      const textLength = textOf(container).length;
      const score = entry.locales.size * 1000 - Math.min(textLength, 900) - entry.depthScore * 10;
      if (!best || score > best.score) best = { container, entry, score };
    }
    nativeLocaleBarCache = best?.container || null;
    return nativeLocaleBarCache;
  }

  function discoverNativeLocaleTabs() {
    const bar = findNativeLocaleBar();
    const tabs = [];
    const seen = new Set();
    if (bar) {
      for (const el of bar.querySelectorAll('button,a,[role="tab"],[role="button"],[aria-selected],div,span')) {
        if (!isVisible(el) || isRetKitElement(el) || el.disabled) continue;
        const nativeLocale = localeCodeFromOptionElement(el);
        if (!nativeLocale) continue;
        const display = displayLocale(nativeLocale);
        if (seen.has(display)) continue;
        const childSame = [...el.children].some((child) => displayLocale(localeCodeFromOptionElement(child)) === display);
        if (childSame) continue;
        const closest = el.closest('button,a,[role="tab"],[role="button"],[tabindex]');
        const clickable = closest && bar.contains(closest) ? closest : el;
        tabs.push({ locale: display, nativeLocale, element: clickable });
        seen.add(display);
      }
    }
    for (const [locale, element] of nativeLocaleElementCache) {
      if (!element?.isConnected || seen.has(locale)) continue;
      const clickable = element.closest?.('button,a,[role="tab"],[role="button"],[tabindex]') || element;
      tabs.push({ locale, nativeLocale: normaliseLocale(locale), element: clickable });
      seen.add(locale);
    }
    return tabs;
  }

  function discoverNativeLocales() {
    const values = [...nativeLocaleDeepCache, ...discoverNativeLocaleTabs().map((item) => item.locale)];
    for (const select of document.querySelectorAll('select')) {
      if (isInsideTestCampaign(select)) continue;
      for (const option of select.options || []) {
        const locale = localeFromOptionElement(option);
        if (locale) values.push(locale);
      }
    }
    const active = getActiveLocale();
    if (active) values.push(active);
    scheduleNativeLocaleDiscovery(30);
    return sortLocalesForUi(values);
  }

  function isLocaleTabActive(element) {
    let cursor = element;
    for (let depth = 0; cursor && depth < 3; depth += 1, cursor = cursor.parentElement) {
      if (cursor.getAttribute?.('aria-selected') === 'true') return true;
      if (cursor.getAttribute?.('data-selected') === 'true' || cursor.getAttribute?.('data-active') === 'true') return true;
      const cls = String(cursor.className || '');
      if (/(?:^|[-_\s])(active|selected|current)(?:$|[-_\s])/i.test(cls)) return true;
    }
    return false;
  }

  function getNativeSelectedLocale() {
    const active = discoverNativeLocaleTabs().find((item) => isLocaleTabActive(item.element));
    return active?.locale || '';
  }

  function findDirectLocaleControl(target) {
    const aliases = new Set(localeAliases(target));
    const tab = discoverNativeLocaleTabs().find((item) => aliases.has(item.nativeLocale) || aliases.has(item.locale));
    if (tab) return { type: 'click', control: tab.element, nativeLocale: tab.nativeLocale };

    for (const select of document.querySelectorAll('select')) {
      if (isInsideTestCampaign(select)) continue;
      const options = [...(select.options || [])];
      const option = options.find((item) => aliases.has(localeCodeFromOptionElement(item)));
      if (option) return { type: 'select', control: select, option, nativeLocale: localeCodeFromOptionElement(option) };
    }
    return null;
  }

  function findLocaleDropdownTrigger() {
    const selectors = [
      '[aria-label*="locale" i]', '[title*="locale" i]', '[id*="locale" i]', '[class*="locale" i]',
      '[aria-label*="variation" i]', '[title*="variation" i]', '[id*="variation" i]', '[class*="variation" i]',
    ];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!isVisible(el) || document.getElementById(IDS.workspace)?.contains(el) || isInsideTestCampaign(el)) continue;
        const clickable = el.matches('button,[role="button"],[role="combobox"],select') ? el : el.querySelector('button,[role="button"],[role="combobox"],select');
        if (clickable) return clickable;
      }
    }
    return null;
  }

  function dispatchChange(element) {
    try { element.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    try { element.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
  }

  function setNativeSelect(select, option) {
    if (!select || !option) return false;
    select.value = option.value;
    option.selected = true;
    dispatchChange(select);
    return true;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForLocaleListCondition(predicate, timeoutMs = 3200, intervalMs = 110) {
    const started = Date.now();
    let current = discoverNativeLocales();
    while (Date.now() - started < timeoutMs) {
      if (predicate(current)) return current;
      await wait(intervalMs);
      current = discoverNativeLocales();
    }
    return current;
  }

  function findNativeAddLocaleTrigger() {
    const bar = findNativeLocaleBar();
    const roots = [bar, bar?.parentElement, bar?.parentElement?.parentElement]
      .filter((node, index, list) => node && node !== document.body && node !== document.documentElement && list.indexOf(node) === index);
    let best = null;
    let bestScore = Infinity;
    const seen = new Set();
    const consider = (el, rootPenalty = 0) => {
      if (!el || seen.has(el) || isRetKitElement(el)) return;
      seen.add(el);
      const labels = [directElementText(el), textOf(el), el.getAttribute?.('aria-label') || '', el.getAttribute?.('title') || '', el.getAttribute?.('data-testid') || ''];
      if (!labels.some(addLocaleTriggerLabelMatches)) return;
      const clickable = el.closest?.('button,a,[role="button"],[tabindex]') || el;
      if (isRetKitElement(clickable)) return;
      const semanticsBonus = clickable.matches?.('button,[role="button"],a') ? -30 : 0;
      const score = rootPenalty + semanticsBonus + Math.min(120, directElementText(clickable).length || textOf(clickable).length) + (clickable.children?.length || 0) * 3;
      if (score < bestScore) { best = clickable; bestScore = score; }
    };
    roots.forEach((rootNode, index) => {
      const penalty = index * 12;
      for (const el of rootNode.querySelectorAll('button,a,[role="button"],[tabindex],[aria-label],[title],[data-testid]')) consider(el, penalty);
      if (!best) for (const el of limitedElementWalk(rootNode, 220)) consider(el, penalty + 30);
    });
    if (best) return best;
    for (const el of document.querySelectorAll('button,a,[role="button"],[tabindex],[aria-label],[title],[data-testid]')) consider(el, 100);
    return best;
  }

  function findLocaleRowForControl(control) {
    let cursor = control;
    for (let depth = 0; cursor && depth < 5; depth += 1, cursor = cursor.parentElement) {
      const locale = localeCodeFromLabel(textOf(cursor));
      if (locale) return { locale, row: cursor };
    }
    return null;
  }


  function collectOpenAddLocaleOptions(menuRoot) {
    const found = new Map();
    if (!menuRoot) return [];
    const searchRoot = menuRoot;
    const controls = searchRoot.querySelectorAll('input[type="checkbox"],[role="checkbox"]');
    for (const control of controls) {
      if (!isVisible(control) || isRetKitElement(control)) continue;
      const info = findLocaleRowForControl(control);
      if (!info?.locale || found.has(info.locale)) continue;
      const clickable = control.matches('input,[role="checkbox"]') ? control : info.row;
      found.set(info.locale, { locale: info.locale, control: clickable, row: info.row, menuRoot });
    }
    // Fallback stays inside the detected popup instead of scanning every div on
    // the full MoEngage page repeatedly.
    if (menuRoot) {
      for (const el of menuRoot.querySelectorAll('label,[role="option"],[role="menuitem"],li,div')) {
        if (!isVisible(el) || isRetKitElement(el)) continue;
        const locale = localeCodeFromLabel(textOf(el));
        if (!locale || found.has(locale)) continue;
        const checkbox = el.querySelector?.('input[type="checkbox"],[role="checkbox"]');
        if (!checkbox) continue;
        found.set(locale, { locale, control: checkbox, row: el, menuRoot });
      }
    }
    return [...found.values()];
  }

  function findOpenAddLocaleAction(options = []) {
    const optionRects = options.map((item) => item.row?.getBoundingClientRect?.()).filter(Boolean);
    const menuRoot = options.find((item) => item.menuRoot)?.menuRoot || null;
    if (!menuRoot) return null;

    const labelScore = (el) => {
      const label = `${textOf(el)} ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''} ${el.getAttribute?.('value') || ''}`.replace(/\s+/g, ' ').trim();
      if (/^add$/i.test(label)) return 0;
      if (/^add(?:\s+(?:selected|locale|locales))?$/i.test(label)) return 1;
      if (/^apply$/i.test(label)) return 2;
      if (/^save$/i.test(label)) return 3;
      if (/^done$/i.test(label)) return 4;
      if (/^(?:confirm|create)(?:\s+locale(?:s)?)?$|^(?:continue|ok)$/i.test(label)) return 5;
      return Infinity;
    };
    const geometricDistance = (el) => {
      const rect = el.getBoundingClientRect?.();
      if (!rect || !optionRects.length) return 0;
      const left = Math.min(...optionRects.map((item) => item.left));
      const right = Math.max(...optionRects.map((item) => item.right));
      const top = Math.min(...optionRects.map((item) => item.top));
      const bottom = Math.max(...optionRects.map((item) => item.bottom));
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = cx < left ? left - cx : cx > right ? cx - right : 0;
      const dy = cy < top ? top - cy : cy > bottom ? cy - bottom : 0;
      return Math.hypot(dx, dy);
    };
    const choose = (candidates, maxDistance = Infinity) => {
      let best = null;
      let bestScore = Infinity;
      for (const el of candidates) {
        if (!isVisible(el) || isRetKitElement(el)) continue;
        const label = labelScore(el);
        const isSubmit = String(el.getAttribute?.('type') || '').toLowerCase() === 'submit';
        if (!Number.isFinite(label) && !isSubmit) continue;
        const distance = geometricDistance(el);
        if (distance > maxDistance) continue;
        const score = (Number.isFinite(label) ? label * 1000 : 6500) + distance;
        if (score < bestScore) { best = el; bestScore = score; }
      }
      return best;
    };

    // The checkbox list can be a small child mounted inside a larger dialog.
    // Walk only a few ancestors so the real footer action remains in scope.
    const roots = [];
    let cursor = menuRoot;
    for (let depth = 0; cursor && depth < 8 && cursor !== document.body && cursor !== document.documentElement; depth += 1, cursor = cursor.parentElement) {
      if (isVisible(cursor) && !isRetKitElement(cursor)) roots.push(cursor);
    }
    for (const item of options) {
      const form = item?.control?.closest?.('form') || item?.row?.closest?.('form');
      if (form && isVisible(form) && !roots.includes(form)) roots.push(form);
    }
    for (const rootNode of roots) {
      const found = choose(rootNode.querySelectorAll?.('button,[role="button"],input[type="submit"],input[type="button"],a,[tabindex]') || [], 720);
      if (found) return found;
    }

    // Current MoEngage sometimes renders the footer Add as a plain React div/span.
    // Search only inside the already-bounded picker and accept an exact action
    // label; clicking the text child is safe because the native handler bubbles.
    for (const rootNode of roots) {
      const textActions = [...(rootNode.querySelectorAll?.('div,span') || [])]
        .filter((el) => isVisible(el) && !isRetKitElement(el))
        .filter((el) => /^(?:Add|Apply|Save|Done|Confirm|Create|Continue|OK)$/i.test(textOf(el)));
      if (textActions.length) {
        textActions.sort((a, b) => {
          const ar = a.getBoundingClientRect?.(); const br = b.getBoundingClientRect?.();
          return ((ar?.width || 0) * (ar?.height || 0)) - ((br?.width || 0) * (br?.height || 0));
        });
        return textActions[0];
      }
    }

    // Some MoEngage popovers render the footer action through a sibling portal.
    // Search semantic buttons globally, but only accept controls physically near
    // the locale options; this avoids the old expensive generic DOM scan.
    return choose(document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"],a,[tabindex]'), 720);
  }

  async function waitForOpenAddLocaleAction(options = [], timeoutMs = 1400) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const action = findOpenAddLocaleAction(options);
      if (action) return action;
      await wait(90);
    }
    return null;
  }

  function visibleAddLocaleActionLabels(options = []) {
    const roots = new Set();
    for (const item of options) {
      let cursor = item?.row || item?.control || null;
      for (let depth = 0; cursor && depth < 8 && cursor !== document.body && cursor !== document.documentElement; depth += 1, cursor = cursor.parentElement) {
        if (isVisible(cursor) && !isRetKitElement(cursor)) roots.add(cursor);
      }
      const form = item?.control?.closest?.('form') || item?.row?.closest?.('form');
      if (form) roots.add(form);
    }
    const labels = [];
    const seen = new Set();
    for (const rootNode of roots) {
      for (const el of rootNode.querySelectorAll?.('button,[role="button"],input[type="submit"],input[type="button"],a,[tabindex]') || []) {
        if (!isVisible(el) || isRetKitElement(el)) continue;
        const label = `${textOf(el)} ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''} ${el.getAttribute?.('value') || ''}`.replace(/\s+/g, ' ').trim();
        if (!label || seen.has(label)) continue;
        seen.add(label);
        labels.push(label.slice(0, 120));
        if (labels.length >= 20) return labels;
      }
    }
    return labels;
  }

  function closeNativeAddLocaleMenu() {
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); } catch {}
    try { document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); } catch {}
  }

  function addLocaleMenuRootFromNode(node) {
    if (!node || node.nodeType !== 1) return null;
    const controls = [];
    if (node.matches?.('input[type="checkbox"],[role="checkbox"]')) controls.push(node);
    controls.push(...(node.querySelectorAll?.('input[type="checkbox"],[role="checkbox"]') || []));
    let best = null;
    let bestArea = Infinity;
    for (const control of controls) {
      let cursor = control.parentElement;
      for (let depth = 0; cursor && depth < 7 && cursor !== document.body && cursor !== document.documentElement; depth += 1, cursor = cursor.parentElement) {
        if (!isVisible(cursor) || isRetKitElement(cursor)) continue;
        const count = cursor.querySelectorAll?.('input[type="checkbox"],[role="checkbox"]')?.length || 0;
        if (count < 1) continue;
        const role = String(cursor.getAttribute?.('role') || '').toLowerCase();
        const cls = String(cursor.className || '');
        const popupLike = /dialog|menu|listbox/.test(role) || /popover|popup|dropdown|menu|modal|overlay/i.test(cls);
        if (!popupLike && count < 2) continue;
        const rect = cursor.getBoundingClientRect?.();
        const area = rect && rect.width && rect.height ? rect.width * rect.height : 1e12;
        if (area < bestArea) { best = cursor; bestArea = area; }
      }
    }
    return best;
  }

  function addLocalePopupCompletenessScore(candidate) {
    if (!candidate || !isVisible(candidate) || isRetKitElement(candidate)) return -Infinity;
    const options = collectOpenAddLocaleOptions(candidate);
    if (!options.length) return -Infinity;
    const text = textOf(candidate).replace(/\s+/g, ' ').trim();
    const checkboxCount = candidate.querySelectorAll?.('input[type="checkbox"],[role="checkbox"]')?.length || 0;
    const hasSearch = Boolean(candidate.querySelector?.('input[placeholder*="Search to select" i],input[placeholder*="search" i]'));
    const hasNewLocale = /\bNew\s+Locale\b/i.test(text);
    const hasAdd = /(?:^|\s)Add(?:\s|$)/i.test(text);
    const rect = candidate.getBoundingClientRect?.();
    const area = rect && rect.width && rect.height ? rect.width * rect.height : 1e12;
    // Prefer the complete picker (search + locale rows + New Locale/Add), then
    // the root with the most locale options. Area is only a tie-breaker so we
    // do not accidentally promote the whole campaign page.
    return (hasSearch ? 100000 : 0)
      + (hasNewLocale ? 50000 : 0)
      + (hasAdd ? 30000 : 0)
      + options.length * 5000
      + Math.min(checkboxCount, 20) * 100
      - Math.min(area / 10000, 5000);
  }

  function completeAddLocaleMenuRootFromNode(node) {
    if (!node || node.nodeType !== 1) return null;
    const seeds = [];
    if (node.matches?.('input[type="checkbox"],[role="checkbox"]')) seeds.push(node);
    seeds.push(...(node.querySelectorAll?.('input[type="checkbox"],[role="checkbox"]') || []));
    let best = null;
    let bestScore = -Infinity;
    const seen = new Set();
    for (const seed of seeds) {
      const info = findLocaleRowForControl(seed);
      if (!info?.locale) continue;
      let cursor = seed.parentElement;
      for (let depth = 0; cursor && depth < 9 && cursor !== document.body && cursor !== document.documentElement; depth += 1, cursor = cursor.parentElement) {
        if (seen.has(cursor)) continue;
        seen.add(cursor);
        const score = addLocalePopupCompletenessScore(cursor);
        if (score > bestScore) { best = cursor; bestScore = score; }
      }
    }
    return best;
  }

  function findVisibleAddLocalePopupRoot() {
    const candidates = new Set(document.querySelectorAll('[role="dialog"],[role="menu"],[role="listbox"],[aria-modal="true"],[data-popper-placement],.mds-dropdown,[class*="popover" i],[class*="dropdown-menu" i]'));
    // MoEngage's current picker does not consistently expose a dialog/listbox
    // role. Seed discovery from locale checkboxes, then score their ancestors.
    for (const control of document.querySelectorAll('input[type="checkbox"],[role="checkbox"]')) {
      if (!isVisible(control) || isRetKitElement(control)) continue;
      const info = findLocaleRowForControl(control);
      if (!info?.locale) continue;
      let cursor = control.parentElement;
      for (let depth = 0; cursor && depth < 9 && cursor !== document.body && cursor !== document.documentElement; depth += 1, cursor = cursor.parentElement) candidates.add(cursor);
    }
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const score = addLocalePopupCompletenessScore(candidate);
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    return best;
  }

  function isCompleteAddLocalePopup(rootNode) {
    if (!rootNode) return false;
    const options = collectOpenAddLocaleOptions(rootNode);
    if (!options.length) return false;
    const text = textOf(rootNode).replace(/\s+/g, ' ').trim();
    const hasSearch = Boolean(rootNode.querySelector?.('input[placeholder*="Search to select" i],input[placeholder*="search" i]'));
    const hasFooter = /\bNew\s+Locale\b/i.test(text) || /(?:^|\s)Add(?:\s|$)/i.test(text);
    return hasSearch || hasFooter || options.length > 1;
  }

  function waitForNativeAddLocaleMenu(activate, timeoutMs = 1800) {
    return new Promise((resolve) => {
      let done = false;
      let observer = null;
      let settleTimer = null;
      const timers = [];
      let bestSeen = null;
      const finish = (rootNode) => {
        if (done) return;
        done = true;
        observer?.disconnect?.();
        if (settleTimer) clearTimeout(settleTimer);
        timers.forEach((timer) => clearTimeout(timer));
        resolve(rootNode || null);
      };
      const inspectBest = (allowPartial = false) => {
        const rootNode = findVisibleAddLocalePopupRoot();
        if (rootNode) bestSeen = rootNode;
        if (rootNode && (allowPartial || isCompleteAddLocalePopup(rootNode))) finish(rootNode);
      };
      const scheduleSettledInspect = () => {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => inspectBest(false), 90);
      };
      if (typeof root.MutationObserver === 'function') {
        observer = new root.MutationObserver(() => scheduleSettledInspect());
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-expanded'] });
      }
      try { activate(); } catch { finish(null); return; }
      // Do not finish on the first checkbox fragment. Give React a short settle
      // window so TL/UR plus the Search/New Locale/Add footer share one root.
      timers.push(setTimeout(() => inspectBest(false), 140));
      timers.push(setTimeout(() => inspectBest(false), 320));
      timers.push(setTimeout(() => inspectBest(true), 650));
      timers.push(setTimeout(() => finish(bestSeen), timeoutMs));
    });
  }

  async function openNativeAddLocaleMenu() {
    const startedAt = root.performance?.now?.() ?? Date.now();
    const trigger = await findNativeAddLocaleTriggerDeep();
    if (!trigger) {
      const reason = 'MoEngage + Locale control was not found';
      diagIncident('locale_add_control_missing', reason, { existingLocales: discoverNativeLocales(), url: String(location?.pathname || '') });
      return { ok: false, reason, trigger: null, menuRoot: null, options: [] };
    }
    diagBreadcrumb('locale.add-menu.open', { label: textOf(trigger) });
    const menuRoot = await waitForNativeAddLocaleMenu(() => activateNativeControl(trigger));
    const elapsedMs = Math.round((root.performance?.now?.() ?? Date.now()) - startedAt);
    if (!menuRoot) {
      const reason = 'MoEngage locale menu did not open';
      diagIncident('locale_add_menu_failed', reason, { triggerText: textOf(trigger), existingLocales: discoverNativeLocales(), elapsedMs });
      return { ok: false, reason, trigger, menuRoot: null, options: [] };
    }
    const options = collectOpenAddLocaleOptions(menuRoot);
    diagBreadcrumb('locale.add-menu.ready', { elapsedMs, optionCount: options.length });
    return { ok: true, reason: '', trigger, menuRoot, options };
  }

  async function listNativeAddableLocales() {
    await discoverNativeLocalesDeep();
    const existing = discoverNativeLocales();
    const opened = await openNativeAddLocaleMenu();
    if (!opened.ok) throw new Error(opened.reason);
    const locales = normaliseAddableLocaleLabels(opened.options.map((item) => item.locale), existing);
    closeNativeAddLocaleMenu();
    return locales;
  }

  async function handOffNativeLocaleAdd(plan) {
    const workspace = document.getElementById(IDS.workspace);
    const selected = [...new Set((plan?.selected || []).map(displayLocale).filter(Boolean))];
    if (!workspace || !selected.length) return { ok: false, added: [], ...plan, reason: 'Native locale picker handoff is unavailable' };

    document.getElementById(IDS.addLocalePopover)?.remove();
    document.getElementById(IDS.nativeLocaleAssist)?.remove();
    const banner = document.createElement('div');
    banner.id = IDS.nativeLocaleAssist;
    const text = document.createElement('span');
    text.textContent = `Finish adding ${selected.join(', ')} in the native MoEngage locale picker. RetKit will return automatically when the locale appears.`;
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Return to RetKit';
    banner.append(text, back);
    document.body.appendChild(banner);

    const previousVisibility = workspace.style.visibility;
    const previousOverflow = document.body.style.overflow;
    workspace.style.visibility = 'hidden';
    document.body.style.overflow = '';
    diagBreadcrumb('locale.add-native-assist.start', { requestedLocales: selected });

    return await new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = async (reason = '') => {
        if (done) return;
        done = true;
        if (timer) clearInterval(timer);
        banner.remove();
        workspace.style.visibility = previousVisibility;
        document.body.style.overflow = previousOverflow || 'hidden';
        invalidateNativeLocaleDiscovery();
        let current = [];
        try { current = await discoverNativeLocalesDeep(); } catch {}
        const added = selected.filter((locale) => current.includes(locale));
        const missing = selected.filter((locale) => !current.includes(locale));
        renderLocaleStrip(true);
        updateLocaleUi(true);
        syncSubjectFromMoEngage(true);
        if (!missing.length) {
          diagBreadcrumb('locale.add-native-assist.done', { added });
          resolve({ ok: true, added, alreadyPresent: plan.alreadyPresent || [], missing: [], selected, reason: '' });
          return;
        }
        const pendingReason = `Locale not detected yet; refresh locales after MoEngage updates (${missing.join(', ')})`;
        diagBreadcrumb('locale.add-native-assist.returned', { requestedLocales: selected, currentLocales: current, reason: reason || 'manual' });
        resolve({ ok: false, pending: true, added, alreadyPresent: plan.alreadyPresent || [], missing, selected, reason: pendingReason });
      };
      back.addEventListener('click', () => finish('manual'));
      timer = setInterval(async () => {
        if (done) return;
        invalidateNativeLocaleDiscovery();
        try {
          const current = await discoverNativeLocalesDeep();
          if (selected.every((locale) => current.includes(locale))) finish('added');
        } catch {}
      }, 500);
    });
  }

  async function addNativeLocales(requestedLocales) {
    await discoverNativeLocalesDeep();
    const existing = discoverNativeLocales();
    const opened = await openNativeAddLocaleMenu();
    if (!opened.ok) return { ok: false, added: [], alreadyPresent: [], missing: [], reason: opened.reason };
    const available = opened.options.map((item) => item.locale);
    const plan = localeAddSelectionPlan(existing, available, requestedLocales);
    if (plan.missing.length) {
      closeNativeAddLocaleMenu();
      return { ok: false, added: [], ...plan, reason: `MoEngage locale(s) not available: ${plan.missing.join(', ')}` };
    }
    if (!plan.selected.length) {
      closeNativeAddLocaleMenu();
      return { ok: true, added: [], ...plan, reason: plan.alreadyPresent.length ? 'Already present' : 'No locales selected' };
    }
    const byLocale = new Map(opened.options.map((item) => [item.locale, item]));
    for (const locale of plan.selected) {
      const item = byLocale.get(locale);
      if (!item) continue;
      const activationTarget = localeAddActivationTarget(item);
      diagBreadcrumb('locale.add-option.activate', { locale, tag: String(activationTarget?.tagName || ''), role: String(activationTarget?.getAttribute?.('role') || '') });
      activateNativeControl(activationTarget);
      await wait(70);
      const isChecked = () => Boolean(item.control?.checked || item.control?.getAttribute?.('aria-checked') === 'true');
      if (!isChecked() && item.control && item.control !== activationTarget) {
        diagBreadcrumb('locale.add-option.control-fallback', { locale, tag: String(item.control?.tagName || ''), role: String(item.control?.getAttribute?.('role') || '') });
        activateNativeControl(item.control);
        await wait(70);
      }
      diagBreadcrumb('locale.add-option.state', { locale, checked: isChecked() });
    }
    // The current MoEngage picker owns the final Add action. RetKit only
    // preselects the requested native checkboxes, then hands the already-open
    // picker to the user. This avoids brittle React portal/footer automation.
    diagBreadcrumb('locale.add-native-handoff', { requestedLocales: plan.selected });
    return await handOffNativeLocaleAdd(plan);
  }

  function findNativeRemoveLocaleControl(target) {
    const locale = displayLocale(target);
    if (!canRemoveLocale(locale)) return { control: null, menuTrigger: null };
    const tab = discoverNativeLocaleTabs().find((item) => item.locale === locale);
    if (!tab?.element) return { control: null, menuTrigger: null };

    const roots = [];
    let cursor = tab.element;
    for (let depth = 0; cursor && depth < 4; depth += 1, cursor = cursor.parentElement) roots.push(cursor);
    let menuTrigger = null;
    for (const rootNode of roots) {
      for (const el of rootNode.querySelectorAll?.('button,[role="button"],[aria-label],[title],[aria-haspopup]') || []) {
        if (!isVisible(el) || isRetKitElement(el) || el === tab.element) continue;
        const label = `${textOf(el)} ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''} ${el.getAttribute?.('value') || ''}`.replace(/\s+/g, ' ').trim();
        if (/(?:remove|delete)\s*(?:locale)?|(?:locale)\s*(?:remove|delete)/i.test(label)) return { control: el, menuTrigger: null };
        if (!menuTrigger && (el.getAttribute?.('aria-haspopup') === 'menu' || /(?:more|action|option|menu|ellipsis)/i.test(label))) menuTrigger = el;
      }
    }
    return { control: null, menuTrigger };
  }

  function findRemoveLocaleActionWithin(rootNode) {
    if (!rootNode?.querySelectorAll) return null;
    const candidates = [];
    if (rootNode.matches?.('button,[role="button"],[role="menuitem"],li')) candidates.push(rootNode);
    candidates.push(...rootNode.querySelectorAll('button,[role="button"],[role="menuitem"],li'));
    let best = null;
    for (const el of candidates) {
      if (!isVisible(el) || isRetKitElement(el)) continue;
      const label = textOf(el).replace(/\s+/g, ' ').trim();
      if (!/^(?:remove|delete)(?:\s+locale)?$/i.test(label) && !/^(?:remove|delete)\s+this\s+locale$/i.test(label)) continue;
      if (!best || textOf(el).length < textOf(best).length) best = el;
    }
    return best;
  }

  function findConfirmActionWithin(rootNode) {
    if (!rootNode?.querySelectorAll) return null;
    const candidates = [];
    if (rootNode.matches?.('button,[role="button"]')) candidates.push(rootNode);
    candidates.push(...rootNode.querySelectorAll('button,[role="button"]'));
    for (const el of candidates) {
      if (!isVisible(el) || isRetKitElement(el)) continue;
      if (/^(?:remove|delete|confirm)$/i.test(textOf(el).trim())) return el;
    }
    return null;
  }

  function waitForPopupAction(activate, finder, timeoutMs = 1200) {
    return new Promise((resolve) => {
      let done = false;
      let observer = null;
      const timers = [];
      const finish = (value) => {
        if (done) return;
        done = true;
        observer?.disconnect?.();
        timers.forEach((timer) => clearTimeout(timer));
        resolve(value || null);
      };
      const inspect = (node) => {
        if (!node || node.nodeType !== 1) return null;
        const direct = finder(node);
        if (direct) return direct;
        let cursor = node.parentElement;
        for (let depth = 0; cursor && depth < 4 && cursor !== document.body; depth += 1, cursor = cursor.parentElement) {
          const found = finder(cursor);
          if (found) return found;
        }
        return null;
      };
      if (typeof root.MutationObserver === 'function') {
        observer = new root.MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes || []) {
              const found = inspect(node);
              if (found) { finish(found); return; }
            }
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }
      try { activate(); } catch { finish(null); return; }
      timers.push(setTimeout(() => {
        const popups = document.querySelectorAll('[role="dialog"],[role="menu"],[role="listbox"],[aria-modal="true"],[data-popper-placement],.mds-dropdown');
        for (const popup of popups) {
          const found = finder(popup);
          if (found) { finish(found); return; }
        }
      }, 120));
      timers.push(setTimeout(() => finish(null), timeoutMs));
    });
  }

  async function handOffNativeLocaleRemove(target) {
    const locale = displayLocale(target);
    const workspace = document.getElementById(IDS.workspace);
    if (!workspace || !canRemoveLocale(locale)) return { ok: false, removed: false, reason: 'Native locale removal handoff is unavailable' };

    document.getElementById(IDS.nativeLocaleAssist)?.remove();
    const banner = document.createElement('div');
    banner.id = IDS.nativeLocaleAssist;
    const text = document.createElement('span');
    text.textContent = `Remove ${locale} in MoEngage. RetKit will return automatically when the locale disappears.`;
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Return to RetKit';
    banner.append(text, back);
    document.body.appendChild(banner);

    const previousVisibility = workspace.style.visibility;
    const previousOverflow = document.body.style.overflow;
    workspace.style.visibility = 'hidden';
    document.body.style.overflow = '';
    diagBreadcrumb('locale.remove-native-assist.start', { locale });

    // Switching to the locale is non-destructive and makes the native MoEngage
    // removal affordance easier to find. The actual remove click remains manual.
    try { await switchNativeLocale(locale); } catch {}

    return await new Promise((resolve) => {
      let done = false;
      let timer = null;
      let timeout = null;
      const finish = async (reason = '') => {
        if (done) return;
        done = true;
        if (timer) clearInterval(timer);
        if (timeout) clearTimeout(timeout);
        banner.remove();
        workspace.style.visibility = previousVisibility;
        document.body.style.overflow = previousOverflow || 'hidden';
        invalidateNativeLocaleDiscovery();
        let current = [];
        try { current = await discoverNativeLocalesDeep(); } catch {}
        const removed = !current.includes(locale);
        renderLocaleStrip(true);
        updateLocaleUi(true);
        syncSubjectFromMoEngage(true);
        if (removed) {
          // A removed locale can briefly leave RetKit bound to an unmounted,
          // empty Froala editor. Rebind to whichever native locale survived.
          try { root.__RetKitMoEngageCore?.rebindNativeEditorFromMoEngage?.({ preserveCursor: false }); } catch {}
          diagBreadcrumb('locale.remove-native-assist.done', { locale });
          resolve({ ok: true, removed: true, reason: '' });
          return;
        }
        if (reason === 'timeout') diagIncident('locale_remove_native_assist_incomplete', `MoEngage did not remove ${locale}`, { locale, currentLocales: current });
        resolve({ ok: false, removed: false, reason: `MoEngage did not remove ${locale}` });
      };
      back.addEventListener('click', () => finish('manual'));
      timer = setInterval(async () => {
        if (done) return;
        invalidateNativeLocaleDiscovery();
        try {
          const current = await discoverNativeLocalesDeep();
          if (!current.includes(locale)) finish('removed');
        } catch {}
      }, 300);
      timeout = setTimeout(() => finish('timeout'), 60000);
    });
  }

  async function removeNativeLocale(target) {
    const locale = displayLocale(target);
    if (!canRemoveLocale(locale)) return { ok: false, removed: false, reason: `${locale || 'Default'} locale cannot be removed` };
    await discoverNativeLocalesDeep();
    const existing = discoverNativeLocales();
    if (!existing.includes(locale)) return { ok: true, removed: false, reason: 'Locale is not present' };

    // Removal is destructive. Do not guess at private React controls: hand the
    // final delete to the real MoEngage UI and observe the locale list until the
    // target disappears, mirroring the safe add-locale fallback.
    return await handOffNativeLocaleRemove(locale);
  }

  function findVisibleLocaleOption(target) {
    const aliases = new Set(localeAliases(target));
    const roots = [...document.querySelectorAll('[role="dialog"],[role="menu"],[role="listbox"],[aria-modal="true"],[data-popper-placement],.mds-dropdown,[class*="popover" i],[class*="dropdown-menu" i]')]
      .filter((node) => isVisible(node) && !isRetKitElement(node));
    const findWithin = (rootNode) => {
      const candidates = [];
      if (rootNode?.matches?.('[role="option"],[role="menuitem"],button,li,label')) candidates.push(rootNode);
      candidates.push(...(rootNode?.querySelectorAll?.('[role="option"],[role="menuitem"],button,li,label,[aria-selected]') || []));
      let best = null;
      for (const el of candidates) {
        if (!isVisible(el) || isRetKitElement(el)) continue;
        if (!aliases.has(localeCodeFromOptionElement(el))) continue;
        const clickable = el.closest('button,[role="option"],[role="menuitem"],li,label') || el;
        if (!best || textOf(clickable).length < textOf(best).length) best = clickable;
      }
      return best;
    };
    for (const rootNode of roots) {
      const found = findWithin(rootNode);
      if (found) return found;
    }
    // Semantic-only fallback; never scan every generic div/span on the React page.
    return findWithin(document);
  }

  async function switchNativeLocale(target, options = {}) {
    const locale = displayLocale(target);
    if (!locale) return { ok: false, reason: 'Locale is empty' };
    const preferNative = options.rebind === false || options.preferNative === true;
    const current = preferNative ? (getNativeSelectedLocale() || getNativeEditorLocale() || getActiveLocale()) : getActiveLocale();
    if (current === locale) {
      if (options.rebind !== false) await rebindWorkspaceAfterLocaleChange(locale);
      return { ok: true, reason: 'Already active' };
    }

    const direct = findDirectLocaleControl(locale);
    if (direct?.type === 'select') setNativeSelect(direct.control, direct.option);
    else if (direct?.type === 'click') direct.control.click();
    else {
      const trigger = findLocaleDropdownTrigger();
      if (!trigger) return { ok: false, reason: `MoEngage locale tab ${locale} was not found` };
      trigger.click();
      await wait(100);
      const option = findVisibleLocaleOption(locale);
      if (!option) return { ok: false, reason: `Locale ${locale} was not found in MoEngage` };
      option.click();
    }

    const activated = await waitForNativeLocaleActivation(locale, Number(options.timeoutMs) || 2600);
    if (!activated) return { ok: false, reason: `MoEngage did not render ${locale} after the locale click` };

    if (options.rebind !== false) {
      const rebound = await rebindWorkspaceAfterLocaleChange(locale);
      if (!rebound) return { ok: false, reason: `RetKit could not bind the ${locale} editor` };
    }
    return { ok: true, reason: '' };
  }

  async function readNativeLocaleHtmlFast(locale) {
    const wanted = displayLocale(locale);
    if (!wanted) return '';
    const beforeEditor = getNativeEditorOutsideWorkspace();
    const beforeHtml = String(beforeEditor?.getValue?.() || '');
    const switched = await switchNativeLocale(wanted, { rebind: false, preferNative: true, timeoutMs: 2400 });
    if (!switched?.ok) throw new Error(switched?.reason || `Could not switch to ${wanted}`);
    const started = Date.now();
    while (Date.now() - started < 1400) {
      const native = getNativeEditorOutsideWorkspace();
      const html = String(native?.getValue?.() || '');
      const nativeLocale = displayLocale(localeFromHtml(html));
      const selected = getNativeSelectedLocale();
      const changedEditor = Boolean(native && native !== beforeEditor);
      const changedHtml = Boolean(html && html !== beforeHtml);
      const settledSelection = selected === wanted && Date.now() - started >= 160;
      if (html && (nativeLocale === wanted || changedEditor || changedHtml || settledSelection)) return html;
      await wait(60);
    }
    throw new Error(`Native HTML for ${wanted} was not ready`);
  }

  async function rebindWorkspaceAfterLocaleChange(targetLocale = '') {
    const base = root.__RetKitMoEngageCore;
    if (!document.getElementById(IDS.workspace) || !base?.rebindNativeEditorFromMoEngage) return false;
    const wanted = displayLocale(targetLocale);

    for (const delay of [60, 120, 220, 360, 600, 900, 1400]) {
      await wait(delay);
      const workspace = document.getElementById(IDS.workspace);
      const nativeNode = [...document.querySelectorAll('.CodeMirror')].find((node) => !workspace?.contains(node) && node?.CodeMirror);
      const native = nativeNode?.CodeMirror || null;
      const nativeLocale = displayLocale(localeFromHtml(native?.getValue?.() || ''));
      if (wanted && nativeLocale && nativeLocale !== wanted) continue;
      if (base.rebindNativeEditorFromMoEngage({ preserveCursor: false })) {
        syncSubjectFromMoEngage(true);
        return true;
      }
    }
    return false;
  }

  function setLocaleLoading(locale, visible) {
    const workspace = document.getElementById(IDS.workspace);
    if (!workspace) return;
    let loading = document.getElementById(IDS.localeLoading);
    if (!visible) {
      loading?.remove();
      return;
    }
    if (!loading) {
      loading = document.createElement('div');
      loading.id = IDS.localeLoading;
      workspace.appendChild(loading);
    }
    setTextContentIfChanged(loading, `Switching to ${displayLocale(locale) || locale}…`);
  }


  function replaceOverlayHtmlAsEdit(editor, nextHtml, origin = 'retkit-rtl') {
    if (!editor?.replaceRange || !editor?.getValue) return false;
    const previous = editor.getValue();
    if (previous === nextHtml) return true;
    const cursor = editor.getCursor?.() || { line: 0, ch: 0 };
    const scroll = editor.getScrollInfo?.() || null;
    const lastLine = Math.max(0, (editor.lineCount?.() || 1) - 1);
    const end = { line: lastLine, ch: String(editor.getLine?.(lastLine) || '').length };
    const apply = () => editor.replaceRange(String(nextHtml || ''), { line: 0, ch: 0 }, end, origin);
    if (typeof editor.operation === 'function') editor.operation(apply);
    else apply();
    try {
      const finalLine = Math.max(0, (editor.lineCount?.() || 1) - 1);
      const line = Math.min(cursor.line || 0, finalLine);
      const ch = Math.min(cursor.ch || 0, String(editor.getLine?.(line) || '').length);
      editor.setCursor?.({ line, ch });
      if (scroll) editor.scrollTo?.(scroll.left, scroll.top);
    } catch {}
    return editor.getValue() === String(nextHtml || '');
  }

  function applyRtlFix() {
    const editor = getOverlayEditor();
    if (!editor) {
      workspaceStatus('RetKit editor is not ready', 'error');
      return;
    }

    const active = getActiveLocale();
    const localeKey = displayLocale(active) || '__CURRENT__';
    const currentHtml = editor.getValue();
    const toggleState = rtlToggleStates.get(localeKey) || null;

    if (toggleState && rtlToggleDecision(toggleState.before, toggleState.after, currentHtml) === 'revert') {
      const restored = toggleState.before;
      const changed = replaceOverlayHtmlAsEdit(editor, restored, 'retkit-rtl-revert');
      if (!changed) {
        diagIncident('rtl_fix_apply_failed', 'RetKit could not restore the RTL snapshot in the editor', { locale: active || '' });
        workspaceStatus('RTL Fix: could not restore this locale', 'error');
        return;
      }
      rtlToggleStates.delete(localeKey);
      editor.focus?.();
      diagBreadcrumb('rtl.fix.reverted', { locale: active || '', length: restored.length });
      workspaceStatus(`RTL Fix reverted${active ? ` · ${active}` : ''}`, 'ok');
      updateLocaleUi(false);
      return;
    }

    const result = transformRtlHtml(currentHtml, { allParagraphs: true });
    if (!result.totalCount) {
      workspaceStatus('RTL Fix: nothing to change', 'ok');
      return;
    }

    const changed = replaceOverlayHtmlAsEdit(editor, result.html, 'retkit-rtl-apply');
    if (!changed) {
      diagIncident('rtl_fix_apply_failed', 'RetKit transform succeeded but the editor did not keep the RTL HTML', {
        locale: active || '',
        beforeLength: currentHtml.length,
        afterLength: result.html.length,
      });
      workspaceStatus('RTL Fix: editor rejected the transformed HTML', 'error');
      return;
    }

    rtlToggleStates.set(localeKey, { locale: active, before: currentHtml, after: result.html });
    editor.focus?.();
    diagBreadcrumb('rtl.fix.applied', {
      locale: active || '',
      paragraphCount: result.paragraphCount,
      cellCount: result.cellCount,
      alignCount: result.alignCount || 0,
      beforeLength: currentHtml.length,
      afterLength: result.html.length,
    });
    workspaceStatus(`RTL Fix applied${active ? ` · ${active}` : ''}: ${result.paragraphCount} p + ${result.cellCount} td + ${result.alignCount || 0} aligned containers`, 'ok');
    updateLocaleUi(false);
  }

  function renderLocaleStrip(forceDiscovery = false) {
    const strip = document.getElementById(IDS.localeStrip);
    if (!strip) return;

    let locales = [];
    if (!forceDiscovery && strip.dataset.locales) {
      locales = strip.dataset.locales.split(',').filter(Boolean);
    } else {
      locales = discoverNativeLocales();
      strip.dataset.locales = locales.join(',');
      scheduleNativeLocaleDiscovery(forceDiscovery ? 0 : 30);
    }

    const active = getActiveLocale();
    const signature = `${active}|${locales.join(',')}`;
    if (strip.dataset.signature === signature) return;
    strip.dataset.signature = signature;
    strip.replaceChildren();

    for (const locale of locales) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = `rk-v052-locale-tab${locale === active ? ' rk-active' : ''}`;
      tab.textContent = localeUiLabel(locale);
      tab.title = `Switch MoEngage to ${locale}`;
      tab.addEventListener('click', async () => {
        if (locale === getActiveLocale()) return;
        tab.disabled = true;
        setLocaleLoading(locale, true);
        workspaceStatus(`Switching MoEngage to ${locale}…`, 'neutral');
        try {
          const result = await switchNativeLocale(locale);
          if (result.ok) {
            workspaceStatus(`MoEngage locale: ${locale}`, 'ok');
            renderLocaleStrip(true);
            updateLocaleUi(false);
            syncSubjectFromMoEngage(true);
          } else {
            workspaceStatus(result.reason, 'error');
          }
        } finally {
          setLocaleLoading(locale, false);
          tab.disabled = false;
        }
      });
      const wrap = document.createElement('span');
      wrap.className = 'rk-v061-locale-wrap';
      wrap.appendChild(tab);
      if (canRemoveLocale(locale)) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'rk-v061-locale-remove';
        remove.textContent = '×';
        remove.title = `Remove ${locale} from MoEngage`;
        remove.addEventListener('click', async (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!root.confirm?.(`Remove locale ${locale} from this MoEngage campaign?`)) return;
          remove.disabled = true;
          workspaceStatus(`Removing ${locale}…`, 'neutral');
          try {
            const result = await removeNativeLocale(locale);
            workspaceStatus(result.ok ? `Removed ${locale}` : result.reason, result.ok ? 'ok' : 'error');
          } finally { remove.disabled = false; }
        });
        wrap.appendChild(remove);
      }
      strip.appendChild(wrap);
    }

    if (!locales.length) {
      const hint = document.createElement('span');
      hint.className = 'rk-v050-hint';
      hint.textContent = 'Locales…';
      strip.appendChild(hint);
    }
  }

  function findByExactText(rootNode, labels, selector = 'button,[role="button"],a,span,div,label') {
    const wanted = new Set((Array.isArray(labels) ? labels : [labels]).map((item) => String(item).trim().toLowerCase()));
    let best = null;
    for (const el of rootNode.querySelectorAll(selector)) {
      const text = textOf(el).toLowerCase();
      if (!wanted.has(text) || !isVisible(el)) continue;
      if (!best || el.children.length < best.children.length) best = el;
    }
    return best;
  }

  function findLabeledControl(section, labelText) {
    const label = findByExactText(section, labelText, 'label,span,div,p,strong');
    if (!label) return null;
    const selector = 'select,[role="combobox"],[aria-haspopup="listbox"],[aria-haspopup="menu"],[aria-expanded],button,input,[tabindex]';

    // MoEngage Test Campaign uses MDS dropdown containers. Prefer the actual
    // dropdown nearest the label rather than a nested arrow/button.
    const lr = label.getBoundingClientRect?.();
    if (lr) {
      let dropdownBest = null;
      let dropdownScore = Infinity;
      for (const dropdown of section.querySelectorAll('.mds-dropdown')) {
        if (!isVisible(dropdown) || isRetKitElement(dropdown)) continue;
        const dr = dropdown.getBoundingClientRect?.();
        if (!dr) continue;
        const vertical = Math.max(0, dr.top - lr.bottom);
        if (dr.top < lr.top - 8 || vertical > 190) continue;
        const score = labeledControlGeometryScore(lr, dr);
        if (score < dropdownScore) { dropdownBest = dropdown; dropdownScore = score; }
      }
      if (dropdownBest) return dropdownBest;
    }

    // First prefer the nearest control visually below the label. MoEngage's
    // Test Campaign uses React dropdowns whose label and trigger are siblings,
    // sometimes without for/id/data-testid links.
    let best = null;
    let bestScore = Infinity;
    for (const control of section.querySelectorAll(selector)) {
      if (control === label || !isVisible(control) || control.closest(`#${IDS.workspace}`)) continue;
      const fr = control.getBoundingClientRect?.();
      if (!lr || !fr) continue;
      const vertical = Math.max(0, fr.top - lr.bottom);
      const leftDelta = Math.abs(fr.left - lr.left);
      const sameColumnPenalty = leftDelta > Math.max(220, fr.width) ? 500 : 0;
      const score = labeledControlGeometryScore(lr, fr) + sameColumnPenalty;
      if (fr.top < lr.top - 8 || vertical > 190) continue;
      if (score < bestScore) { best = control; bestScore = score; }
    }
    if (best) return best;

    let cursor = label.parentElement;
    for (let depth = 0; cursor && depth < 7 && section.contains(cursor); depth += 1, cursor = cursor.parentElement) {
      const controls = [...cursor.querySelectorAll(selector)].filter((control) => control !== label && isVisible(control));
      if (controls.length === 1) return controls[0];
    }
    return null;
  }

  function setNativeValue(element, value) {
    if (!element) return false;
    const next = String(value ?? '');
    const isEditable = element.getAttribute?.('contenteditable') === 'true' || element.isContentEditable === true;
    if (isEditable) {
      try { element.focus?.(); } catch {}
      if (element.textContent !== next) element.textContent = next;
      try { element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next })); }
      catch { try { element.dispatchEvent(new Event('input', { bubbles: true })); } catch {} }
      try { element.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
      return true;
    }
    const proto = element.tagName === 'TEXTAREA' ? root.HTMLTextAreaElement?.prototype : root.HTMLInputElement?.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    try {
      if (setter) setter.call(element, next);
      else element.value = next;
    } catch { element.value = next; }
    dispatchChange(element);
    return true;
  }

  function readNativeValue(element) {
    if (!element) return '';
    const isEditable = element.getAttribute?.('contenteditable') === 'true' || element.isContentEditable === true;
    return String(isEditable ? (element.textContent || '') : (element.value || ''));
  }



  function findFieldNearTextLabel(labelPattern) {
    const workspace = document.getElementById(IDS.workspace);
    const labels = [...document.querySelectorAll('label,span,div,p,strong')]
      .filter((el) => !workspace?.contains(el) && labelPattern.test(textOf(el)) && isVisible(el));
    const fields = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')]
      .filter((el) => !workspace?.contains(el) && isVisible(el) && isTextLikeSubjectFieldElement(el));
    let best = null;
    let bestScore = Infinity;
    for (const label of labels) {
      const lr = label.getBoundingClientRect?.();
      for (const field of fields) {
        const fr = field.getBoundingClientRect?.();
        let score = 100000;
        if (lr && fr) {
          const vertical = Math.max(0, fr.top - lr.bottom);
          const reverse = Math.max(0, lr.top - fr.bottom);
          const horizontal = Math.abs((fr.left + fr.right) / 2 - (lr.left + lr.right) / 2);
          const overlap = Math.max(0, Math.min(fr.right, lr.right) - Math.max(fr.left, lr.left));
          score = vertical * 3 + reverse * 12 + horizontal * 0.2 - Math.min(overlap, 200) * 0.4;
          if (fr.top < lr.top - 12) score += 500;
          if (Math.abs(fr.top - lr.bottom) > 260) score += 1000;
        } else {
          const relation = label.compareDocumentPosition?.(field) || 0;
          score = relation & Node.DOCUMENT_POSITION_FOLLOWING ? 100 : 1000;
        }
        if (score < bestScore) { best = field; bestScore = score; }
      }
    }
    return bestScore < 1300 ? best : null;
  }


  // The Subject lookup can scan every label/span/div on the MoEngage page, and
  // the toolbar heartbeat calls it about once a second. Reuse the last match
  // while it is still mounted and visible; rescan only when React replaced it.
  let cachedNativeSubjectInput = null;

  function findNativeSubjectInput() {
    const workspace = document.getElementById(IDS.workspace);
    const cached = cachedNativeSubjectInput;
    if (cached && cached.isConnected && !workspace?.contains(cached) && isVisible(cached)) return cached;
    cachedNativeSubjectInput = locateNativeSubjectInput() || null;
    return cachedNativeSubjectInput;
  }

  function locateNativeSubjectInput() {
    const workspace = document.getElementById(IDS.workspace);
    const directSelectors = [
      'input[name*="subject" i]',
      'input[id*="subject" i]',
      'input[placeholder*="subject" i]',
      '[data-testid*="subject" i] input',
      '[contenteditable="true"][placeholder*="subject" i]',
      '#personalization_container[contenteditable="true"][placeholder*="subject" i]',
    ];
    for (const selector of directSelectors) {
      for (const input of document.querySelectorAll(selector)) {
        if (workspace?.contains(input) || !isVisible(input)) continue;
        return input;
      }
    }

    const labels = [...document.querySelectorAll('label,span,div,p')]
      .filter((el) => !workspace?.contains(el) && /^Subject\s*\*?$/i.test(textOf(el)) && isVisible(el))
      .sort((a, b) => a.children.length - b.children.length);
    for (const label of labels) {
      let cursor = label.parentElement;
      for (let depth = 0; cursor && depth < 8; depth += 1, cursor = cursor.parentElement) {
        if (workspace?.contains(cursor)) break;
        const inputs = [...cursor.querySelectorAll('input, textarea, [contenteditable="true"]')].filter((input) => isVisible(input) && !workspace?.contains(input) && isTextLikeSubjectFieldElement(input));
        if (inputs.length === 1) return inputs[0];
      }
    }
    return findFieldNearTextLabel(/^Subject\s*\*?$/i);
  }

  function syncSubjectFromMoEngage(force = false) {
    const multiLocaleBusy = Boolean(root.__RetKitMoEngageCore?.isMultiLocaleBusy?.());
    if (multiLocaleBusy) return false;
    const target = document.getElementById(IDS.subjectInput);
    const native = findNativeSubjectInput();
    if (!target || !native) return false;
    if (!force && document.activeElement === target) return false;
    const next = readNativeValue(native);
    if (target.value === next) return false;
    target.value = next;
    return true;
  }

  function commitSubjectToMoEngage(value) {
    const native = findNativeSubjectInput();
    if (!native) {
      workspaceStatus('MoEngage Subject field was not found', 'error');
      return false;
    }
    const next = String(value ?? '');
    if (readNativeValue(native) === next) return true;
    setNativeValue(native, next);
    try { native.dispatchEvent(new Event('blur', { bubbles: true })); } catch {}
    workspaceStatus('Subject updated in MoEngage', 'ok');
    return true;
  }

  function findPersonaliseSwitch(section) {
    const direct = section.querySelector('input[name="Personalized preview" i], input[name="Personalised preview" i]');
    if (direct) return direct;
    const label = [...section.querySelectorAll('label,span,div,p')].find((el) => /Personalise with a random user/i.test(textOf(el)));
    if (!label) return null;
    let cursor = label;
    for (let depth = 0; cursor && depth < 5 && section.contains(cursor); depth += 1, cursor = cursor.parentElement) {
      const control = cursor.querySelector('input[type="checkbox"],[role="switch"]');
      if (control) return control;
    }
    return null;
  }

  function setSwitchState(control, checked) {
    if (!control) return false;
    const current = control.matches('input') ? Boolean(control.checked) : control.getAttribute('aria-checked') === 'true';
    if (current !== Boolean(checked)) control.click();
    return true;
  }

  function findPortalAction(label, options = {}) {
    const workspace = document.getElementById(IDS.workspace);
    const localeBar = options.excludeLocaleBar ? findNativeLocaleBar() : null;
    const wanted = String(label || '').trim().toLowerCase();
    let best = null;
    let bestScore = Infinity;
    for (const el of document.querySelectorAll('[role="option"],[role="menuitem"],li,label,button,a,span,div')) {
      if (isRetKitElement(el) || localeBar?.contains(el) || !isVisible(el) || textOf(el).toLowerCase() !== wanted) continue;
      const clickable = el.closest('[role="option"],[role="menuitem"],li,label,button,a') || el;
      const roleScore = clickable.matches?.('[role="option"],[role="menuitem"]') ? 0 : clickable.matches?.('li,label') ? 10 : 30;
      const score = roleScore + textOf(clickable).length + clickable.children.length * 4;
      if (score < bestScore) { best = clickable; bestScore = score; }
    }
    return best;
  }

  function testLocalePortalLabels(locale) {
    return nativeLocaleLabels(locale);
  }

  function dropdownClickable(control) {
    if (!control) return null;
    if (control.tagName === 'SELECT') return control;
    if (isMdsDropdownMeta({ className: control.className })) {
      return control.querySelector('.mds-dropdown__trigger, .mds-dropdown__trigger__inner, button, [role="button"], [tabindex]') || control;
    }
    return control.matches?.('button,[role="button"],[role="combobox"]')
      ? control
      : control.querySelector?.('button,[role="button"],[role="combobox"],[tabindex]') || control;
  }

  async function waitForPortalAction(label, options = {}, timeout = 1800) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const found = findPortalAction(label, options);
      if (found) return found;
      await wait(80);
    }
    return null;
  }

  async function waitForMdsPopupOption(label, timeout = 2200) {
    const wanted = String(label || '').replace(/\s+/g, ' ').trim();
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const items = [...document.querySelectorAll('.mds-dropdown__popup__list__item')];
      const found = items.find((el) => !isRetKitElement(el) && isMdsPopupOptionMeta({ className: el.className, text: textOf(el) }, wanted));
      if (found) return found;
      await wait(70);
    }
    return null;
  }

  function testLocalePopupFromAction(action) {
    let cursor = action;
    for (let depth = 0; cursor && depth < 8 && cursor !== document.body; depth += 1, cursor = cursor.parentElement) {
      const text = textOf(cursor);
      if (/Clear all/i.test(text) && /Select all/i.test(text) && /(?:Default|\bEN\b)/i.test(text)) return cursor;
    }
    return null;
  }

  function collectTestLocaleOptions(popup) {
    if (!popup) return [];
    const options = [];
    const seen = new Set();
    const selectors = [
      '[data-testid^="test-campaign-variation-locale-dropdown-option-"]',
      '.mds-dropdown__popup__list__item',
      '[role="option"]',
    ];

    for (const el of popup.querySelectorAll(selectors.join(','))) {
      const row = el.closest?.('[data-testid^="test-campaign-variation-locale-dropdown-option-"],.mds-dropdown__popup__list__item,[role="option"]') || el;
      if (!popup.contains(row) || seen.has(row) || !isVisible(row)) continue;
      const labelNode = row.querySelector?.('.mds-dropdown__popup__list__item__label') || row;
      const label = textOf(labelNode);
      const locale = testLocaleLabelToDisplay(label);
      if (!locale || !isKnownLocale(locale)) continue;
      seen.add(row);
      options.push({ locale, label, option: row });
    }
    return options;
  }

  function collectTestLocalePopupLabels(popup) {
    const exact = collectTestLocaleOptions(popup).map((item) => item.label);
    if (exact.length) return exact;

    // Fallback for older MDS builds that did not expose option test ids/classes.
    if (!popup) return [];
    const labels = [];
    const seen = new Set();
    for (const el of popup.querySelectorAll('label,[role="option"],li,button,span,div')) {
      const text = textOf(el);
      if (!text || text.length > 24) continue;
      const locale = testLocaleLabelToDisplay(text);
      if (!locale || !isKnownLocale(locale)) continue;
      if (seen.has(text)) continue;
      const sameChild = [...el.children].some((child) => textOf(child) === text);
      if (sameChild) continue;
      seen.add(text);
      labels.push(text);
    }
    return labels;
  }

  function findTestLocaleOptionInPopup(popup, wantedLabel) {
    if (!popup) return null;
    const wanted = String(wantedLabel || '').replace(/\s+/g, ' ').trim();
    const wantedLocale = testLocaleLabelToDisplay(wanted);
    const exact = collectTestLocaleOptions(popup).find((item) => item.locale === wantedLocale || item.label.toLowerCase() === wanted.toLowerCase());
    if (exact) return exact.option;

    let best = null;
    let bestScore = Infinity;
    for (const el of popup.querySelectorAll('label,[role="option"],li,button,span,div')) {
      if (textOf(el).toLowerCase() !== wanted.toLowerCase()) continue;
      const clickable = el.closest('.mds-dropdown__popup__list__item,label,[role="option"],li,button') || el;
      if (!popup.contains(clickable)) continue;
      const score = clickable.children.length * 5 + textOf(clickable).length;
      if (score < bestScore) { best = clickable; bestScore = score; }
    }
    return best;
  }

  function findVisibleTestLocalePopup(control) {
    const trigger = dropdownClickable(control) || control;
    const triggerRect = trigger?.getBoundingClientRect?.() || null;
    const candidates = [];
    const seen = new Set();
    const consider = (node) => {
      if (!node || seen.has(node) || isRetKitElement(node) || !isVisible(node)) return;
      seen.add(node);
      const labels = collectTestLocalePopupLabels(node);
      if (!labels.length) return;
      const rect = node.getBoundingClientRect?.();
      let distance = 0;
      if (triggerRect && rect) {
        const tx = triggerRect.left + triggerRect.width / 2;
        const ty = triggerRect.top + triggerRect.height / 2;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        distance = Math.hypot(cx - tx, cy - ty);
      }
      candidates.push({ node, labels, distance, area: (rect?.width || 0) * (rect?.height || 0) });
    };

    for (const node of document.querySelectorAll('.mds-dropdown__popup,[role="listbox"],[role="menu"],.mds-popover')) consider(node);
    if (!candidates.length) {
      for (const option of document.querySelectorAll('.mds-dropdown__popup__list__item,[role="option"],label,li')) {
        if (!isVisible(option) || isRetKitElement(option)) continue;
        const locale = testLocaleLabelToDisplay(textOf(option));
        if (!locale || !isKnownLocale(locale)) continue;
        let cursor = option;
        for (let depth = 0; cursor && depth < 7 && cursor !== document.body; depth += 1, cursor = cursor.parentElement) {
          consider(cursor);
          if (candidates.length) break;
        }
      }
    }
    candidates.sort((a, b) => (a.distance - b.distance) || (a.area - b.area));
    return candidates[0]?.node || null;
  }

  function isTestLocaleOptionChecked(option) {
    if (!option) return false;
    const checkbox = option.matches?.('input[type="checkbox"]')
      ? option
      : option.querySelector?.('input[type="checkbox"],[role="checkbox"]');
    if (checkbox?.matches?.('input[type="checkbox"]')) return Boolean(checkbox.checked);
    const aria = checkbox?.getAttribute?.('aria-checked') ?? option.getAttribute?.('aria-checked');
    if (aria === 'true') return true;
    if (aria === 'false') return false;
    return /(?:^|[-_\s])(selected|checked|active)(?:$|[-_\s])/i.test(String(option.className || ''));
  }

  function setTestLocaleOptionState(option, checked) {
    if (!option) return false;
    if (isTestLocaleOptionChecked(option) === Boolean(checked)) return true;
    activateNativeControl(option);
    return true;
  }

  function findExactTestLocalePopup(control = null) {
    const popups = [...document.querySelectorAll('[data-testid="test-campaign-variation-locale-dropdown-popup"]')]
      .filter((popup) => popup?.isConnected && !isRetKitElement(popup) && isVisible(popup));
    if (!popups.length) return null;

    const trigger = dropdownClickable(control) || control;
    const triggerRect = trigger?.getBoundingClientRect?.() || null;
    const scored = popups.map((popup, index) => {
      const rect = popup.getBoundingClientRect?.();
      const optionCount = collectTestLocaleOptions(popup).length;
      const actionCount = Number(Boolean(findTestLocalePopupAction(popup, 'Select all')))
        + Number(Boolean(findTestLocalePopupAction(popup, 'Clear all')));
      let distance = 0;
      if (triggerRect && rect) {
        const tx = triggerRect.left + triggerRect.width / 2;
        const ty = triggerRect.top + triggerRect.height / 2;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        distance = Math.hypot(cx - tx, cy - ty);
      }
      // Prefer a populated, current portal. Tether may leave older visible-looking
      // nodes in the DOM while React mounts the replacement. Later DOM nodes win ties.
      const score = (actionCount ? 0 : 4000) + (optionCount ? 0 : 2000) - optionCount * 40 + distance - index * 0.01;
      return { popup, score };
    });
    scored.sort((a, b) => a.score - b.score);
    return scored[0]?.popup || null;
  }

  function findTestLocalePopupAction(popup, label) {
    if (!popup) return null;
    const wanted = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const candidates = popup.querySelectorAll('[role="button"],button,a,span,div');
    for (const el of candidates) {
      if (!isVisible(el) || textOf(el).toLowerCase() !== wanted) continue;
      return el.closest('[role="button"],button,a') || el;
    }
    return null;
  }

  async function waitForTestLocalePopup(control, timeout = 1100) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const popup = findExactTestLocalePopup(control) || findVisibleTestLocalePopup(control);
      if (popup) return popup;
      await wait(70);
    }
    return null;
  }

  async function waitForTestLocaleAction(control, label, timeout = 2600) {
    const started = Date.now();
    let lastPopup = null;
    while (Date.now() - started < timeout) {
      const popup = findExactTestLocalePopup(control) || findVisibleTestLocalePopup(control);
      if (popup) {
        lastPopup = popup;
        const action = findTestLocalePopupAction(popup, label);
        if (action) return { popup, action };
      }
      await wait(80);
    }
    return { popup: lastPopup, action: null };
  }

  async function waitForTestLocaleOptions(control, requiredLocales = [], timeout = 2800) {
    const required = filterKnownLocales(requiredLocales || []);
    const started = Date.now();
    let last = { popup: null, options: [] };
    while (Date.now() - started < timeout) {
      const popup = findExactTestLocalePopup(control) || findVisibleTestLocalePopup(control);
      if (popup) {
        const options = collectTestLocaleOptions(popup);
        last = { popup, options };
        const available = new Set(options.map((item) => item.locale));
        if (!required.length || required.every((locale) => available.has(locale))) return last;
      }
      await wait(80);
    }
    return last;
  }

  async function setExactTestLocaleOptions(control, selectedLocales, campaignLocales, timeout = 3200) {
    const selected = new Set(filterKnownLocales(selectedLocales || []));
    const campaign = filterKnownLocales(campaignLocales || []);
    const required = campaign.length ? campaign : [...selected];
    let state = await waitForTestLocaleOptions(control, required, timeout);
    if (!state.popup) return { ok: false, reason: 'Test Campaign locale dropdown did not expose options' };

    const available = new Set(state.options.map((item) => item.locale));
    const missing = required.filter((locale) => !available.has(locale));
    if (missing.length) return { ok: false, reason: `Test Campaign locales not found: ${missing.join(', ')}`, available: [...available] };

    // Set the exact checkbox state instead of depending on Clear all / Select all.
    // This survives MDS remounts because every click re-acquires the live portal.
    for (const locale of required) {
      state = await waitForTestLocaleOptions(control, [locale], 1400);
      const item = state.options.find((entry) => entry.locale === locale);
      if (!item) return { ok: false, reason: `Test Campaign locale option was not found: ${locale}` };
      const should = selected.has(locale);
      if (isTestLocaleOptionChecked(item.option) !== should) {
        activateNativeControl(item.option);
        await wait(140);
      }
    }

    const verify = await waitForTestLocaleOptions(control, required, 1800);
    const byLocale = new Map(verify.options.map((item) => [item.locale, item]));
    const wrong = required.filter((locale) => {
      const item = byLocale.get(locale);
      return !item || isTestLocaleOptionChecked(item.option) !== selected.has(locale);
    });
    return wrong.length
      ? { ok: false, reason: `MoEngage did not keep Test Campaign locales: ${wrong.join(', ')}` }
      : { ok: true };
  }

  async function openTestLocalePopup(control) {
    const trigger = control?.matches?.('[data-testid="test-campaign-variation-locale-dropdown"]')
      ? control
      : control?.querySelector?.('[data-testid="test-campaign-variation-locale-dropdown"]') || dropdownClickable(control) || control;

    const exactPopup = () => [...document.querySelectorAll('[data-testid="test-campaign-variation-locale-dropdown-popup"]')]
      .filter((popup) => popup?.isConnected && !isRetKitElement(popup))
      .at(-1) || null;

    const readActions = (popup) => {
      if (!popup) return { popup: null, selectAll: null, clearAll: null };
      const actions = [...popup.querySelectorAll('.mds-dropdown__popup__select-deselect-all,[role="button"],button,span')];
      const exact = (label) => actions.find((el) => textOf(el).replace(/\s+/g, ' ').trim().toLowerCase() === label.toLowerCase()) || null;
      return { popup, selectAll: exact('Select all'), clearAll: exact('Clear all') };
    };

    let popup = exactPopup();
    if (popup && /Select all/i.test(textOf(popup)) && /(?:Default|\bEN\b)/i.test(textOf(popup))) return readActions(popup);

    const host = trigger?.closest?.('.mds-dropdown') || mdsDropdownHost(control);
    const target = trigger?.querySelector?.('.mds-dropdown__trigger__inner') || trigger || host;
    if (!host || !invokeReactHandler(host, 'onMouseDown', target)) {
      return { popup: null, selectAll: null, clearAll: null };
    }

    const started = Date.now();
    while (Date.now() - started < 1800) {
      popup = exactPopup();
      if (popup && /Select all/i.test(textOf(popup)) && /(?:Default|\bEN\b)/i.test(textOf(popup))) {
        return readActions(popup);
      }
      await wait(50);
    }
    return readActions(popup);
  }

  async function waitForTestLocalePlan(control, selectedLocales, timeout = 1800) {
    const selected = filterKnownLocales(selectedLocales || []);
    const started = Date.now();
    let opened = await openTestLocalePopup(control);
    let plan = { requested: selected, labels: [], missing: selected, available: [], useSelectAll: false };

    while (opened.popup && Date.now() - started < timeout) {
      const labels = collectTestLocalePopupLabels(opened.popup);
      plan = resolveTestLocaleSelectionPlan(selected, labels);
      if (!plan.missing.length) return { opened, plan };
      await wait(90);
      const livePopup = findExactTestLocalePopup(control) || findVisibleTestLocalePopup(control);
      if (livePopup && livePopup !== opened.popup) {
        opened = {
          popup: livePopup,
          selectAll: findTestLocalePopupAction(livePopup, 'Select all'),
          clearAll: findTestLocalePopupAction(livePopup, 'Clear all'),
        };
      }
    }
    return { opened, plan };
  }

  async function waitForTestLocaleChecked(control, locale, checked = true, timeout = 1200) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const popup = findExactTestLocalePopup(control) || findVisibleTestLocalePopup(control);
      if (popup) {
        const item = collectTestLocaleOptions(popup).find((entry) => entry.locale === displayLocale(locale));
        if (item && isTestLocaleOptionChecked(item.option) === Boolean(checked)) return true;
      }
      await wait(80);
    }
    return false;
  }

  async function selectExplicitTestLocales(section, selectedLocales) {
    const control = findTestCampaignLocaleControl(section);
    if (!control) return { ok: false, reason: 'Locales and Variations control was not found' };
    const selected = filterKnownLocales(selectedLocales || []);
    if (!selected.length) return { ok: false, reason: 'Select at least one locale for the test' };

    if (control.tagName === 'SELECT') {
      const options = [...control.options];
      let matches = 0;
      for (const option of options) {
        const shown = displayLocale(localeFromOptionElement(option));
        const should = selected.includes(shown);
        option.selected = should;
        if (should) matches += 1;
      }
      if (!matches) return { ok: false, reason: 'Selected locales are not available in Test Campaign' };
      dispatchChange(control);
      return { ok: true };
    }

    let opened = await openTestLocalePopup(control);
    if (!opened.popup) return { ok: false, reason: 'Test Campaign locale dropdown did not open' };

    const readRows = (popup) => [...popup.querySelectorAll('[data-testid^="test-campaign-variation-locale-dropdown-option-"],.mds-dropdown__popup__list__item')]
      .map((row) => {
        const labelNode = row.querySelector?.('.mds-dropdown__popup__list__item__label') || row;
        const label = textOf(labelNode).replace(/\s+/g, ' ').trim();
        return { row, label, locale: testLocaleLabelToDisplay(label) };
      })
      .filter((item, index, all) => item.locale && isKnownLocale(item.locale) && all.findIndex((x) => x.row === item.row) === index);

    let rows = readRows(opened.popup);
    const available = [...new Set(rows.map((item) => item.locale))];
    const missing = selected.filter((locale) => !available.includes(locale));
    if (missing.length) return { ok: false, reason: `Test Campaign locales not found: ${missing.join(', ')}`, meta: { availableLocales: available } };

    const wantsAll = available.length > 1 && selected.length === available.length && selected.every((locale) => available.includes(locale));

    if (wantsAll) {
      const selectAll = opened.selectAll || [...opened.popup.querySelectorAll('.mds-dropdown__popup__select-deselect-all,[role="button"],span')]
        .find((el) => /^Select all$/i.test(textOf(el).trim()));
      if (!selectAll) return { ok: false, reason: 'Test Campaign Select all action was not found', meta: { availableLocales: available } };
      if (!activateReactClickable(selectAll)) return { ok: false, reason: 'Test Campaign Select all action could not be invoked' };

      const started = Date.now();
      while (Date.now() - started < 1800) {
        const liveSection = findTestCampaignSection() || section;
        const liveControl = findTestCampaignLocaleControl(liveSection) || control;
        if (/All\s+Locales\s+selected/i.test(textOf(liveControl))) {
          return { ok: true, selectedLocales: selected, usedSelectAll: true };
        }
        await wait(60);
      }
      return { ok: false, reason: 'MoEngage did not keep All Locales selected', meta: { localeText: textOf(findTestCampaignLocaleControl(findTestCampaignSection() || section) || control) } };
    }

    const clearAll = opened.clearAll || [...opened.popup.querySelectorAll('.mds-dropdown__popup__select-deselect-all,[role="button"],span')]
      .find((el) => /^Clear all$/i.test(textOf(el).trim()));
    if (clearAll) {
      activateReactClickable(clearAll);
      await wait(180);
    }

    for (const locale of selected) {
      let popup = [...document.querySelectorAll('[data-testid="test-campaign-variation-locale-dropdown-popup"]')]
        .filter((el) => el?.isConnected && !isRetKitElement(el)).at(-1) || null;
      if (!popup) {
        opened = await openTestLocalePopup(findTestCampaignLocaleControl(findTestCampaignSection() || section) || control);
        popup = opened.popup;
      }
      rows = readRows(popup);
      const item = rows.find((entry) => entry.locale === locale);
      if (!item) return { ok: false, reason: `Test Campaign locale option was not found: ${locale}` };
      if (!isTestLocaleOptionChecked(item.row)) {
        activateReactClickable(item.row);
        await wait(160);
      }
    }

    const verifyStarted = Date.now();
    while (Date.now() - verifyStarted < 1600) {
      const popup = [...document.querySelectorAll('[data-testid="test-campaign-variation-locale-dropdown-popup"]')]
        .filter((el) => el?.isConnected && !isRetKitElement(el)).at(-1) || null;
      if (popup) {
        const byLocale = new Map(readRows(popup).map((item) => [item.locale, isTestLocaleOptionChecked(item.row)]));
        if (selected.every((locale) => byLocale.get(locale) === true)) return { ok: true, selectedLocales: selected, usedSelectAll: false };
      }
      await wait(70);
    }
    return { ok: false, reason: `MoEngage did not keep Test Campaign locales: ${selected.join(', ')}` };
  }


  const TEST_SEND_VIA_OPTIONS = [
    'Email ID (Non-registered users)',
    'Email ID (Registered users)',
    'Custom Segment',
    'Unique ID',
    'Mobile Number',
  ];

  async function selectNativeSendVia(section, wantedMode) {
    const wanted = TEST_SEND_VIA_OPTIONS.includes(wantedMode)
      ? wantedMode
      : 'Email ID (Non-registered users)';
    const control = findLabeledControl(section, 'Send via');
    if (!control) return { ok: false, reason: 'Send via control was not found' };

    if (control.tagName === 'SELECT') {
      const option = [...control.options].find((item) => textOf(item) === wanted || String(item.value) === wanted);
      if (!option) return { ok: false, reason: `Send via option was not found: ${wanted}` };
      setNativeSelect(control, option);
      return { ok: true };
    }

    if (textOf(control).includes(wanted)) return { ok: true };
    const sendViaTrigger = dropdownClickable(control);
    activateMdsDropdown(control);
    let option = await waitForMdsPopupOption(wanted, 850);
    if (!option) option = await waitForPortalAction(wanted, {}, 550);
    if (!option) {
      const host = mdsDropdownHost(control);
      if (host) invokeReactHandler(host, 'onMouseDown', sendViaTrigger || control);
      option = await waitForMdsPopupOption(wanted, 850);
      if (!option) option = await waitForPortalAction(wanted, {}, 550);
    }
    if (!option) {
      try { sendViaTrigger?.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true })); } catch {}
      option = await waitForMdsPopupOption(wanted, 700);
      if (!option) option = await waitForPortalAction(wanted, {}, 700);
    }
    if (!option) return { ok: false, reason: `Send via dropdown did not expose option: ${wanted}` };
    activateNativeControl(option);
    await wait(240);
    if (!textOf(control).includes(wanted)) {
      await wait(220);
      if (!textOf(control).includes(wanted)) return { ok: false, reason: `MoEngage did not switch Send via to ${wanted}` };
    }
    return { ok: true };
  }

  function findTestCampaignEmailField(section) {
    if (!section?.querySelector) return null;
    return section.querySelector(
      'input[placeholder*="Enter user email" i], textarea[placeholder*="Enter user email" i], input[type="email"], textarea[placeholder*="email" i]'
    ) || findLabeledControl(section, 'Enter user email');
  }

  function getTestCampaignButton(section) {
    if (!section?.querySelectorAll) return null;
    return [...section.querySelectorAll('button')].find((button) => /^(?:Test|Rerun Test)$/i.test(textOf(button))) || null;
  }

  function testCampaignState(section) {
    const emailField = findTestCampaignEmailField(section);
    const sendViaControl = findLabeledControl(section, 'Send via');
    const localeControl = findTestCampaignLocaleControl(section);
    const switchControl = findPersonaliseSwitch(section);
    const testButton = getTestCampaignButton(section);
    const emailValue = readNativeValue(emailField);
    return {
      sectionConnected: Boolean(section?.isConnected),
      emailFieldFound: Boolean(emailField),
      emailValueLength: emailValue.length,
      emailHasAtSign: emailValue.includes('@'),
      sendViaText: String(textOf(sendViaControl)).slice(0, 120),
      localeText: String(textOf(localeControl)).slice(0, 160),
      personalise: switchControl
        ? (switchControl.matches?.('input') ? Boolean(switchControl.checked) : switchControl.getAttribute?.('aria-checked') === 'true')
        : null,
      testButtonFound: Boolean(testButton),
      testButtonText: testButton ? textOf(testButton) : '',
      testButtonDisabled: testButton ? Boolean(testButton.disabled) : null,
    };
  }

  function dispatchEnterKey(element) {
    if (!element) return false;
    try { element.focus?.(); } catch {}
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    for (const type of ['keydown', 'keypress', 'keyup']) {
      try { element.dispatchEvent(new KeyboardEvent(type, init)); }
      catch { try { element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })); } catch {} }
    }
    return true;
  }

  async function waitForNativeTestButton(section, timeout = 3600) {
    const started = Date.now();
    let currentSection = section;
    let button = null;
    while (Date.now() - started < timeout) {
      currentSection = findTestCampaignSection() || currentSection;
      button = getTestCampaignButton(currentSection);
      if (button && !button.disabled) return { section: currentSection, button };
      await wait(120);
    }
    return { section: currentSection, button: button || getTestCampaignButton(currentSection) };
  }

  async function submitNativeTestCampaign(preferences) {
    const prefs = normaliseTestPreferences(preferences);
    let section = findTestCampaignSection();
    if (!section) return { ok: false, reason: 'MoEngage Test Campaign section was not found' };
    section.scrollIntoView?.({ block: 'center' });
    await wait(120);

    const selectedLocales = prefs.locales.length ? prefs.locales : [getActiveLocale()].filter(Boolean);

    // Recorded native MoEngage flow: pick locales first. Changing Send via after
    // that preserves the locale selection but remounts/clears the recipient field.
    // Doing Send via first was the source of the repeated empty locale portal.
    const localeResult = await selectExplicitTestLocales(section, selectedLocales);
    if (!localeResult.ok) return { ...localeResult, meta: { ...(localeResult.meta || {}), ...testCampaignState(section) } };

    section = findTestCampaignSection() || section;
    const sendViaResult = await selectNativeSendVia(section, prefs.sendVia);
    if (!sendViaResult.ok) return { ...sendViaResult, meta: testCampaignState(section) };
    await wait(220);

    section = findTestCampaignSection() || section;
    const localeControl = findTestCampaignLocaleControl(section);
    if (selectedLocales.length > 1 && !/All\s+Locales\s+selected/i.test(textOf(localeControl))) {
      return { ok: false, reason: 'MoEngage lost the locale selection after changing Send via', meta: testCampaignState(section) };
    }

    const emailField = findTestCampaignEmailField(section);
    if (!emailField) return { ok: false, reason: 'Test Campaign email field was not found', meta: testCampaignState(section) };
    if (!prefs.email || !prefs.email.includes('@')) return { ok: false, reason: 'Enter a test email address' };

    try { emailField.focus?.(); } catch {}
    setNativeValue(emailField, prefs.email);
    await wait(120);

    const switchControl = findPersonaliseSwitch(section);
    if (switchControl) setSwitchState(switchControl, prefs.personalise);
    await wait(160);

    let ready = await waitForNativeTestButton(section, 2600);
    if (ready.button?.disabled) {
      section = ready.section || findTestCampaignSection() || section;
      const liveEmailField = findTestCampaignEmailField(section) || emailField;
      if (liveEmailField) {
        setNativeValue(liveEmailField, prefs.email);
        await wait(160);
      }
      ready = await waitForNativeTestButton(section, 1800);
    }

    section = ready.section || findTestCampaignSection() || section;
    const testButton = ready.button || getTestCampaignButton(section);
    if (!testButton) return { ok: false, reason: 'Native MoEngage Test/Rerun Test button was not found', meta: testCampaignState(section) };
    if (testButton.disabled) return { ok: false, reason: 'Native MoEngage Test button is still disabled after RetKit filled the form.', meta: testCampaignState(section) };

    const accepted = root.confirm?.(`Send MoEngage test email to ${prefs.email}?\nLocales: ${selectedLocales.join(', ')}`);
    if (accepted === false) return { ok: false, reason: 'Cancelled' };

    const beforeLabel = textOf(testButton);
    const invoked = activateReactClickable(testButton);
    diagBreadcrumb('test.submit.native-react-click', { beforeLabel, invoked, locales: selectedLocales, sendVia: prefs.sendVia });
    if (!invoked) return { ok: false, reason: 'Native MoEngage Test button could not be invoked', meta: testCampaignState(section) };

    let acknowledged = false;
    const ackStarted = Date.now();
    while (Date.now() - ackStarted < 3600) {
      const liveSection = findTestCampaignSection() || section;
      const liveButton = getTestCampaignButton(liveSection);
      const liveLabel = textOf(liveButton);
      if ((/^Test$/i.test(beforeLabel) && /^Rerun Test$/i.test(liveLabel)) || liveButton?.disabled || !liveButton) {
        acknowledged = true;
        break;
      }
      await wait(120);
    }
    diagBreadcrumb('test.submit.native-ack', { acknowledged, beforeLabel });
    return { ok: true, reason: '', acknowledged };
  }

  function readTestPreferences() {
    try {
      return normaliseTestPreferences(JSON.parse(localStorage.getItem(STORAGE.testPrefs) || '{}'));
    } catch {
      return normaliseTestPreferences({});
    }
  }

  function writeTestPreferences(value) {
    const prefs = normaliseTestPreferences(value);
    localStorage.setItem(STORAGE.testPrefs, JSON.stringify(prefs));
    return prefs;
  }

  function renderTestLocaleChoices(container, availableLocales, selectedLocales) {
    if (!container) return;
    const available = sortLocalesForUi(availableLocales || []);
    const selected = new Set(filterKnownLocales(selectedLocales || []));
    container.replaceChildren();
    for (const locale of available) {
      const label = document.createElement('label');
      label.className = 'rk-v054-test-locale';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.testLocale = locale;
      checkbox.checked = selected.has(locale);
      const text = document.createElement('span');
      text.textContent = localeUiLabel(locale);
      label.append(checkbox, text);
      container.appendChild(label);
    }
  }

  function renderTestPopover() {
    const existing = document.getElementById(IDS.testPopover);
    if (existing) { existing.remove(); return; }
    closeBridgePopovers(IDS.testPopover);
    const prefs = readTestPreferences();
    const pop = document.createElement('div');
    pop.id = IDS.testPopover;
    pop.className = 'rk-v050-popover';
    const nativeTestReady = Boolean(findTestCampaignSection());
    const availableLocales = discoverNativeLocales();
    const active = getActiveLocale();
    if (active && !availableLocales.includes(active)) availableLocales.push(active);
    const orderedLocales = sortLocalesForUi(availableLocales);
    const initialLocales = prefs.locales.length ? prefs.locales : (active ? [active] : orderedLocales.slice(0, 1));

    pop.innerHTML = `
      <div class="rk-v050-head"><strong>Send test via MoEngage</strong><button class="rk-v050-secondary" data-close>×</button></div>
      <div class="rk-v050-grid">
        <div class="rk-v050-hint" data-native-status>${nativeTestReady ? 'Native Test Campaign found' : 'Native Test Campaign is not visible yet'}</div>
        <label class="rk-v050-grid"><span class="rk-v050-hint">Recipient email</span><input class="rk-v050-input" data-email type="email" autocomplete="email"></label>
        <label class="rk-v050-grid"><span class="rk-v050-hint">Send via</span><select class="rk-v050-select" data-send-via>
          <option>Email ID (Non-registered users)</option>
          <option>Email ID (Registered users)</option>
          <option>Custom Segment</option>
          <option>Unique ID</option>
          <option>Mobile Number</option>
        </select></label>
        <div class="rk-v050-grid">
          <span class="rk-v050-hint">Locales to send</span>
          <div class="rk-v054-test-actions">
            <button class="rk-v050-secondary" type="button" data-current>Current</button>
            <button class="rk-v050-secondary" type="button" data-all>All</button>
            <button class="rk-v050-secondary" type="button" data-none>Clear</button>
          </div>
          <div class="rk-v054-test-locales" data-test-locales></div>
        </div>
        <label class="rk-v050-row"><input data-personalise type="checkbox"> <span>Personalise with a random user</span></label>
        <div class="rk-v050-hint">RetKit fills the native Test Campaign section and presses MoEngage's own Test button. Choose one locale, several locales, or all of them.</div>
        <div class="rk-v050-row"><button class="rk-v050-primary" data-send>Send test</button><button class="rk-v050-secondary" data-open-native>Show native Test Campaign</button></div>
      </div>`;

    pop.querySelector('[data-email]').value = prefs.email;
    pop.querySelector('[data-send-via]').value = prefs.sendVia;
    pop.querySelector('[data-personalise]').checked = prefs.personalise;
    const localeContainer = pop.querySelector('[data-test-locales]');
    renderTestLocaleChoices(localeContainer, orderedLocales, initialLocales);

    const setSelected = (locales) => renderTestLocaleChoices(localeContainer, orderedLocales, locales);
    pop.querySelector('[data-current]').addEventListener('click', () => setSelected(active ? [active] : []));
    pop.querySelector('[data-all]').addEventListener('click', () => setSelected(orderedLocales));
    pop.querySelector('[data-none]').addEventListener('click', () => setSelected([]));
    pop.querySelector('[data-close]').addEventListener('click', () => pop.remove());
    pop.querySelector('[data-open-native]').addEventListener('click', () => {
      const section = findTestCampaignSection();
      if (!section) { workspaceStatus('Native Test Campaign section not found', 'error'); return; }
      pop.remove();
      closeWorkspaceForNativeSection();
      section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    pop.querySelector('[data-send]').addEventListener('click', async () => {
      const locales = [...pop.querySelectorAll('input[data-test-locale]:checked')].map((input) => input.dataset.testLocale);
      const next = writeTestPreferences({
        email: pop.querySelector('[data-email]').value,
        locales,
        personalise: pop.querySelector('[data-personalise]').checked,
        sendVia: pop.querySelector('[data-send-via]').value,
      });
      workspaceStatus('Preparing native Test Campaign…', 'neutral');
      diagBreadcrumb('test.submit.start', { locales: next.locales, sendVia: next.sendVia });
      let result;
      try {
        result = await submitNativeTestCampaign(next);
      } catch (error) {
        const message = error?.message || String(error);
        diagIncident('test_campaign_failed', message, { locales: next.locales, sendVia: next.sendVia });
        workspaceStatus(`Test failed: ${message}`, 'error');
        return;
      }
      if (result.ok) {
        diagBreadcrumb('test.submit.requested', { locales: next.locales, sendVia: next.sendVia });
        workspaceStatus(`Test requested for ${next.email} · ${next.locales.join(', ')}`, 'ok');
        pop.remove();
      } else if (result.reason !== 'Cancelled') {
        diagIncident('test_campaign_failed', result.reason, { locales: next.locales, sendVia: next.sendVia, ...(result.meta || {}) });
        workspaceStatus(result.reason, 'error');
      }
    });
    document.body.appendChild(pop);
  }

  async function renderAddLocalePopover() {
    document.getElementById(IDS.addLocalePopover)?.remove();
    const pop = document.createElement('div');
    pop.id = IDS.addLocalePopover;
    pop.className = 'rk-v050-popover';
    pop.innerHTML = `<div class="rk-v050-head"><strong>Add locale from MoEngage</strong><button class="rk-v050-secondary" data-close>×</button></div><div class="rk-v050-grid"><div class="rk-v050-hint" data-locale-state>Reading locales offered by MoEngage…</div><div class="rk-v060-locale-list" data-locales></div><div class="rk-v050-row"><button class="rk-v050-primary" type="button" data-add disabled>Add selected</button></div></div>`;
    document.body.appendChild(pop);
    pop.querySelector('[data-close]')?.addEventListener('click', () => pop.remove());

    const stateEl = pop.querySelector('[data-locale-state]');
    const list = pop.querySelector('[data-locales]');
    const addButton = pop.querySelector('[data-add]');
    workspaceStatus('Reading locales available in MoEngage…', 'neutral');

    let locales;
    try {
      locales = await listNativeAddableLocales();
    } catch (error) {
      const message = error?.message || String(error);
      if (stateEl) stateEl.textContent = message;
      workspaceStatus(message, 'error');
      return;
    }
    if (!pop.isConnected) return;
    if (!locales.length) {
      if (stateEl) stateEl.textContent = 'No additional MoEngage locales are available.';
      workspaceStatus('No additional MoEngage locales are available', 'ok');
      return;
    }

    if (stateEl) stateEl.textContent = 'Only locales currently offered by MoEngage are shown.';
    for (const locale of locales) {
      const label = document.createElement('label');
      label.className = 'rk-v060-locale-choice';
      label.innerHTML = `<input type="checkbox" data-locale="${locale}"> <span>${localeUiLabel(locale)}</span>`;
      list.appendChild(label);
    }
    addButton.disabled = false;
    addButton.addEventListener('click', async () => {
      const selected = [...pop.querySelectorAll('input[data-locale]:checked')].map((input) => input.dataset.locale).filter(Boolean);
      if (!selected.length) { workspaceStatus('Select at least one locale', 'neutral'); return; }
      addButton.disabled = true;
      workspaceStatus(`Adding locale(s): ${selected.join(', ')}…`, 'neutral');
      try {
        const result = await addNativeLocales(selected);
        if (result.ok) {
          workspaceStatus(`Added MoEngage locale(s): ${result.added.join(', ') || result.alreadyPresent.join(', ')}`, 'ok');
          pop.remove();
          renderLocaleStrip(true);
        } else workspaceStatus(result.reason, result?.pending ? 'neutral' : 'error');
      } finally { if (addButton.isConnected) addButton.disabled = false; }
    });
    workspaceStatus(`MoEngage offers ${locales.length} additional locale(s)`, 'ok');
  }

  function closeWorkspaceForNativeSection() {
    const close = [...document.querySelectorAll(`#${IDS.workspace} .rk-topbar button`)].find((button) => textOf(button) === 'Close');
    close?.click();
  }

  function handOffNativeTestCampaign() {
    const workspace = document.getElementById(IDS.workspace);
    const section = findTestCampaignSection();
    if (!workspace || !section) {
      workspaceStatus('Native Test Campaign section not found', 'error');
      return { ok: false, reason: 'Native Test Campaign section not found' };
    }

    document.getElementById(IDS.testPopover)?.remove();
    document.getElementById(IDS.nativeLocaleAssist)?.remove();

    const banner = document.createElement('div');
    banner.id = IDS.nativeLocaleAssist;
    const text = document.createElement('span');
    text.textContent = 'Send the test manually in MoEngage. RetKit is hidden while you work in the native Test Campaign form.';
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Return to RetKit';
    banner.append(text, back);
    document.body.appendChild(banner);

    const previousVisibility = workspace.style.visibility;
    const previousOverflow = document.body.style.overflow;
    workspace.style.visibility = 'hidden';
    document.body.style.overflow = '';
    diagBreadcrumb('test.native-handoff.start', {});

    try {
      section.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      setTimeout(() => {
        try { root.scrollBy?.({ top: -48, left: 0, behavior: 'smooth' }); } catch {}
      }, 180);
    } catch {}

    const finish = () => {
      banner.remove();
      workspace.style.visibility = previousVisibility;
      document.body.style.overflow = previousOverflow || 'hidden';
      updateLocaleUi(false);
      syncSubjectFromMoEngage(true);
      diagBreadcrumb('test.native-handoff.return', {});
      workspaceStatus('Returned from native Test Campaign', 'ok');
    };

    back.addEventListener('click', finish, { once: true });
    return { ok: true, reason: '' };
  }

  function updateLocaleUi(forceDiscovery = false) {
    const multiLocaleBusy = Boolean(root.__RetKitMoEngageCore?.isMultiLocaleBusy?.());
    if (multiLocaleBusy) return;
    const locale = getActiveLocale();
    const rtlButton = document.getElementById(IDS.rtlButton);
    if (rtlButton) {
      const currentHtml = getOverlayEditor()?.getValue?.() || '';
      const localeKey = displayLocale(locale) || '__CURRENT__';
      const toggleState = rtlToggleStates.get(localeKey) || null;
      const activeToggle = Boolean(toggleState
        && rtlToggleDecision(toggleState.before, toggleState.after, currentHtml) === 'revert');
      rtlButton.classList.toggle('rk-active', activeToggle);
    }
    renderLocaleStrip(forceDiscovery);
  }

  function ensureBridgeToolbar() {
    const workspace = document.getElementById(IDS.workspace);
    const bar = workspace?.querySelector('.rk-topbar');
    if (!bar) return;
    pruneLegacyToolbarButtons();
    injectBridgeStyle();

    const statusEl = document.getElementById(IDS.status);
    if (!document.getElementById(IDS.rtlButton)) {
      const button = makeToolbarButton(IDS.rtlButton, 'RTL Fix', applyRtlFix, 'Toggle RTL on the currently open locale; click again to restore it');
      bar.insertBefore(button, statusEl || bar.querySelector('.rk-spacer'));
    }
    if (!document.getElementById(IDS.originalButton)) {
      const button = makeToolbarButton(IDS.originalButton, '↶ Original', renderOriginalPopover, 'Return to the version this email had before RetKit first changed it');
      button.style.display = 'none';
      bar.insertBefore(button, statusEl || bar.querySelector('.rk-spacer'));
      refreshOriginalButton(true);
    }
    if (!document.getElementById(IDS.testButton)) {
      const button = makeToolbarButton(IDS.testButton, 'Send test', handOffNativeTestCampaign, 'Open the native MoEngage Test Campaign form');
      bar.insertBefore(button, statusEl || bar.querySelector('.rk-spacer'));
    }

    let row = document.getElementById(IDS.localeRow);
    if (!row) {
      row = document.createElement('div');
      row.id = IDS.localeRow;
      const label = document.createElement('span');
      label.className = 'rk-v053-locale-label';
      label.textContent = 'Locales';
      const strip = document.createElement('div');
      strip.id = IDS.localeStrip;
      strip.setAttribute('aria-label', 'MoEngage locales');
      const backupLocales = document.createElement('button');
      backupLocales.type = 'button';
      backupLocales.id = IDS.backupLocalesButton;
      backupLocales.textContent = 'Backup ZIP';
      backupLocales.title = 'Download all locale HTML as a ZIP backup';
      backupLocales.addEventListener('click', downloadLocaleBackup);
      const addLocale = document.createElement('button');
      addLocale.type = 'button';
      addLocale.id = IDS.addLocaleButton;
      addLocale.textContent = '+ Locale';
      addLocale.title = 'Add a locale offered by MoEngage';
      addLocale.addEventListener('click', renderAddLocalePopover);
      row.append(label, strip, backupLocales, addLocale);
      bar.insertAdjacentElement('afterend', row);
      updateLocaleUi(true);
    } else {
      if (!document.getElementById(IDS.backupLocalesButton)) {
        const backupLocales = document.createElement('button');
        backupLocales.type = 'button';
        backupLocales.id = IDS.backupLocalesButton;
        backupLocales.textContent = 'Backup ZIP';
      backupLocales.title = 'Download all locale HTML as a ZIP backup';
        backupLocales.addEventListener('click', downloadLocaleBackup);
        const addLocaleExisting = document.getElementById(IDS.addLocaleButton);
        if (addLocaleExisting) row.insertBefore(backupLocales, addLocaleExisting);
        else row.appendChild(backupLocales);
      }
      if (!document.getElementById(IDS.addLocaleButton)) {
        const addLocale = document.createElement('button');
        addLocale.type = 'button';
        addLocale.id = IDS.addLocaleButton;
        addLocale.textContent = '+ Locale';
        addLocale.title = 'Add a locale offered by MoEngage';
        addLocale.addEventListener('click', renderAddLocalePopover);
        row.appendChild(addLocale);
      }
      updateLocaleUi(false);
    }

    let subjectRow = document.getElementById(IDS.subjectRow);
    if (!subjectRow) {
      subjectRow = document.createElement('div');
      subjectRow.id = IDS.subjectRow;
      const label = document.createElement('span');
      label.className = 'rk-v053-locale-label';
      label.textContent = 'Subject';
      const input = document.createElement('input');
      input.id = IDS.subjectInput;
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = 'MoEngage subject';
      input.addEventListener('input', () => {
        clearTimeout(subjectTimer);
        subjectTimer = setTimeout(() => commitSubjectToMoEngage(input.value), 260);
      });
      input.addEventListener('change', () => commitSubjectToMoEngage(input.value));
      subjectRow.append(label, input);
      row.insertAdjacentElement('afterend', subjectRow);
      syncSubjectFromMoEngage(true);
    } else {
      syncSubjectFromMoEngage(false);
    }
  }

  async function setNativeLocaleHtmlFast(locale, html, options = {}) {
    const wanted = displayLocale(locale);
    if (!wanted) return { ok: false, locale: wanted, reason: 'Locale is empty' };
    const switched = await switchNativeLocale(wanted, { rebind: false, preferNative: true, timeoutMs: 2400 });
    if (!switched?.ok) return { ok: false, locale: wanted, reason: switched?.reason || `Could not switch to ${wanted}` };
    const native = getNativeEditorOutsideWorkspace();
    if (!native) return { ok: false, locale: wanted, reason: `Native editor for ${wanted} was not found` };
    const before = String(native.getValue?.() || '');
    if (Object.prototype.hasOwnProperty.call(options, 'expectedBefore') && before !== String(options.expectedBefore ?? '')) {
      return { ok: false, locale: wanted, reason: `${wanted}: content changed since scan` };
    }
    const commit = root.__RetKitMoEngageCore?.commitNativeHtml;
    if (typeof commit !== 'function') return { ok: false, locale: wanted, reason: 'Native commit helper is unavailable' };
    const next = String(html ?? '');
    const result = await Promise.resolve(commit(next, { fast: true, locale: wanted }));
    return { ok: Boolean(result?.ok), locale: wanted, tentative: true, reason: result?.reason || '' };
  }

  async function setNativeLocaleHtmlStable(locale, html, options = {}) {
    const wanted = displayLocale(locale);
    if (!wanted) return { ok: false, locale: wanted, reason: 'Locale is empty' };
    const switched = await switchNativeLocale(wanted, { rebind: false, preferNative: true, timeoutMs: 2400 });
    if (!switched?.ok) return { ok: false, locale: wanted, reason: switched?.reason || `Could not switch to ${wanted}` };
    const native = getNativeEditorOutsideWorkspace();
    if (!native) return { ok: false, locale: wanted, reason: `Native editor for ${wanted} was not found` };
    const commit = root.__RetKitMoEngageCore?.commitNativeHtml;
    if (typeof commit !== 'function') return { ok: false, locale: wanted, reason: 'Native commit helper is unavailable' };
    const next = String(html ?? '');
    // commitThroughFroala(fast:false) already performs two persistence checks
    // after the React/Froala render cycle. Do not pay a second fixed 700ms
    // settle delay here for every locale.
    const result = await Promise.resolve(commit(next, { fast: false, locale: wanted }));
    const actual = String(getNativeEditorOutsideWorkspace()?.getValue?.() || '');
    const equivalent = root.__RetKitMoEngageCore?.htmlEquivalentForSync;
    const persisted = Boolean(result?.ok) && (typeof equivalent === 'function' ? equivalent(actual, next) : actual === next);
    return {
      ok: persisted,
      locale: wanted,
      persisted,
      reason: persisted ? '' : (result?.reason || `${wanted}: MoEngage reverted the HTML after the stable commit`),
    };
  }

  async function verifyNativeLocaleHtmlFast(locale, expectedHtml) {
    const wanted = displayLocale(locale);
    if (!wanted) return { ok: false, locale: wanted, reason: 'Locale is empty' };
    try {
      const actual = String(await readNativeLocaleHtmlFast(wanted));
      const expected = String(expectedHtml ?? '');
      return { ok: actual === expected, locale: wanted, reason: actual === expected ? '' : `${wanted}: persisted HTML differs after React settled` };
    } catch (error) {
      return { ok: false, locale: wanted, reason: error?.message || String(error) };
    }
  }

  async function setNativeLocaleHtml(locale, html, options = {}) {
    const wanted = displayLocale(locale);
    const original = getActiveLocale();
    if (!wanted) return { ok: false, locale: wanted, reason: 'Locale is empty' };
    if (!root.__RetKitAiWorkspaceApi?.setHtml) return { ok: false, locale: wanted, reason: 'RetKit editor writer is unavailable' };
    if (original !== wanted) {
      const switched = await switchNativeLocale(wanted);
      if (!switched?.ok) return { ok: false, locale: wanted, reason: switched?.reason || `Could not switch to ${wanted}` };
    }
    const next = String(html ?? '');
    const applied = await Promise.resolve(root.__RetKitAiWorkspaceApi.setHtml(next));
    const kept = String(getOverlayEditor()?.getValue?.() || '') === next;
    const ok = Boolean(applied && kept);
    if (!ok) diagIncident('locale_html_write_failed', `MoEngage did not keep HTML for ${wanted}`, { locale: wanted, html: next });
    if (options.restore !== false && original && original !== wanted) await switchNativeLocale(original);
    return { ok, locale: wanted, reason: ok ? '' : `MoEngage did not keep HTML for ${wanted}` };
  }

  root.__RetKitMoEngageBridgeApi = {
    getActiveLocale,
    listLocales: async () => { await discoverNativeLocalesDeep(); return discoverNativeLocales(); },
    listAvailableLocales: () => listNativeAddableLocales(),
    addLocales: (locales) => addNativeLocales(locales),
    removeLocale: (locale) => removeNativeLocale(locale),
    switchLocale: (locale, options) => switchNativeLocale(locale, options || {}).then((result) => Boolean(result?.ok)),
    readLocaleHtmlFast: (locale) => readNativeLocaleHtmlFast(locale),
    setLocaleHtml: (locale, html, options) => setNativeLocaleHtml(locale, html, options),
    setLocaleHtmlFast: (locale, html, options) => setNativeLocaleHtmlFast(locale, html, options),
    setLocaleHtmlStable: (locale, html, options) => setNativeLocaleHtmlStable(locale, html, options),
    verifyLocaleHtmlFast: (locale, html) => verifyNativeLocaleHtmlFast(locale, html),
    refreshUi: () => { updateLocaleUi(true); syncSubjectFromMoEngage(true); },
    getSubject: () => {
      const native = findNativeSubjectInput();
      return native ? readNativeValue(native) : (document.getElementById(IDS.subjectInput)?.value || '');
    },
    setSubject: (value) => commitSubjectToMoEngage(value),
    getLocaleHtml: async (locale) => {
      const wanted = displayLocale(locale);
      const original = getActiveLocale();
      if (!wanted) return '';
      if (original !== wanted) {
        const switched = await switchNativeLocale(wanted);
        if (!switched?.ok) throw new Error(switched?.reason || `Could not switch to ${wanted}`);
      }
      const html = getOverlayEditor()?.getValue?.() || '';
      if (original && original !== wanted) await switchNativeLocale(original);
      return html;
    },
  };

  // ─── Original version (first-touch backup) ────────────────────────────────
  // The core captures the HTML right before RetKit's first write per campaign +
  // locale. This button appears only when such a snapshot exists and lets the
  // user return to it. Snapshots expire on their own (see original-snapshots.js).
  function originalsApi() {
    return root.__RetKitOriginals || null;
  }

  function currentOriginalContext() {
    const api = originalsApi();
    if (!api) return null;
    return { campaign: api.campaignKeyFromUrl(root.location?.href || ''), locale: getActiveLocale() || 'default' };
  }

  let originalRefreshTick = 0;
  let originalButtonKey = '';
  async function refreshOriginalButton(force = false) {
    const button = document.getElementById(IDS.originalButton);
    const api = originalsApi();
    if (!button || !api?.store) return;
    originalRefreshTick += 1;
    if (!force && originalRefreshTick % 3 !== 0) return;
    const context = currentOriginalContext();
    if (!context) return;
    const key = api.snapshotKey(context.campaign, context.locale);
    try {
      const entry = await api.store.get(context.campaign, context.locale);
      button.style.display = entry ? '' : 'none';
      originalButtonKey = entry ? key : '';
      if (entry) button.title = `Original ${context.locale} from ${formatOriginalTime(entry.capturedAt)} — click to compare or restore`;
    } catch {
      button.style.display = 'none';
    }
  }

  function formatOriginalTime(ms) {
    try {
      return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch {
      return String(new Date(ms));
    }
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    return value >= 1024 ? `${Math.round(value / 1024)} KB` : `${value} B`;
  }

  async function renderOriginalPopover() {
    const existing = document.getElementById(IDS.originalPopover);
    if (existing) { existing.remove(); return; }
    closeBridgePopovers(IDS.originalPopover);
    const api = originalsApi();
    const context = currentOriginalContext();
    if (!api?.store || !context) return;
    const entry = await api.store.get(context.campaign, context.locale);
    if (!entry) { refreshOriginalButton(true); return; }

    const editor = getOverlayEditor();
    const core = root.__RetKitMoEngageCore;
    const current = editor?.getValue?.() || '';
    const same = Boolean(core?.htmlEquivalentForSync?.(current, entry.html));

    const pop = document.createElement('div');
    pop.id = IDS.originalPopover;
    pop.className = 'rk-v050-popover';
    const head = document.createElement('div');
    head.className = 'rk-v050-head';
    const title = document.createElement('strong');
    title.textContent = `Original · ${entry.locale}`;
    const close = document.createElement('button');
    close.className = 'rk-v050-secondary';
    close.textContent = '×';
    close.addEventListener('click', () => pop.remove());
    head.append(title, close);

    const grid = document.createElement('div');
    grid.className = 'rk-v050-grid';
    const info = document.createElement('div');
    info.className = 'rk-v050-hint';
    info.textContent = `Saved ${formatOriginalTime(entry.capturedAt)} before RetKit's first change · ${formatBytes(entry.bytes)}. `
      + (same ? 'The email is currently identical to it.' : 'The email has changed since then.')
      + ' Kept in this browser only; removed automatically after 14 days without use.';

    const row = document.createElement('div');
    row.className = 'rk-v050-row';
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'rk-v050-primary';
    restore.textContent = 'Restore original';
    restore.disabled = same || !editor;
    restore.addEventListener('click', () => {
      if (restore.dataset.armed !== '1') {
        restore.dataset.armed = '1';
        restore.textContent = 'Click again to restore';
        setTimeout(() => {
          if (!restore.isConnected) return;
          restore.dataset.armed = '';
          restore.textContent = 'Restore original';
        }, 4000);
        return;
      }
      api.pendingExactRestore = { html: entry.html, at: Date.now() };
      const text = core?.beautifyEmailHtml ? core.beautifyEmailHtml(entry.html) : entry.html;
      const last = editor.lastLine();
      // An undoable edit: Cmd/Ctrl+Z in the editor brings the newer version back.
      editor.replaceRange(text, { line: editor.firstLine?.() ?? 0, ch: 0 }, { line: last, ch: (editor.getLine(last) || '').length }, '+retkit-restore-original');
      diagBreadcrumb?.('original.restore', { locale: entry.locale, bytes: entry.bytes });
      workspaceStatus(`Restoring original ${entry.locale}… (Cmd/Ctrl+Z undoes it)`, 'neutral');
      pop.remove();
    });
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'rk-v050-secondary';
    copy.textContent = 'Copy original HTML';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(entry.html); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy failed'; }
    });
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'rk-v050-secondary';
    discard.textContent = 'Forget';
    discard.title = 'Delete this saved original now';
    discard.addEventListener('click', async () => {
      await api.store.discard(context.campaign, context.locale);
      pop.remove();
      refreshOriginalButton(true);
      workspaceStatus(`Saved original ${entry.locale} removed`, 'neutral');
    });
    row.append(restore, copy, discard);
    grid.append(info, row);
    pop.append(head, grid);
    document.body.appendChild(pop);
  }

  function bootOriginals() {
    const api = originalsApi();
    if (!api || api.store) return;
    try {
      api.store = api.createStore({ version: '0.8.1' }); // version: scripts/version-files.mjs
      api.contextProvider = currentOriginalContext;
      api.onChange = () => refreshOriginalButton(true);
      api.store.prune().catch(() => {});
    } catch {}
  }

  function bootBridge() {
    bootOriginals();
    injectBridgeStyle();
    ensureBridgeToolbar();

    // Do not observe the entire MoEngage document. Locale discovery scans a
    // large React tree and a global MutationObserver can create an expensive
    // feedback loop during editor/preview remounts. A light heartbeat only
    // ensures the bridge UI exists; locale discovery itself is cached.
    localeTimer = setInterval(() => {
      if (document.hidden) return;
      if (document.getElementById(IDS.workspace)) { ensureBridgeToolbar(); syncSubjectFromMoEngage(false); refreshOriginalButton(false); }
      else closeBridgePopovers();
    }, 1200);

    root.addEventListener?.('beforeunload', () => {
      if (localeTimer) clearInterval(localeTimer);
      if (subjectTimer) clearTimeout(subjectTimer);
    });
    console.log('[RetKit] MoEngage bridge v0.8.1 loaded');
  }

  bootBridge();
})(typeof globalThis !== 'undefined' ? globalThis : this);
