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
