// ==UserScript==
// @name         RetKit for MoEngage
// @namespace    https://github.com/Brokenbass90/retkit-moeng
// @version      0.5.9
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
