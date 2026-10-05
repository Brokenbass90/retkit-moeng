// ==UserScript==
// @name         RetKit for MoEngage
// @namespace    https://github.com/Brokenbass90/retkit-moeng
// @version      0.7.1
// @description  RetKit workspace with native MoEngage locale tabs, RTL and Test Campaign bridge.
// @match        https://dashboard-02.moengage.com/*
// @require      https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/src/retkit-moengage.user.js
// @updateURL    https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/dist/retkit-moengage.user.js
// @downloadURL  https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/dist/retkit-moengage.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

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
    if (!/^[a-z]{2,3}(?:[-_][a-z]{2})?$/i.test(raw)) return '';
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
    if (/^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(raw)) return normaliseLocale(raw);
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
    setTextContentIfChanged(version, 'v0.7.1');
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
    return KNOWN_LOCALES.has(locale) ? locale : '';
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
              if (locale && KNOWN_LOCALES.has(normaliseLocale(locale))) {
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
      if (!locale || !KNOWN_LOCALES.has(normaliseLocale(locale))) continue;
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
        if (!locale || !KNOWN_LOCALES.has(normaliseLocale(locale))) continue;
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
      .filter((item, index, all) => item.locale && KNOWN_LOCALES.has(normaliseLocale(item.locale)) && all.findIndex((x) => x.row === item.row) === index);

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
      label.innerHTML = `<input type="checkbox" data-locale="${locale}"> <span>${locale}</span>`;
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
      api.store = api.createStore({ version: '0.7.1' }); // version: scripts/version-files.mjs
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
    console.log('[RetKit] MoEngage bridge v0.7.1 loaded');
  }

  bootBridge();
})(typeof globalThis !== 'undefined' ? globalThis : this);
