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
  function apply({ code = '', namespaces = [], find = '', replacement = '', mode = 'text', selection = {} } = {}) {
    const out = { code, codeCount: 0, patches: [], undo: { code, locales: [] }, total: 0 };
    if (selection.code) {
      const r = replaceIn(code, find, replacement, { mode });
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
        const after = before.map((block) => {
          const r = replaceIn(block, find, replacement, { mode });
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
