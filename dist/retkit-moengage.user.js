// ==UserScript==
// @name         RetKit for MoEngage
// @namespace    https://github.com/Brokenbass90/retkit-moeng
// @version      0.5.9
// @description  RetKit workspace with native MoEngage locale tabs, RTL and Test Campaign bridge.
// @match        https://dashboard-02.moengage.com/*
// @updateURL    https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/dist/retkit-moengage.user.js
// @downloadURL  https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/dist/retkit-moengage.user.js
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
    rebindNativeEditorFromMoEngage,
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
    brand.innerHTML = '<span class="rk-mark">RK</span><span>RetKit × MoEngage</span><span class="rk-version">v0.5.4</span>';

    const wrapBtn = makeButton('Wrap', () => {
      STATE.wrap = !STATE.wrap;
      localStorage.setItem('retkit-mo-wrap', String(STATE.wrap));
      STATE.overlayEditor?.setOption('lineWrapping', STATE.wrap);
      wrapBtn.classList.toggle('rk-active', STATE.wrap);
    }, { active: STATE.wrap });

    const historyBtn = makeButton('History ▾', () => renderHistoryPopover(false), { title: 'Restore one of the last 10 local states' });
    const validatorBtn = makeButton('✓ HTML', () => renderValidatorPopover(false), { title: 'HTML validation' });
    validatorBtn.id = IDS.validatorButton;
    validatorBtn.classList.add('rk-validator-ok');


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

    bar.append(brand, wrapBtn, historyBtn, validatorBtn, copyBtn, statusEl, spacer, closeBtn);
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
    console.log('[RetKit] MoEngage workspace v0.5.4 loaded');
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);

(function (root) {
  'use strict';

  const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
  const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const KNOWN_LOCALES = new Set(['DEFAULT', 'EN', 'AR', 'ES', 'FR', 'ID', 'PT', 'TH', 'VI', 'DE', 'HI', 'TL', 'UR', 'BN', 'SV', 'JA']);

  function normaliseLocale(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^default$/i.test(raw)) return 'DEFAULT';
    const code = raw.replace('_', '-').split('-')[0].toUpperCase();
    return /^[A-Z]{2,3}$/.test(code) ? code : raw.toUpperCase();
  }

  function localeFromHtml(html) {
    const match = String(html || '').match(/<html\b[^>]*\blang\s*=\s*(["'])(.*?)\1/i);
    return match ? normaliseLocale(match[2]) : '';
  }

  function isArabicLocale(locale) {
    return normaliseLocale(locale) === 'AR';
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
      if (!KNOWN_LOCALES.has(locale)) continue;
      const shown = displayLocale(locale);
      if (!shown || seen.has(shown)) continue;
      seen.add(shown);
      result.push(shown);
    }
    return result;
  }

  function sortLocalesForUi(values) {
    const locales = filterKnownLocales(values);
    const rest = locales.filter((locale) => locale !== 'EN').sort((a, b) => a.localeCompare(b, 'en'));
    return locales.includes('EN') ? ['EN', ...rest] : rest;
  }

  function resolveActiveLocale(renderedHtml, editorHtml, nativeLocale) {
    const rendered = displayLocale(localeFromHtml(renderedHtml));
    if (rendered) return rendered;
    const editor = displayLocale(localeFromHtml(editorHtml));
    if (editor) return editor;
    return displayLocale(nativeLocale);
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
    return String(afterHtml ?? '') === String(currentHtml ?? '') && String(beforeHtml ?? '') !== String(afterHtml ?? '')
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
      if (!locale || !KNOWN_LOCALES.has(normaliseLocale(item)) || seen.has(locale)) continue;
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

  function testLocaleLabelToDisplay(label) {
    const raw = String(label || '').replace(/\s+/g, ' ').trim();
    if (/^default$/i.test(raw)) return 'EN';
    return displayLocale(raw);
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
      const label = labelByLocale.get(locale);
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
    localeFromHtml,
    isArabicLocale,
    displayLocale,
    localeAliases,
    filterKnownLocales,
    sortLocalesForUi,
    resolveActiveLocale,
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
    resolveTestLocaleSelectionPlan,
    labeledControlGeometryScore,
    activateNativeControl,
    setTextContentIfChanged,
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
    testPopover: 'retkit-mo-test-popover',
    bridgeStyle: 'retkit-mo-v050-style',
  };

  const STORAGE = {
    testPrefs: 'retkit-mo-v050-test-prefs',
  };

  let localeTimer = null;
  let subjectTimer = null;
  let rtlToggleState = null;

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
    if (/^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(raw)) return normaliseLocale(raw);
    return '';
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

  function getRenderedHtml() {
    return document.querySelector('#sidePreview')?.getAttribute('srcdoc') || '';
  }

  function getActiveLocale() {
    const renderedHtml = getRenderedHtml();
    const editorHtml = getOverlayEditor()?.getValue?.() || '';
    // MoEngage can leave selected-tab metadata stale while React remounts a
    // locale editor. The actual rendered/source HTML is the authoritative state.
    if (localeFromHtml(renderedHtml) || localeFromHtml(editorHtml)) {
      return resolveActiveLocale(renderedHtml, editorHtml, '');
    }
    const native = typeof getNativeSelectedLocale === 'function' ? getNativeSelectedLocale() : '';
    return resolveActiveLocale('', '', native);
  }

  function pruneLegacyToolbarButtons() {
    const bar = document.querySelector(`#${IDS.workspace} .rk-topbar`);
    if (!bar) return false;
    const obsolete = ['Save', 'Apply now'];
    for (const button of [...bar.querySelectorAll('button')]) {
      if (obsolete.includes(textOf(button))) button.remove();
    }
    const version = bar.querySelector('.rk-version');
    setTextContentIfChanged(version, 'v0.5.9');
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
    for (const id of [IDS.testPopover]) {
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

  function isInsideTestCampaign(element) {
    const section = findTestCampaignSection();
    return Boolean(section && element && section.contains(element));
  }

  function localeFromOptionElement(element) {
    if (!element) return '';
    const textLocale = exactLocaleFromText(textOf(element));
    const valueLocale = exactLocaleFromText(element.getAttribute?.('value'));
    const locale = textLocale || valueLocale;
    return KNOWN_LOCALES.has(locale) ? locale : '';
  }

  function isRetKitElement(element) {
    return Boolean(element && (
      document.getElementById(IDS.workspace)?.contains(element) ||
      document.getElementById(IDS.testPopover)?.contains?.(element) ||
      document.getElementById(IDS.localeLoading)?.contains?.(element) ||
      document.getElementById('retkit-mo-launcher')?.contains?.(element)
    ));
  }

  function collectNativeLocaleCandidates() {
    const selectors = 'button,a,[role="tab"],[role="button"],[aria-selected],div,span';
    const candidates = [];
    const testSection = findTestCampaignSection();
    for (const el of document.querySelectorAll(selectors)) {
      if (!isVisible(el) || isRetKitElement(el) || testSection?.contains(el)) continue;
      const locale = localeFromOptionElement(el);
      if (!locale) continue;
      // Prefer the smallest node that actually owns the locale label.
      const childWithSameLabel = [...el.children].some((child) => localeFromOptionElement(child) === locale);
      if (childWithSameLabel) continue;
      candidates.push({ element: el, locale });
    }
    return candidates;
  }

  function findNativeLocaleBar() {
    const candidates = collectNativeLocaleCandidates();
    if (candidates.length < 2) return null;
    const scores = new Map();
    // findTestCampaignSection() is intentionally computed once. Calling it for
    // every candidate ancestor repeatedly walks thousands of MoEngage nodes.
    const testSection = findTestCampaignSection();

    for (const item of candidates) {
      let cursor = item.element.parentElement;
      for (let depth = 0; cursor && depth < 6 && cursor !== document.body && cursor !== document.documentElement; depth += 1, cursor = cursor.parentElement) {
        if (isRetKitElement(cursor) || testSection?.contains(cursor)) continue;
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
    return best?.container || null;
  }

  function discoverNativeLocaleTabs() {
    const bar = findNativeLocaleBar();
    if (!bar) return [];
    const tabs = [];
    const seen = new Set();
    const testSection = findTestCampaignSection();
    for (const el of bar.querySelectorAll('button,a,[role="tab"],[role="button"],[aria-selected],div,span')) {
      if (!isVisible(el) || isRetKitElement(el) || testSection?.contains(el)) continue;
      const nativeLocale = localeFromOptionElement(el);
      if (!nativeLocale) continue;
      const display = displayLocale(nativeLocale);
      if (seen.has(display)) continue;
      const childSame = [...el.children].some((child) => displayLocale(localeFromOptionElement(child)) === display);
      if (childSame) continue;
      const closest = el.closest('button,a,[role="tab"],[role="button"],[tabindex]');
      const clickable = closest && bar.contains(closest) ? closest : el;
      tabs.push({ locale: display, nativeLocale, element: clickable });
      seen.add(display);
    }
    return tabs;
  }

  function discoverNativeLocales() {
    const tabs = discoverNativeLocaleTabs().map((item) => item.locale);
    if (tabs.length) return sortLocalesForUi(tabs);

    const fromSelects = [];
    for (const select of document.querySelectorAll('select')) {
      if (isInsideTestCampaign(select)) continue;
      for (const option of select.options || []) {
        const locale = localeFromOptionElement(option);
        if (locale) fromSelects.push(locale);
      }
    }
    const active = getActiveLocale();
    if (active) fromSelects.push(active);
    return sortLocalesForUi(fromSelects);
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
      const option = options.find((item) => aliases.has(localeFromOptionElement(item)));
      if (option) return { type: 'select', control: select, option, nativeLocale: localeFromOptionElement(option) };
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

  function findVisibleLocaleOption(target) {
    const aliases = new Set(localeAliases(target));
    const candidates = document.querySelectorAll('[role="option"],li,button,[role="menuitem"],label,div,span');
    let best = null;
    for (const el of candidates) {
      if (!isVisible(el) || document.getElementById(IDS.workspace)?.contains(el) || isInsideTestCampaign(el)) continue;
      if (!aliases.has(localeFromOptionElement(el))) continue;
      const clickable = el.closest('button,[role="option"],[role="menuitem"],li,label') || el;
      if (!best || textOf(clickable).length < textOf(best).length) best = clickable;
    }
    return best;
  }

  async function switchNativeLocale(target) {
    const locale = displayLocale(target);
    if (!locale) return { ok: false, reason: 'Locale is empty' };
    const current = getActiveLocale();
    if (current === locale) return { ok: true, reason: 'Already active' };

    const direct = findDirectLocaleControl(locale);
    if (direct?.type === 'select') setNativeSelect(direct.control, direct.option);
    else if (direct?.type === 'click') direct.control.click();
    else {
      const trigger = findLocaleDropdownTrigger();
      if (!trigger) return { ok: false, reason: `MoEngage locale tab ${locale} was not found` };
      trigger.click();
      await wait(160);
      const option = findVisibleLocaleOption(locale);
      if (!option) return { ok: false, reason: `Locale ${locale} was not found in MoEngage` };
      option.click();
    }

    for (const delay of [120, 280, 550, 900, 1500, 2400]) {
      await wait(delay);
      const rendered = displayLocale(localeFromHtml(getRenderedHtml()));
      const nativeSelected = getNativeSelectedLocale();
      if (rendered === locale || nativeSelected === locale) {
        await rebindWorkspaceAfterLocaleChange(locale);
        return { ok: true, reason: '' };
      }
    }

    // The click may still be valid even if MoEngage does not expose selected-state metadata.
    // Rebind once so RetKit reads the newly mounted editor before reporting a failure.
    await rebindWorkspaceAfterLocaleChange(locale);
    const rendered = displayLocale(localeFromHtml(getRenderedHtml()));
    if (rendered === locale || getNativeSelectedLocale() === locale) return { ok: true, reason: '' };
    return { ok: false, reason: `MoEngage did not render ${locale} after the locale click` };
  }

  async function rebindWorkspaceAfterLocaleChange(targetLocale = '') {
    const base = root.__RetKitMoEngageCore;
    if (!document.getElementById(IDS.workspace) || !base?.rebindNativeEditorFromMoEngage) return false;
    const wanted = displayLocale(targetLocale);

    for (const delay of [60, 120, 220, 360, 600, 900, 1400]) {
      await wait(delay);
      const native = document.querySelector('.CodeMirror')?.CodeMirror;
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

  function simpleIdentityHash(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function snapshotBeforeRtl(html) {
    const base = root.__RetKitMoEngageCore;
    if (!base?.saveSnapshot) return;
    const subject = document.querySelector('input[name*="subject" i], input[placeholder*="subject" i]')?.value || '';
    const localeText = document.querySelector('[data-testid*="locale" i], [class*="locale" i]')?.textContent?.trim().slice(0, 80) || '';
    const identity = simpleIdentityHash(`${location.pathname}|${location.search}|${subject}|${localeText}`);
    try { base.saveSnapshot(localStorage, identity, html, 'before-rtl'); } catch {}
  }

  function applyRtlFix() {
    const editor = getOverlayEditor();
    if (!editor) {
      workspaceStatus('RetKit editor is not ready', 'error');
      return;
    }
    const active = getActiveLocale();
    const currentHtml = editor.getValue();

    if (rtlToggleState && rtlToggleState.locale === active && rtlToggleDecision(rtlToggleState.before, rtlToggleState.after, currentHtml) === 'revert') {
      const accepted = root.confirm?.(`RTL Fix is already applied${active ? ` · locale ${active}` : ''}.

Revert the last RTL Fix?`);
      if (accepted === false) return;
      const restored = rtlToggleState.before;
      rtlToggleState = null;
      editor.operation?.(() => editor.setValue(restored));
      if (!editor.operation) editor.setValue(restored);
      editor.focus?.();
      workspaceStatus('RTL Fix reverted', 'ok');
      return;
    }

    const arabicDetected = shouldAllowRtlFix(active, currentHtml);
    const result = transformRtlHtml(currentHtml, { allParagraphs: !arabicDetected });
    if (!result.totalCount) {
      workspaceStatus('RTL Fix: nothing to change', 'ok');
      return;
    }
    const localeNote = arabicDetected
      ? `Arabic copy detected${active ? ` · locale ${active}` : ''}.`
      : `RTL test mode${active ? ` · locale ${active}` : ''}: no Arabic copy detected, so all non-empty paragraphs will be converted.`;
    const accepted = root.confirm?.(`${localeNote}
RTL Fix will update ${result.paragraphCount} <p> and ${result.cellCount} parent <td> tags.

Apply these changes?`);
    if (accepted === false) return;
    snapshotBeforeRtl(currentHtml);
    rtlToggleState = { locale: active, before: currentHtml, after: result.html };
    editor.operation?.(() => editor.setValue(result.html));
    if (!editor.operation) editor.setValue(result.html);
    editor.focus?.();
    workspaceStatus(`RTL Fix applied: ${result.paragraphCount} p + ${result.cellCount} td + ${result.alignCount || 0} aligned containers`, 'ok');
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
      tab.textContent = locale;
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
      strip.appendChild(tab);
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


  function findNativeSubjectInput() {
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
    const shown = displayLocale(locale);
    return shown === 'EN' ? ['Default', 'EN'] : [shown];
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

  function collectTestLocalePopupLabels(popup) {
    if (!popup) return [];
    const labels = [];
    const seen = new Set();
    for (const el of popup.querySelectorAll('label,[role="option"],li,button,span,div')) {
      const text = textOf(el);
      if (!text || text.length > 24) continue;
      const locale = testLocaleLabelToDisplay(text);
      if (!locale || !KNOWN_LOCALES.has(normaliseLocale(locale))) continue;
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
    const wanted = String(wantedLabel || '').replace(/\s+/g, ' ').trim().toLowerCase();
    let best = null;
    let bestScore = Infinity;
    for (const el of popup.querySelectorAll('label,[role="option"],li,button,span,div')) {
      if (textOf(el).toLowerCase() !== wanted) continue;
      const clickable = el.closest('.mds-dropdown__popup__list__item,label,[role="option"],li,button') || el;
      if (!popup.contains(clickable)) continue;
      const score = clickable.children.length * 5 + textOf(clickable).length;
      if (score < bestScore) { best = clickable; bestScore = score; }
    }
    return best;
  }

  async function openTestLocalePopup(control) {
    const clickable = dropdownClickable(control);
    activateNativeControl(clickable);
    let selectAll = await waitForPortalAction('Select all', { excludeLocaleBar: true }, 900);
    let clearAll = await waitForPortalAction('Clear all', { excludeLocaleBar: true }, 900);
    if (!selectAll && !clearAll) {
      // Some MDS builds open on keyboard interaction rather than click when the
      // trigger is an input-like element. Use the same fallback a keyboard user would.
      try { clickable?.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true })); } catch {}
      selectAll = await waitForPortalAction('Select all', { excludeLocaleBar: true }, 900);
      clearAll = await waitForPortalAction('Clear all', { excludeLocaleBar: true }, 900);
    }
    const anchor = selectAll || clearAll;
    return { popup: testLocalePopupFromAction(anchor), selectAll, clearAll };
  }

  async function selectExplicitTestLocales(section, selectedLocales) {
    const control = findLabeledControl(section, 'Locales and Variations');
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

    const popupLabels = collectTestLocalePopupLabels(opened.popup);
    const plan = resolveTestLocaleSelectionPlan(selected, popupLabels);
    if (plan.missing.length) return { ok: false, reason: `Test Campaign locales not found: ${plan.missing.join(', ')}` };

    if (opened.clearAll) activateNativeControl(opened.clearAll);
    await wait(160);

    if (plan.useSelectAll) {
      // MoEngage's locale picker is a multi-select. Selecting the native "Select all"
      // is more reliable than clicking every checkbox through the portal one by one.
      opened = await openTestLocalePopup(control);
      if (!opened.popup) return { ok: false, reason: 'Test Campaign locale dropdown closed before Select all' };
      const selectAll = opened.selectAll || await waitForPortalAction('Select all', { excludeLocaleBar: true }, 900);
      if (!selectAll) return { ok: false, reason: 'Test Campaign Select all action was not found' };
      activateNativeControl(selectAll);
      await wait(220);
    } else {
      for (const label of plan.labels) {
        if (!opened.popup?.isConnected || !isVisible(opened.popup)) opened = await openTestLocalePopup(control);
        let option = findTestLocaleOptionInPopup(opened.popup, label);
        if (!option) {
          // Some MDS versions remount the portal after every checkbox click.
          opened = await openTestLocalePopup(control);
          option = findTestLocaleOptionInPopup(opened.popup, label);
        }
        if (!option) return { ok: false, reason: `Test Campaign locale option was not found: ${label}` };
        const checkbox = option.matches?.('input[type="checkbox"]') ? option : option.querySelector?.('input[type="checkbox"]');
        if (!checkbox || !checkbox.checked) activateNativeControl(option);
        await wait(120);
      }
    }

    const dropdownTrigger = dropdownClickable(control);
    const expanded = control.getAttribute?.('aria-expanded') === 'true' || dropdownTrigger?.getAttribute?.('aria-expanded') === 'true';
    if (expanded) activateNativeControl(dropdownTrigger);
    await wait(160);
    return { ok: true };
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
    activateNativeControl(sendViaTrigger);
    let option = await waitForMdsPopupOption(wanted, 1100);
    if (!option) option = await waitForPortalAction(wanted, {}, 900);
    if (!option) {
      try { sendViaTrigger?.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true })); } catch {}
      option = await waitForMdsPopupOption(wanted, 900);
      if (!option) option = await waitForPortalAction(wanted, {}, 900);
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

  async function submitNativeTestCampaign(preferences) {
    const prefs = normaliseTestPreferences(preferences);
    const section = findTestCampaignSection();
    if (!section) return { ok: false, reason: 'MoEngage Test Campaign section was not found' };
    section.scrollIntoView?.({ block: 'center' });
    await wait(120);
    const sendViaResult = await selectNativeSendVia(section, prefs.sendVia);
    if (!sendViaResult.ok) return sendViaResult;
    await wait(120);

    const emailField = section.querySelector('textarea[placeholder*="email" i], input[type="email"], textarea');
    if (!emailField) return { ok: false, reason: 'Test Campaign email field was not found' };
    if (!prefs.email || !prefs.email.includes('@')) return { ok: false, reason: 'Enter a test email address' };

    setNativeValue(emailField, prefs.email);
    try { emailField.dispatchEvent(new Event('blur', { bubbles: true })); } catch {}
    const switchControl = findPersonaliseSwitch(section);
    if (switchControl) setSwitchState(switchControl, prefs.personalise);

    const selectedLocales = prefs.locales.length ? prefs.locales : [getActiveLocale()].filter(Boolean);
    const localeResult = await selectExplicitTestLocales(section, selectedLocales);
    if (!localeResult.ok) return localeResult;

    let testButton = null;
    for (const delay of [220, 300, 500, 800, 1200]) {
      await wait(delay);
      testButton = [...section.querySelectorAll('button')].find((button) => /^Test$/i.test(textOf(button)));
      if (testButton && !testButton.disabled) break;
    }
    if (!testButton) return { ok: false, reason: 'Native MoEngage Test button was not found' };
    if (testButton.disabled) return { ok: false, reason: 'Native MoEngage Test button is still disabled. Check Send via and locale selection.' };

    const accepted = root.confirm?.(`Send MoEngage test email to ${prefs.email}?\nLocales: ${selectedLocales.join(', ')}`);
    if (accepted === false) return { ok: false, reason: 'Cancelled' };
    testButton.click();
    return { ok: true, reason: '' };
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
      text.textContent = locale;
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
      const result = await submitNativeTestCampaign(next);
      if (result.ok) {
        workspaceStatus(`Test requested for ${next.email} · ${next.locales.join(', ')}`, 'ok');
        pop.remove();
      } else if (result.reason !== 'Cancelled') {
        workspaceStatus(result.reason, 'error');
      }
    });
    document.body.appendChild(pop);
  }

  function closeWorkspaceForNativeSection() {
    const close = [...document.querySelectorAll(`#${IDS.workspace} .rk-topbar button`)].find((button) => textOf(button) === 'Close');
    close?.click();
  }

  function updateLocaleUi(forceDiscovery = false) {
    const locale = getActiveLocale();
    const rtlButton = document.getElementById(IDS.rtlButton);
    if (rtlButton) rtlButton.classList.toggle('rk-active', isArabicLocale(locale));
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
      const button = makeToolbarButton(IDS.rtlButton, 'RTL Fix', applyRtlFix, 'Apply RTL attributes to Arabic copy, or test RTL on any currently open locale');
      bar.insertBefore(button, statusEl || bar.querySelector('.rk-spacer'));
    }
    if (!document.getElementById(IDS.testButton)) {
      const button = makeToolbarButton(IDS.testButton, 'Send test', renderTestPopover, 'Send through the native MoEngage Test Campaign controls');
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
      row.append(label, strip);
      bar.insertAdjacentElement('afterend', row);
      updateLocaleUi(true);
    } else {
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

  function bootBridge() {
    injectBridgeStyle();
    ensureBridgeToolbar();

    // Do not observe the entire MoEngage document. Locale discovery scans a
    // large React tree and a global MutationObserver can create an expensive
    // feedback loop during editor/preview remounts. A light heartbeat only
    // ensures the bridge UI exists; locale discovery itself is cached.
    localeTimer = setInterval(() => {
      if (document.getElementById(IDS.workspace)) { ensureBridgeToolbar(); syncSubjectFromMoEngage(false); }
      else closeBridgePopovers();
    }, 1200);

    root.addEventListener?.('beforeunload', () => {
      if (localeTimer) clearInterval(localeTimer);
      if (subjectTimer) clearTimeout(subjectTimer);
    });
    console.log('[RetKit] MoEngage bridge v0.5.7 loaded');
  }

  bootBridge();
})(typeof globalThis !== 'undefined' ? globalThis : this);
