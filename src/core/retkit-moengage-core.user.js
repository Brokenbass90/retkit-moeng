// ==UserScript==
// @name         RetKit for MoEngage
// @namespace    https://github.com/Brokenbass90/retkit-moeng
// @version      0.7.5
// @description  Fullscreen email coding workspace for MoEngage with live preview and click-to-source navigation.
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
      locale.textContent = item.count ? `${item.locale} · ${item.count}` : item.locale;
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
        const result = smartReplace(currentHtml, query, replacement, mode);
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
          remove.title = `Remove ${locale}`;
          remove.addEventListener('click', async () => {
            if (STATE.multiLocaleBusy || root.confirm?.(`Remove locale ${locale} from this MoEngage campaign?`) === false) return;
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
    const KIND = { image: 'image', link: 'link', background: 'background', attribute: 'attribute', text: 'text' };
    for (const hit of (item.hits || []).slice(0, 6)) {
      const line = document.createElement('div');
      line.className = 'rk-ml-hit';
      const kind = document.createElement('span');
      kind.className = 'rk-ml-kind';
      kind.textContent = `${locale} · ${KIND[hit.kind] || 'text'}`;
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
    brand.innerHTML = '<span class="rk-mark">RK</span><span>RetKit × MoEngage</span><span class="rk-version">v0.7.5</span>';
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
        version: '0.7.5',
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
  async function aiAcrossLocales({ query = '', replacement, mode = 'text' } = {}) {
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
    const summary = summarizeLocaleReplacePlan(STATE.multiLocalePlan);
    return {
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
    console.log('[RetKit] MoEngage workspace v0.7.5 loaded');
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
