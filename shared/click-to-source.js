/*! RetKit click-to-source v0.8.0 — generated from retkit-moeng
 *  src/core/retkit-moengage-core.user.js by scripts/export-click-to-source.mjs.
 *  Do not edit by hand: change the core, run `npm run build`, copy shared/click-to-source.js. */
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

  function parseTagName(token) {
    const match = String(token || '').match(/^<\/?\s*([a-zA-Z0-9:-]+)/);
    return match ? match[1].toLowerCase() : '';
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

  // Map a click inside a same-origin preview document to a source range.
  // Returns { kind, start, end, descriptor } or null.
  function resolveClick(event, doc, source) {
    const target = event?.target?.nodeType === 1 ? event.target : event?.target?.parentElement;
    if (!target || !doc) return null;
    const point = getPointTextFromClick(event, doc);
    const descriptor = descriptorFromElement(target, doc, point);
    const range = findRangeFromDescriptor(String(source || ''), descriptor);
    return range ? { ...range, descriptor } : null;
  }

  root.RetKitClickToSource = {
    version: '0.8.0',
    findRangeFromDescriptor,
    descriptorFromElement,
    getPointTextFromClick,
    findOccurrenceIndex,
    findTextOccurrenceRange,
    resolveClick,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
