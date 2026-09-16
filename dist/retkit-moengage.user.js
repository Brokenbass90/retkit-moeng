// ==UserScript==
// @name         RetKit for MoEngage
// @namespace    https://github.com/Brokenbass90/retkit-moengage
// @version      0.4.2
// @description  Fullscreen email coding workspace for MoEngage with live preview and click-to-source navigation.
// @match        https://dashboard-02.moengage.com/*
// @updateURL    https://raw.githubusercontent.com/Brokenbass90/retkit-moengage/main/dist/retkit-moengage.user.js
// @downloadURL  https://raw.githubusercontent.com/Brokenbass90/retkit-moengage/main/dist/retkit-moengage.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function (root) {
  'use strict';

  const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    for (const candidate of [...new Set(candidates)]) {
      const index = findOccurrenceIndex(source, candidate, occurrence);
      if (index !== -1) return { start: index, end: index + candidate.length };
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
      const expected = String(descriptor.pointText).replace(/\s+/g, ' ').trim();
      const actual = direct.value.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
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
      const exactPointRange = Number.isInteger(descriptor.pointTextGlobalOccurrence) && descriptor.pointTextGlobalOccurrence >= 0
        ? findTextOccurrenceRange(source, rawPointText, descriptor.pointTextGlobalOccurrence)
        : null;

      // In mixed copy (<p>plain <b>bold</b> plain</p>) a click on the plain
      // paragraph text should select the paragraph content including inline
      // markup. A click inside the <b>/<strong> remains an exact text click.
      const pointParentTag = String(descriptor.pointParentTag || '').toLowerCase();
      if (descriptor.pointParentHasElementChildren === true && pointParentTag === 'p') {
        const pointRange = exactPointRange
          || findTextOccurrenceRange(source, rawPointText, 0)
          || findTextNodeRangeInElement(source, descriptor);
        if (pointRange) {
          const parentRange = findEnclosingElementContentRangeAtIndex(source, pointRange.start, pointParentTag);
          if (parentRange) return { kind: 'mixedParent', ...parentRange };
        }
      }

      if (exactPointRange) return { kind: 'pointText', ...exactPointRange };

      // If the visible text is unique in source, it is safer than tag order.
      const first = findTextOccurrenceRange(source, rawPointText, 0);
      const second = findTextOccurrenceRange(source, rawPointText, 1);
      if (first && !second) return { kind: 'pointText', ...first };

      const constrained = findTextNodeRangeInElement(source, descriptor);
      if (constrained) return { kind: 'pointText', ...constrained };

      const fallback = findTextOccurrenceRange(source, rawPointText, 0);
      if (fallback) return { kind: 'pointText', ...fallback };
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


  function snapshotStorageKey(identity) {
    return `retkit-mo-snapshots:${String(identity || 'unknown')}`;
  }

  function normalizeSnapshots(list, limit = 10) {
    const cap = Math.max(1, Number(limit) || 10);
    return [...(Array.isArray(list) ? list : [])]
      .filter((item) => item && typeof item.html === 'string')
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, cap);
  }

  function readSnapshots(storage, identity) {
    try {
      const raw = storage?.getItem?.(snapshotStorageKey(identity));
      return normalizeSnapshots(raw ? JSON.parse(raw) : [], 10);
    } catch {
      return [];
    }
  }

  function saveSnapshot(storage, identity, html, reason = 'manual', now = Date.now()) {
    const current = readSnapshots(storage, identity);
    const stamp = Number(now) || Date.now();
    const snapshot = {
      id: `${stamp}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: stamp,
      label: new Date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      html: String(html || ''),
      reason: String(reason || 'manual'),
    };
    const next = normalizeSnapshots([snapshot, ...current], 10);
    storage?.setItem?.(snapshotStorageKey(identity), JSON.stringify(next));
    return next;
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

    const stack = [];
    const tagRe = /<\/?\s*([a-zA-Z][\w:-]*)\b[^>]*>/g;
    let match;
    while ((match = tagRe.exec(scan))) {
      const raw = input.slice(match.index, match.index + match[0].length);
      if (/\{[{%]/.test(raw)) continue;
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
          if (!srcMatch || !srcMatch[2].trim()) add('error', 'img-src', '<img> is missing src', match.index);
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
    findAllLiteral,
    replaceAllLiteral,
    snapshotStorageKey,
    normalizeSnapshots,
    readSnapshots,
    saveSnapshot,
    validateEmailHtml,
    findFoldRangeForLine,
    refreshEditorLayout,
    isAllowedHost,
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
    matchCount: 'retkit-mo-match-count',
    status: 'retkit-mo-status',
    split: 'retkit-mo-split',
    editorPane: 'retkit-mo-editor-pane',
    previewPane: 'retkit-mo-preview-pane',
    previewCanvas: 'retkit-mo-preview-canvas',
    historyPopover: 'retkit-mo-history-popover',
    validatorPopover: 'retkit-mo-validator-popover',
    validatorButton: 'retkit-mo-validator-button',
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
    awaitingRenderedUpdate: false,
    renderedBeforeEdit: '',
    localPreviewUntil: 0,
    nativeChangeHandler: null,
    observer: null,
    pollTimer: null,
    syncTimer: null,
    foldTimer: null,
    validatorTimer: null,
    validatorIssues: [],
    layoutRefreshTimer: null,
    overlayEditor: null,
    nativeEditor: null,
    dirty: false,
    applying: false,
    pendingApply: false,
    searchMarks: [],
    foldMarks: new Map(),
  };

  function getNativeEditor() {
    const cm = document.querySelector('.CodeMirror')?.CodeMirror;
    return cm || null;
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

  async function commitThroughFroala(next) {
    let native = STATE.nativeEditor || getNativeEditor();
    const button = getCodeViewButton();
    if (!native || !button) return { ok: false, reason: 'Froala Code View button not found' };

    // We intentionally use the same path a human edit takes: update CodeMirror,
    // wake its textarea, leave Code View, fire a visual-editor input, then return.
    native.focus?.();
    writeNativeEditorValue(native, next);
    native.save?.();
    native.refresh?.();
    dispatchEditorInput(native.getInputField?.() || document.querySelector('.CodeMirror textarea'));

    try {
      if (isCodeViewActive(button)) {
        button.click();
        await sleep(260);
      }

      const visualTarget = getFroalaVisualTarget();
      if (visualTarget) {
        visualTarget.focus?.();
        dispatchEditorInput(visualTarget);
        await sleep(90);
        visualTarget.blur?.();
      }
      dispatchEditorInput(getFroalaBox());
      await sleep(160);

      if (!isCodeViewActive(button)) {
        button.click();
        await sleep(360);
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
    await sleep(700);
    const keptOnce = (getNativeEditor() || native).getValue?.() === next;
    await sleep(500);
    const keptTwice = (getNativeEditor() || native).getValue?.() === next;
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
      .rk-history-row, .rk-issue-row { width:100%; text-align:left; border:0; border-bottom:1px solid #202b39; background:transparent; color:#dce6f4;
        padding:9px 8px; cursor:pointer; font:12px/1.35 inherit; display:flex; align-items:center; gap:8px; }
      .rk-history-row:hover, .rk-issue-row:hover { background:#182334; }
      .rk-history-meta { color:#7f91a7; font-size:11px; margin-left:auto; }
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
    const result = replaceAllLiteral(editor.getValue(), query, replace?.value || '');
    if (!result.count) {
      status(`Not found: ${query}`, 'warn');
      return;
    }
    const cursor = editor.getCursor();
    editor.operation(() => editor.setValue(result.value));
    editor.setCursor(cursor);
    updateSearchHighlights(query, -1);
    status(`Replaced ${result.count} occurrence${result.count === 1 ? '' : 's'}`, 'ok');
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

    find.addEventListener('input', () => updateSearchHighlights(find.value, -1));
    find.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        findNext(find.value, event.shiftKey ? -1 : 1);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeFindBar();
      }
    });
    replace.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        replaceCurrent();
      }
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
    for (const id of [IDS.historyPopover, IDS.validatorPopover]) {
      if (id !== exceptId) document.getElementById(id)?.remove();
    }
  }

  function manualSaveSnapshot() {
    const html = STATE.overlayEditor?.getValue() || '';
    if (!html) return;
    saveSnapshot(localStorage, getEmailIdentity(), html, 'manual');
    status('Snapshot saved', 'ok');
    renderHistoryPopover(true);
  }

  async function restoreSnapshot(snapshot) {
    const editor = STATE.overlayEditor;
    if (!editor || !snapshot?.html) return;
    saveSnapshot(localStorage, getEmailIdentity(), editor.getValue(), 'before-restore');
    STATE.syncingFromNative = true;
    try {
      editor.setValue(snapshot.html);
      editor.setCursor({ line: 0, ch: 0 });
      STATE.dirty = true;
      applyPreviewHtml(snapshot.html, true);
      scheduleFoldRefresh();
    } finally {
      STATE.syncingFromNative = false;
    }
    closeFloatingPopovers();
    status(`Restoring snapshot ${snapshot.label || ''}…`, 'neutral');
    await pushOverlayToNative(true);
  }

  function renderHistoryPopover(forceOpen = false) {
    const existing = document.getElementById(IDS.historyPopover);
    if (existing && !forceOpen) {
      existing.remove();
      return;
    }
    existing?.remove();
    closeFloatingPopovers(IDS.historyPopover);
    const pop = document.createElement('div');
    pop.id = IDS.historyPopover;
    pop.className = 'rk-popover';
    const head = document.createElement('div');
    head.className = 'rk-popover-head';
    head.innerHTML = '<strong>History</strong><span class="rk-history-meta">last 10 local states</span>';
    const close = makeButton('×', () => pop.remove());
    head.appendChild(close);
    pop.appendChild(head);
    const snapshots = readSnapshots(localStorage, getEmailIdentity());
    if (!snapshots.length) {
      const empty = document.createElement('div');
      empty.className = 'rk-empty';
      empty.textContent = 'No snapshots for this email yet.';
      pop.appendChild(empty);
    } else {
      for (const item of snapshots) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'rk-history-row';
        const reason = item.reason === 'before-restore' ? 'Before restore' : 'Manual';
        row.innerHTML = `<span>${item.label || new Date(item.createdAt).toLocaleTimeString()}</span><span class="rk-history-meta">${reason}</span>`;
        row.title = 'Restore this snapshot';
        row.addEventListener('click', () => restoreSnapshot(item));
        pop.appendChild(row);
      }
    }
    document.body.appendChild(pop);
  }

  function updateValidatorStatus() {
    const html = STATE.overlayEditor?.getValue() || '';
    STATE.validatorIssues = validateEmailHtml(html);
    const button = document.getElementById(IDS.validatorButton);
    if (!button) return;
    if (!STATE.validatorIssues.length) {
      button.textContent = '✓ HTML';
      button.classList.add('rk-validator-ok');
      button.classList.remove('rk-validator-warn');
      button.title = 'No structural HTML issues detected';
    } else {
      button.textContent = `⚠ ${STATE.validatorIssues.length} issue${STATE.validatorIssues.length === 1 ? '' : 's'}`;
      button.classList.remove('rk-validator-ok');
      button.classList.add('rk-validator-warn');
      button.title = 'Open HTML validation issues';
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
    brand.innerHTML = '<span class="rk-mark">RK</span><span>RetKit × MoEngage</span><span class="rk-version">v0.4.2</span>';

    const wrapBtn = makeButton('Wrap', () => {
      STATE.wrap = !STATE.wrap;
      localStorage.setItem('retkit-mo-wrap', String(STATE.wrap));
      STATE.overlayEditor?.setOption('lineWrapping', STATE.wrap);
      wrapBtn.classList.toggle('rk-active', STATE.wrap);
    }, { active: STATE.wrap });

    const saveBtn = makeButton('Save', manualSaveSnapshot, { title: 'Save a local snapshot of this email' });
    const historyBtn = makeButton('History ▾', () => renderHistoryPopover(false), { title: 'Restore one of the last 10 local states' });
    const validatorBtn = makeButton('✓ HTML', () => renderValidatorPopover(false), { title: 'HTML validation' });
    validatorBtn.id = IDS.validatorButton;
    validatorBtn.classList.add('rk-validator-ok');

    const applyBtn = makeButton('Apply now', () => {
      pushOverlayToNative(true);
    }, { title: 'Retry committing the current RetKit HTML into MoEngage' });

    const copyBtn = makeButton('Copy HTML', async () => {
      const value = STATE.overlayEditor?.getValue() || '';
      try {
        await navigator.clipboard.writeText(value);
        status('HTML copied', 'ok');
      } catch {
        status('Clipboard permission denied', 'error');
      }
    });

    const closeBtn = makeButton('Close', closeWorkspace);

    const statusEl = document.createElement('div');
    statusEl.id = IDS.status;
    statusEl.textContent = 'Auto apply enabled';

    const spacer = document.createElement('div');
    spacer.className = 'rk-spacer';

    bar.append(brand, wrapBtn, saveBtn, historyBtn, validatorBtn, applyBtn, copyBtn, statusEl, spacer, closeBtn);
    workspace.appendChild(bar);
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
    if (!doc) return;
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

  function applyPreviewHtml(html, force = false) {
    const frame = document.getElementById(IDS.previewFrame);
    if (!frame || !html) return;
    if (!force && html === STATE.previewHtml) return;
    STATE.previewHtml = html;
    frame.onload = () => {
      bindPreviewClickNavigation(frame);
      schedulePreviewResize(frame);
    };
    frame.srcdoc = html;
  }

  function refreshPreviewFromMoEngage(force = false) {
    const html = getRenderedPreviewHtml();
    if (!html) return;

    if (!force && STATE.awaitingRenderedUpdate) {
      const accept = shouldAcceptRenderedPreview({
        awaiting: true,
        renderedBeforeEdit: STATE.renderedBeforeEdit,
        localPreviewUntil: STATE.localPreviewUntil,
      }, html);
      if (!accept) return;
      STATE.awaitingRenderedUpdate = false;
    }

    applyPreviewHtml(html, force);
  }

  async function pushOverlayToNative(force = false) {
    if ((!force && STATE.syncPaused) || STATE.syncingFromNative) return;
    const overlay = STATE.overlayEditor;
    const native = STATE.nativeEditor;
    if (!overlay || !native) return;

    if (STATE.applying) {
      STATE.pendingApply = true;
      return;
    }

    const next = overlay.getValue();
    if (next === native.getValue() && !STATE.dirty) {
      status('Already in sync', 'ok');
      return;
    }

    STATE.applying = true;
    STATE.syncingToNative = true;
    const beforeRendered = getRenderedPreviewHtml();
    STATE.renderedBeforeEdit = beforeRendered;
    STATE.awaitingRenderedUpdate = true;
    STATE.localPreviewUntil = Date.now() + 1400;
    status('Applying through MoEngage…', 'neutral');

    try {
      const result = await commitThroughFroala(next);
      if (!result.ok) {
        status(result.reason || 'MoEngage rejected the edit', 'error');
        return;
      }

      STATE.dirty = false;
      status('Applied to MoEngage', 'ok');

      for (const delay of [250, 700, 1400]) {
        setTimeout(() => refreshPreviewFromMoEngage(false), delay);
      }
    } catch (error) {
      console.error('[RetKit] apply failed', error);
      status(`Apply failed: ${error?.message || error}`, 'error');
    } finally {
      STATE.syncingToNative = false;
      STATE.applying = false;
      if (STATE.pendingApply) {
        STATE.pendingApply = false;
        setTimeout(() => pushOverlayToNative(false), 30);
      }
    }
  }

  function pullNativeToOverlay() {
    if (STATE.syncingToNative) return;
    const overlay = STATE.overlayEditor;
    const native = STATE.nativeEditor;
    if (!overlay || !native) return;
    const next = beautifyEmailHtml(native.getValue());
    if (next === overlay.getValue()) return;
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

    overlay.on('change', (_cm, change) => {
      if (STATE.syncingFromNative) return;
      clearTimeout(STATE.syncTimer);
      STATE.dirty = true;
      scheduleFoldRefresh();
      scheduleValidation();

      const findValue = document.getElementById(IDS.findInput)?.value || '';
      if (findValue) updateSearchHighlights(findValue, -1);

      STATE.renderedBeforeEdit = getRenderedPreviewHtml();
      STATE.awaitingRenderedUpdate = true;
      STATE.localPreviewUntil = Date.now() + 1400;
      applyPreviewHtml(overlay.getValue(), true);

      if (change?.origin === 'setValue' && !STATE.dirty) return;
      STATE.syncTimer = setTimeout(() => pushOverlayToNative(false), 300);
    });

    STATE.nativeChangeHandler = () => {
      if (STATE.syncingToNative) return;
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
    shell.appendChild(frame);
    canvas.appendChild(shell);
    previewPane.appendChild(canvas);
    updatePreviewModeButtons();

    split.append(editorPane, grip, previewPane);
    workspace.appendChild(split);

    STATE.overlayEditor = createOverlayEditor(sourceHost, STATE.nativeEditor.getValue());
    attachEditorSync();
    refreshPreviewFromMoEngage(true);

    STATE.pollTimer = setInterval(() => {
      if (!document.getElementById(IDS.workspace)) return;
      refreshPreviewFromMoEngage(false);
    }, 500);
  }

  function openWorkspace() {
    if (document.getElementById(IDS.workspace)) return;
    const native = getNativeEditor();
    const rendered = getRenderedPreviewHtml();
    if (!native) {
      alert('RetKit: MoEngage CodeMirror editor was not found.');
      return;
    }
    if (!rendered) {
      alert('RetKit: MoEngage preview is not ready yet. Open the template preview first and try again.');
      return;
    }

    STATE.nativeEditor = native;
    STATE.previewHtml = '';
    STATE.syncPaused = false;
    STATE.dirty = false;
    STATE.applying = false;
    STATE.pendingApply = false;
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
    if (STATE.layoutRefreshTimer) clearTimeout(STATE.layoutRefreshTimer);
    if (STATE.nativeEditor && STATE.nativeChangeHandler) {
      try { STATE.nativeEditor.off?.('change', STATE.nativeChangeHandler); } catch {}
    }
    STATE.pollTimer = null;
    STATE.syncTimer = null;
    STATE.foldTimer = null;
    STATE.validatorTimer = null;
    STATE.layoutRefreshTimer = null;
    clearSearchMarks();
    clearFoldMarks();
    closeFloatingPopovers();
    STATE.nativeChangeHandler = null;
    STATE.overlayEditor = null;
    STATE.previewElement = null;
    document.getElementById(IDS.workspace)?.remove();
    document.body.style.overflow = '';
    STATE.nativeEditor?.refresh?.();
    STATE.nativeEditor = null;
  }

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
    ensureLauncher();
    STATE.observer = new MutationObserver(() => ensureLauncher());
    STATE.observer.observe(document.documentElement, { childList: true, subtree: true });
    console.log('[RetKit] MoEngage workspace v0.4.2 loaded');
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
