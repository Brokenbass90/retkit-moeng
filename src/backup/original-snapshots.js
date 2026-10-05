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
