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
