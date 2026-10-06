// GENERATED from retantion-future/email-base/tools/rtl.js by scripts/sync-rtl-core.mjs.
// Do not edit here — change the studio file and re-run the script.
(function (root) {
  'use strict';
  const module = { exports: {} };
/* eslint-disable no-useless-escape */
/**
 * Minimal RTL post-processor for ar/he/fa/ur (and similar) emails.
 *
 * Design principle: change as little as possible. The email column
 * keeps its centered structural layout intact; only:
 *   - text reading direction is set on the INNERMOST text-bearing
 *     <td>/<th> cells (where the actual localized text lives), except
 *     mixed text/media blocks whose inline source order must stay intact,
 *   - text alignment is flipped from left → right (or added as right
 *     when no text-align was set) on the elements that carry text
 *     (p / h1..h6 / li / leaf div, plus the innermost text td),
 *   - direct-text <td>/<th> cells get the same treatment,
 *   - button shell tables are pulled to align="right" so CTA buttons
 *     end up on the right side of their column.
 *
 * In the default `text` mode EVERYTHING ELSE is left alone:
 *   - no dir="rtl" on wrappers, layout tables, structural <td>,
 *     spacers, <a>, <button>, <span>, <font>, <b>, etc.
 *   - no text-align inserted on elements that already declare
 *     text-align: center / right / justify (designer intent wins).
 *   - layout <td> with only nested children stays untouched.
 *
 * Detection mechanics:
 *   - "innermost text td" = a <td>/<th> whose direct top-level
 *     content has visible text outside any nested block child.
 *     Detected by a small tokenizer with block-depth counting.
 *   - "button shell table" = the IMMEDIATELY enclosing <table> of a
 *     <td class="butt…">. Detected by a stack-walk over the token
 *     stream. We never mark outer wrapper tables.
 *
 * Opt-in `mirror` mode additionally mirrors physical inline sides and
 * known two-column rows. It exists for templates whose art direction really
 * calls for a complete mirror; it is deliberately not the default because
 * inline-css has already copied framework rules onto body/table/td/img by the
 * time this transformer runs.
 *
 * Used by:
 *   - email-base/tools/build-mail.js          (build-time, on disk HTML)
 *   - server.js → applyLocaleDirectionToHtml  (preview/AI flow in the studio)
 */

const RTL_SCRIPT_CODES = new Set([
  'adlm', 'arab', 'hebr', 'mand', 'nkoo', 'rohg', 'samr', 'syrc', 'thaa', 'yezi',
]);
const RTL_DEFAULT_LANGUAGES = new Set([
  'ar', 'arc', 'dv', 'fa', 'he', 'khw', 'ks', 'ps', 'sd', 'ug', 'ur', 'yi',
]);

/**
 * Parse the BCP-47 pieces needed for text direction without trusting input.
 * Underscore locale names are common in the email base, while Intl.Locale
 * accepts only hyphens. A small deterministic fallback keeps Node/browser
 * behaviour aligned when Intl.Locale or full ICU likely-subtags are absent.
 */
function parseLocaleForDirection(localeRaw) {
  const normalized = String(localeRaw || '')
    .trim()
    .replace(/_/g, '-')
    .split(/[.@]/, 1)[0];
  const parts = normalized.split('-').filter(Boolean);
  const language = /^[a-z]{2,3}$/i.test(parts[0] || '') ? parts[0].toLowerCase() : '';
  let script = '';
  let region = '';
  for (const part of parts.slice(1)) {
    if (/^[a-z0-9]$/i.test(part)) break; // extensions/private-use are not script tags
    if (!script && /^[a-z]{4}$/i.test(part)) script = part.toLowerCase();
    else if (!region && /^(?:[a-z]{2}|\d{3})$/i.test(part)) region = part.toUpperCase();
  }
  return { normalized, language, script, region };
}

function fallbackLikelyScript({ language, region }) {
  if (language === 'ha') return 'latn';
  if (language === 'ku') return /^(?:IQ|IR)$/.test(region) ? 'arab' : 'latn';
  if (language === 'ks') return 'arab';
  if (language === 'az') return region === 'IR' ? 'arab' : 'latn';
  if (language === 'pa') return region === 'PK' ? 'arab' : 'guru';
  if (language === 'uz') return region === 'AF' ? 'arab' : 'latn';
  return RTL_DEFAULT_LANGUAGES.has(language) ? 'arab' : 'latn';
}

function resolveLocaleScript(localeRaw) {
  const parsed = parseLocaleForDirection(localeRaw);
  if (!parsed.language) return '';
  // An explicit script is authoritative: ar-Latn/ks-Deva are LTR and
  // en-Arab/ha-Arab are RTL regardless of the language default.
  if (parsed.script) return parsed.script;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Locale === 'function') {
      const likely = new Intl.Locale(parsed.normalized).maximize();
      if (likely.script) return String(likely.script).toLowerCase();
    }
  } catch {
    // Invalid/private locale: use the deterministic table below.
  }
  return fallbackLikelyScript(parsed);
}

function isRtlLocale(localeRaw) {
  return RTL_SCRIPT_CODES.has(resolveLocaleScript(localeRaw));
}

const VISIBLE_TEXT_RE = /[A-Za-zА-Яа-яЁё֐-׿؀-ۿݐ-ݿ]/;

function hasVisibleText(s) {
  if (!s) return false;
  const text = String(s)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ');
  return VISIBLE_TEXT_RE.test(text) || /&[a-zA-Z]+;|&#\d+;/.test(String(s));
}

function readAttr(attrs, name) {
  const src = String(attrs || '');
  const quoted = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(src);
  if (quoted) return quoted[2];
  const bare = new RegExp(`\\b${name}\\s*=\\s*([^\\s"'>]+)`, 'i').exec(src);
  return bare ? bare[1] : '';
}

function hasClassToken(attrs, re) {
  return readAttr(attrs, 'class')
    .split(/\s+/)
    .filter(Boolean)
    .some(token => re.test(token));
}

function withDirRtl(attrs) {
  if (/\bdir\s*=/i.test(attrs)) return attrs;
  return ` dir="rtl"${attrs}`;
}

function normalizeRtlMode(opts) {
  const raw = typeof opts === 'string'
    ? opts
    : (opts && (opts.mode || opts.layout || opts.layoutMode));
  const value = String(raw || '').trim();
  if (/^(?:document|arabic|arabize|full-document)$/i.test(value)) return 'document';
  return /^(?:mirror|full)$/i.test(value) ? 'mirror' : 'text';
}

/* ─── Style flippers: text-align only, !important preserved ─────── */

function flipTextAlignInCss(css) {
  if (!css) return css;
  return css.replace(
    /\btext-align\s*:\s*(left|start|end)\b([^;}\n]*)/gi,
    (match, _value, rest) => {
      if (/\!\s*important/i.test(rest)) return match;
      return `text-align: right${rest}`;
    }
  );
}

function flipTextAlignInStyleAttr(attrs) {
  if (!/\bstyle\s*=/i.test(attrs)) return attrs;
  return attrs.replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i,
    (_m, q, body) => `style=${q}${flipTextAlignInCss(body)}${q}`);
}

function flipAllInlineStyles(html) {
  return html.replace(/<([a-z][\w:-]*)([^>]*)>/gi, (m, tag, attrs) => {
    if (/^(?:style|script)$/i.test(tag)) return m;
    if (!/\bstyle\s*=/i.test(attrs)) return m;
    return `<${tag}${flipTextAlignInStyleAttr(attrs)}>`;
  });
}

/* ─── Physical-side swap: padding/margin/float left ↔ right ─────── */
/**
 * In HTML email templates the column structure is built with physical
 * padding-left / padding-right values (utility classes like `.pl50`,
 * `.offset-by-one { padding-left: 50px }`, or inline `padding-left: 50px`).
 * For RTL we want the offset to land on the *opposite* physical side —
 * otherwise a column that visually starts 50px from the LEFT in EN will
 * still start 50px from the LEFT in AR/UR, which puts the content on the
 * wrong side of the column.
 *
 * Rules:
 *   - Swap individual padding-left ↔ padding-right declarations.
 *   - Swap individual margin-left ↔ margin-right declarations.
 *   - Swap float: left ↔ float: right.
 *   - Skip declarations marked `!important` — designer intent wins.
 *   - Skip when both sides have the same value (no-op).
 *   - This pass operates on raw CSS strings (inline styles + <style>
 *     blocks).
 *
 * NOTE: the shorthand `padding: a b c d` is left alone — too risky to
 * try to re-shuffle the 4-value order with regex. Templates that need
 * RTL-aware padding should use the per-side declarations.
 */
function swapPhysicalSidesInCss(css) {
  if (!css) return css;
  // float
  let out = css.replace(/\bfloat\s*:\s*(left|right)\b([^;}\n]*)/gi, (match, value, rest) => {
    if (/\!\s*important/i.test(rest)) return match;
    return `float: ${value === 'left' ? 'right' : 'left'}${rest}`;
  });
  // padding-left / padding-right / margin-left / margin-right
  // Strategy: collect all declarations into a temporary map per side,
  // then re-emit. But we don't want to reorder the rest of the rule.
  // Easier: do a token-pair swap using placeholders.
  //
  // We rewrite using a placeholder so the two sides don't fight.
  const TOKEN_L = '\x00LFT\x00';
  const TOKEN_R = '\x00RGT\x00';

  // padding-left → TOKEN_L (skip !important)
  out = out.replace(/\bpadding-left\s*:\s*([^;}\n]+?)(?=\s*(?:;|}|$|\n))/gi,
    (match, value) => /\!\s*important/i.test(value) ? match : `padding-${TOKEN_L}: ${value.trim()}`);
  out = out.replace(/\bpadding-right\s*:\s*([^;}\n]+?)(?=\s*(?:;|}|$|\n))/gi,
    (match, value) => /\!\s*important/i.test(value) ? match : `padding-${TOKEN_R}: ${value.trim()}`);
  out = out.replace(/\bmargin-left\s*:\s*([^;}\n]+?)(?=\s*(?:;|}|$|\n))/gi,
    (match, value) => /\!\s*important/i.test(value) ? match : `margin-${TOKEN_L}: ${value.trim()}`);
  out = out.replace(/\bmargin-right\s*:\s*([^;}\n]+?)(?=\s*(?:;|}|$|\n))/gi,
    (match, value) => /\!\s*important/i.test(value) ? match : `margin-${TOKEN_R}: ${value.trim()}`);

  // Token swap: L → right, R → left.
  out = out.replace(new RegExp(TOKEN_L, 'g'), 'right');
  out = out.replace(new RegExp(TOKEN_R, 'g'), 'left');

  // ── background-position keyword swap ──────────────────────────────
  // Two forms in HTML email templates:
  //   1) `background-position: left top` / `right center` / etc.
  //   2) `background: url(...) left top no-repeat` (shorthand).
  //
  // Only swap the `left` / `right` KEYWORDS (not percentages like 25%) —
  // a percentage-based position has its own meaning the designer chose.
  // Process in a single pass with placeholder tokens to avoid the
  // L→R→L back-and-forth ping-pong.
  const POS_L = '\x00POSL\x00';
  const POS_R = '\x00POSR\x00';

  // background-position: <pos>; (longhand)
  out = out.replace(/\bbackground-position\s*:\s*([^;}\n]+)/gi, (match, value) => {
    if (/\!\s*important/i.test(value)) return match;
    const swapped = value
      .replace(/\bleft\b/g, POS_L)
      .replace(/\bright\b/g, POS_R);
    return `background-position: ${swapped}`;
  });

  // background: <stuff> <left|right> <top|bottom|center>? ... (shorthand)
  // We're conservative — only flip standalone `left`/`right` tokens, not
  // anything inside url(...). Match only outside parens by splitting on url(…).
  out = out.replace(/\bbackground\s*:\s*([^;}\n]+)/gi, (match, value) => {
    if (/\!\s*important/i.test(value)) return match;
    // Don't touch the value INSIDE url(...) — that may contain literal
    // 'left'/'right' inside an image URL.
    const swapped = value.replace(/(url\([^)]*\))|(\bleft\b)|(\bright\b)/g,
      (m, urlPart, leftTok, rightTok) => {
        if (urlPart) return urlPart;
        if (leftTok) return POS_L;
        if (rightTok) return POS_R;
        return m;
      });
    return `background: ${swapped}`;
  });

  out = out.replace(new RegExp(POS_L, 'g'), 'right');
  out = out.replace(new RegExp(POS_R, 'g'), 'left');

  return out;
}

function swapPhysicalSidesInStyleAttr(attrs) {
  if (!/\bstyle\s*=/i.test(attrs)) return attrs;
  return attrs.replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i,
    (_m, q, body) => `style=${q}${swapPhysicalSidesInCss(body)}${q}`);
}

function swapPhysicalSidesOnAllTags(html) {
  return html.replace(/<([a-z][\w:-]*)([^>]*)>/gi, (m, tag, attrs) => {
    if (/^(?:style|script)$/i.test(tag)) return m;
    if (!/\bstyle\s*=/i.test(attrs)) return m;
    return `<${tag}${swapPhysicalSidesInStyleAttr(attrs)}>`;
  });
}

/* ─── Attribute flippers: align="left|start|end" → align="right"
 * NOTE: no dir="rtl" added here. The user's directive is that dir
 * lives only on the innermost text cell.                          */

function flipAlignAttr(attrs) {
  return attrs.replace(/\balign\s*=\s*(["']?)(left|start|end)\1/gi, 'align="right"');
}

function flipAlignOnAllTags(html) {
  return html.replace(/<([a-z][\w:-]*)([^>]*)>/gi, (m, tag, attrs) => {
    if (/^(?:style|script)$/i.test(tag)) return m;
    if (!/\balign\s*=/i.test(attrs)) return m;
    return `<${tag}${flipAlignAttr(attrs)}>`;
  });
}

/* ─── Button shell detection (innermost enclosing <table>) ─────── */

function isButtonClassToken(attrs) {
  return hasClassToken(attrs, /^(?:button|tiny-button|small-button|medium-button(?:-[\w-]+)?|large-button)$/i)
    || hasClassToken(attrs, /(?:^|-)button(?:-|$)/i);
}

function findButtonShellTableStarts(html) {
  const marked = new Set();
  const stack = [];
  const tagRe = /<(\/?)(table|td|th)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (!closing) {
      if (tag === 'table') {
        stack.push({ start: m.index });
      } else if (tag === 'td' || tag === 'th') {
        const cls = readAttr(m[3], 'class');
        const isButtCell = cls
          .split(/\s+/)
          .some(token => /^butt(?:[-_].*)?$/i.test(token));
        if (isButtCell && stack.length) {
          marked.add(stack[stack.length - 1].start);
        }
      }
    } else if (tag === 'table') {
      stack.pop();
    }
  }
  return marked;
}

function forceAlignRightAttr(attrs) {
  if (!/\balign\s*=/i.test(attrs)) return `${attrs} align="right"`;
  return attrs
    .replace(/\balign\s*=\s*(["'])([\s\S]*?)\1/i, 'align="right"')
    .replace(/\balign\s*=\s*([^\s"'>]+)/i, 'align="right"');
}

/**
 * A button shell is "centered by design" when:
 *   - it carries align="center" itself, or
 *   - its inline style centers it (margin: … auto / margin-left+right auto), or
 *   - it sits inside a <center> element or a td/th with align="center"
 *     (or inline text-align: center) and has no own align attribute.
 * Centered buttons must STAY centered in RTL — mirroring only moves
 * left-anchored buttons to the right. (User directive: ur/ar rebuild
 * must not shove centered CTAs to the side.)
 */
function isSelfCentered(attrs) {
  const align = readAttr(attrs, 'align').toLowerCase();
  if (align === 'center' || align === 'middle') return true;
  const styleM = String(attrs || '').match(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i);
  if (styleM) {
    const css = styleM[2];
    if (/\bmargin\s*:\s*[^;]*\bauto\b/i.test(css)) return true;
    if (/\bmargin-left\s*:\s*auto\b/i.test(css) && /\bmargin-right\s*:\s*auto\b/i.test(css)) return true;
  }
  return false;
}

function findCenteredContextStarts(html) {
  // Token walk: mark every <table> open offset whose ancestor chain
  // contains <center> or td/th centered via align/text-align.
  const centered = new Set();
  const stack = []; // true when the frame centers its children
  const tagRe = /<(\/?)(table|td|th|center|div)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    if (closing) { stack.pop(); continue; }
    // self-closing guard (rare for these tags)
    if (/\/\s*$/.test(attrs)) continue;
    let centersChildren = false;
    if (tag === 'center') centersChildren = true;
    else if (tag === 'td' || tag === 'th' || tag === 'div') {
      const align = readAttr(attrs, 'align').toLowerCase();
      if (align === 'center' || align === 'middle') centersChildren = true;
      else {
        const styleM = attrs.match(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i);
        if (styleM && /\btext-align\s*:\s*center\b/i.test(styleM[2])) centersChildren = true;
      }
    }
    if (tag === 'table' && (centersChildren || stack.some(Boolean))) {
      // note: a table whose *ancestor* centers content
      if (stack.some(Boolean)) centered.add(m.index);
    }
    stack.push(centersChildren);
  }
  return centered;
}

function alignButtonShellsRight(html) {
  const marked = findButtonShellTableStarts(html);
  const centeredCtx = findCenteredContextStarts(html);
  return html.replace(/<table\b([^>]*)>/gi, (m, attrs, offset) => {
    const isShell = isButtonClassToken(attrs) || marked.has(offset);
    if (!isShell) return m;
    // Centered by design → leave exactly as-is.
    if (isSelfCentered(attrs)) return m;
    if (!/\balign\s*=/i.test(attrs) && centeredCtx.has(offset)) return m;
    return `<table${forceAlignRightAttr(attrs)}>`;
  });
}

/* ─── text-align utilities ─────────────────────────────────────── */

function readTextAlignFromStyle(attrs) {
  if (!/\bstyle\s*=/i.test(attrs)) return null;
  const m = attrs.match(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i);
  if (!m) return null;
  const decl = m[2].match(/\btext-align\s*:\s*([a-zA-Z-]+)/i);
  return decl ? decl[1].toLowerCase() : null;
}

/**
 * Add `text-align: right` to attrs ONLY when:
 *   - no text-align declaration exists, OR
 *   - text-align was `left` / `start` (already flipped by earlier passes,
 *     so by this point it is `right` — no-op for us either way).
 * Skip when text-align is center / justify / right / inherit / initial.
 */
function ensureTextAlignRightIfMissing(attrs) {
  const current = readTextAlignFromStyle(attrs);
  if (current !== null && !/^(?:left|start|end)$/i.test(current)) return attrs;
  if (current !== null) attrs = flipTextAlignInStyleAttr(attrs);
  const align = readAttr(attrs, 'align').toLowerCase();
  if (align === 'center' || align === 'middle' || align === 'right' || align === 'justify') {
    return attrs;
  }
  if (align === 'left' || align === 'start' || align === 'end') {
    attrs = forceAlignRightAttr(attrs);
  }
  if (current !== null) {
    return attrs;
  }
  // No text-align declared. Add it.
  if (/\bstyle\s*=/i.test(attrs)) {
    return attrs.replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i,
      (_m, q, body) => `style=${q}${body.replace(/\s*;?\s*$/, ';')} text-align: right;${q}`);
  }
  return `${attrs} style="text-align: right;"`;
}

/* ─── Direct-text cells: direction without touching layout cells ─── */

const CELL_BLOCK_TAG_RE = /^(?:table|tbody|thead|tfoot|tr|td|th|center|div|p|h[1-6]|ul|ol|li|blockquote)$/i;
const INLINE_ORDER_MEDIA_RE = /<(?:img|svg|picture|video|object|embed|input)\b/i;

function hasMeaningfulDirectText(text) {
  const stripped = String(text || '')
    .replace(/&nbsp;|&#160;|&#xa0;|&#8203;|&#x200b;/gi, '')
    .replace(/\s+/g, '');
  return stripped.length > 0 && hasVisibleText(stripped);
}

function hasDirectVisibleText(inner) {
  const tokenRe = /<!--[\s\S]*?-->|<[^>]+>|[^<]+/g;
  let blockDepth = 0;
  let token;
  while ((token = tokenRe.exec(String(inner || ''))) !== null) {
    const part = token[0];
    if (part.startsWith('<!--')) continue;
    if (part.startsWith('<')) {
      const tag = /^<\s*(\/?)\s*([a-z][\w:-]*)\b[^>]*>/i.exec(part);
      if (!tag || !CELL_BLOCK_TAG_RE.test(tag[2])) continue;
      if (tag[1]) blockDepth = Math.max(0, blockDepth - 1);
      else if (!/\/\s*>$/.test(part)) blockDepth += 1;
      continue;
    }
    if (blockDepth === 0 && hasMeaningfulDirectText(part)) return true;
  }
  return false;
}

function findDirectTextCellStarts(html) {
  const pairs = [];
  const stack = [];
  const tagRe = /<(\/?)\s*(td|th)\b([^>]*)>/gi;
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    const closing = Boolean(match[1]);
    if (!closing) {
      stack.push({ start: match.index, openEnd: tagRe.lastIndex });
      continue;
    }
    const frame = stack.pop();
    if (frame) pairs.push({ ...frame, closeStart: match.index });
  }
  return new Map(
    pairs
      .map((pair) => ({ ...pair, inner: html.slice(pair.openEnd, pair.closeStart) }))
      .filter((pair) => hasDirectVisibleText(pair.inner))
      .map((pair) => [pair.start, INLINE_ORDER_MEDIA_RE.test(pair.inner)])
  );
}

function addRtlToDirectTextCells(html, opts = {}) {
  const marked = findDirectTextCellStarts(html);
  return html.replace(/<(td|th)\b([^>]*)>/gi, (match, tag, attrs, offset) => {
    if (!marked.has(offset)) return match;
    const preserveInlineOrder = opts.preserveInlineOrder !== false && marked.get(offset);
    const next = ensureTextAlignRightIfMissing(preserveInlineOrder ? attrs : withDirRtl(attrs));
    return `<${tag}${next}>`;
  });
}

/* ─── Text-block elements: p / h* / li / leaf div get text-align right ─── */

/**
 * Add dir="rtl" + text-align: right (if missing) on text-block elements.
 * In safe text mode, mixed text/media blocks receive alignment only: adding
 * `dir` there can reorder an inline image relative to the copy.
 * These are block-level — they don't affect inline-block sibling flow,
 * so it's safe to put dir on them without flipping multi-card grids.
 *
 * Why dir matters here: when a paragraph mixes RTL prose with LTR
 * placeholders like `{{Level_Name}}`, the browser's auto-bidi can
 * place punctuation in unexpected spots. Explicit dir="rtl" keeps
 * the paragraph anchored as an RTL block.
 */
function findTextBlockStartsWithInlineMedia(html) {
  const marked = new Set();
  const stack = [];
  const tagRe = /<(\/?)\s*(p|h[1-6]|li)\b([^>]*)>/gi;
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    if (!match[1]) {
      stack.push({ tag: match[2].toLowerCase(), start: match.index, openEnd: tagRe.lastIndex });
      continue;
    }
    const tag = match[2].toLowerCase();
    let frame = null;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index].tag === tag) {
        frame = stack[index];
        stack.length = index;
        break;
      }
    }
    if (frame && INLINE_ORDER_MEDIA_RE.test(html.slice(frame.openEnd, match.index))) {
      marked.add(frame.start);
    }
  }
  return marked;
}

function addRtlAndAlignToPHLi(html, opts = {}) {
  const mediaBlocks = findTextBlockStartsWithInlineMedia(html);
  return html.replace(/<(p|h[1-6]|li)\b([^>]*)>/gi,
    (_m, tag, attrs, offset) => {
      const preserveInlineOrder = opts.preserveInlineOrder !== false && mediaBlocks.has(offset);
      return `<${tag}${ensureTextAlignRightIfMissing(preserveInlineOrder ? attrs : withDirRtl(attrs))}>`;
    });
}

function isSpacerDivContent(inner) {
  const stripped = String(inner || '')
    .replace(/<br\s*\/?>/gi, '')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '');
  return stripped.length === 0;
}

/**
 * Leaf div = a <div> whose direct content has NO block children
 * (p, h*, li, div, table). When such a leaf carries visible text
 * (i.e. not a pure spacer) we mark it RTL: `dir="rtl"` so any
 * placeholder / mixed-direction text bidi-resolves correctly inside
 * the card or text block, and `text-align: right` if no alignment
 * was declared.
 *
 * Mixed text/media leaves are alignment-only in safe text mode so the media
 * keeps its authored source order. Cards in modern email templates often nest a leaf <div> with text
 * directly inside a table cell (instead of a <p>) — without dir
 * here, that inner block keeps LTR bidi order.
 */
function addRtlToLeafDivs(html, opts = {}) {
  return html.replace(/<div\b([^>]*)>([\s\S]*?)<\/div>/gi, (m, attrs, inner) => {
    if (/<(?:p|h[1-6]|li|div|table)\b/i.test(inner)) return m;
    if (!hasVisibleText(inner)) return m;
    if (isSpacerDivContent(inner)) return m;
    const preserveInlineOrder = opts.preserveInlineOrder !== false && INLINE_ORDER_MEDIA_RE.test(inner);
    let next = preserveInlineOrder ? attrs : withDirRtl(attrs);
    next = ensureTextAlignRightIfMissing(next);
    return `<div${next}>${inner}</div>`;
  });
}

/* ─── Button cells (<td class="butt…">): keep dir="rtl" so Arabic
 *     text inside the link reads correctly. This is also an
 *     "innermost" cell semantically — its only child is the link. */

/**
 * Mark deep text-bearing <td> cells for dir="rtl".
 *
 * Rationale: putting dir on a wrapping <td> (like center bg-col or
 * container) makes the whole email lean right. Putting it ONLY on
 * inner text wrappers (typically nesting 3+ td deep — body > center >
 * container > row > td.wrapper > td.columns > td.text) reads RTL
 * without touching the outer layout. We also skip cells that contain
 * inline-block sibling divs (multi-card grids), because dir on those
 * still flips child order.
 *
 *   - depthRequired: how many <td> ancestors the cell must have. 2 by
 *     default — i.e. the cell itself is the 3rd nested td or deeper.
 */
function addRtlToDeepTextTd(html, opts = {}) {
  const depthRequired = typeof opts.depthRequired === 'number' ? opts.depthRequired : 2;
  const marked = new Set();

  // Walk tokens to track td-depth and remember each cell's open offset.
  const tagRe = /<(\/?)(td|th|table|tr|tbody|thead|tfoot|center)\b([^>]*)>/gi;
  const tdStack = []; // [{ start, attrs, depth }]
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'td' || tag === 'th') {
      if (!closing) {
        tdStack.push({ start: m.index, attrs: m[3] || '', depthOnEntry: tdStack.length });
      } else {
        tdStack.pop();
      }
    }
  }

  // Re-walk to actually inspect each td's content range.
  // Cheaper: collect all td open/close pairs first via balanced scan.
  const pairs = [];
  const stack2 = [];
  tagRe.lastIndex = 0;
  while ((m = tagRe.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag !== 'td' && tag !== 'th') continue;
    if (!closing) {
      stack2.push({ start: m.index, openEnd: tagRe.lastIndex, attrs: m[3] || '', depth: stack2.length });
    } else {
      const frame = stack2.pop();
      if (!frame) continue;
      pairs.push({ start: frame.start, openEnd: frame.openEnd, closeStart: m.index, attrs: frame.attrs, depth: frame.depth });
    }
  }

  for (const p of pairs) {
    if (p.depth < depthRequired) continue;
    const inner = html.slice(p.openEnd, p.closeStart);
    // Skip if inner contains inline-block sibling divs — those are card
    // grids and dir on the parent flips their visual order.
    if (/<div\b[^>]*\bstyle\s*=\s*["'][^"']*\bdisplay\s*:\s*inline-block\b/i.test(inner)) continue;
    // Skip if no meaningful text inside.
    if (!hasVisibleText(inner)) continue;
    // Skip cells whose only direct children are nested <table>s (layout).
    const stripped = inner
      .replace(/<(?:table|center)\b[\s\S]*?<\/(?:table|center)>/gi, '')
      .replace(/&nbsp;|&#160;|&#xa0;/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, '');
    if (!stripped) continue;
    marked.add(p.start);
  }

  return html.replace(/<(td|th)\b([^>]*)>/gi, (m, tag, attrs, offset) => {
    if (!marked.has(offset)) return m;
    let next = withDirRtl(attrs);
    next = ensureTextAlignRightIfMissing(next);
    return `<${tag}${next}>`;
  });
}

function addDirToButtCells(html) {
  return html.replace(/<(td|th)\b([^>]*)>/gi, (m, tag, attrs) => {
    if (!hasClassToken(attrs, /^butt(?:[-_].*)?$/i)) return m;
    return `<${tag}${withDirRtl(attrs)}>`;
  });
}

/* ─── Two-column content rows: mirror td order for RTL ─────────── */
/**
 * The numbered-list / icon-row pattern in the IQ base is a <tr> with exactly
 * two direct cells: a narrow one (class `m-w` — number/icon) and a flexible
 * one (class `w-a` — text). In RTL the narrow cell must move to the RIGHT,
 * i.e. the two tds swap places. We swap the cell markup itself (works in
 * every email client, no dir tricks) and mark the row with
 * data-rtl-swapped="1" so a re-run of the transformer is a no-op.
 */
function mirrorTwoColumnRows(html) {
  const isNarrow = (a) => hasClassToken(a, /^m-w$/i);
  const isAuto = (a) => hasClassToken(a, /^w-a$/i);
  const qualifies = (a, b) => (isNarrow(a) && isAuto(b)) || (isAuto(a) && isNarrow(b));

  const tagRe = /<(\/?)(table|tr|td|th)\b([^>]*)>/gi;
  const stack = [];
  const swaps = [];
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (!closing) {
      const frame = { tag, start: m.index, openEnd: tagRe.lastIndex, attrs: m[3] || '', tds: [] };
      if ((tag === 'td' || tag === 'th') && stack.length && stack[stack.length - 1].tag === 'tr') {
        stack[stack.length - 1].tds.push(frame);
      }
      stack.push(frame);
    } else {
      let frame = null;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) { frame = stack[i]; stack.length = i; break; }
      }
      if (!frame) continue;
      frame.closeStart = m.index;
      frame.end = tagRe.lastIndex;
      if (tag === 'tr') {
        const tds = frame.tds.filter((td) => td.end != null);
        if (
          tds.length === 2 &&
          !/\bdata-rtl-swapped\b/i.test(frame.attrs) &&
          qualifies(tds[0].attrs, tds[1].attrs)
        ) {
          swaps.push({ tr: frame, a: tds[0], b: tds[1] });
        }
      }
    }
  }
  if (!swaps.length) return html;

  // Drop any swap that contains another swap inside its row (defensive —
  // the m-w/w-a pattern does not nest, but offsets must stay valid).
  const inner = swaps.filter((s) =>
    !swaps.some((o) => o !== s && o.tr.start > s.tr.start && o.tr.end < s.tr.end));

  // Apply bottom-up so earlier offsets stay valid.
  inner.sort((x, y) => y.tr.start - x.tr.start);
  let out = html;
  for (const { tr, a, b } of inner) {
    const between = out.slice(a.end, b.start);
    const swapped = out.slice(b.start, b.end) + between + out.slice(a.start, a.end);
    out = out.slice(0, a.start) + swapped + out.slice(b.end);
    out = out.slice(0, tr.start) + `<tr data-rtl-swapped="1"${tr.attrs}>` + out.slice(tr.openEnd);
  }
  return out;
}

/* ─── Explicit legacy cleanup: stale dir="rtl" from old builds ── */
/**
 * Old versions of this transformer used to add `dir="rtl"` to layout
 * wrappers (outer <td>, <center>, layout <table>, spacer <div>, etc.).
 * If a previously-built HTML is fed through applyRtl again (which is
 * exactly what the studio preview does on every file open), the new
 * pipeline won't re-add dir on those wrappers, but the OLD dir is
 * still there in the source and makes the email fold right.
 *
 * This cleanup is intentionally NOT automatic: fresh authored markup may
 * contain a deliberate `dir="rtl"`. It runs only with
 * `{ cleanupLegacy: true }`; the subsequent pipeline then re-adds direction
 * to the safe subset. `dir="ltr"` and `dir="auto"` are always preserved.
 */
function stripStaleDirRtl(html) {
  return html.replace(/\s+dir\s*=\s*(["']?)rtl\1/gi, '');
}

/* ─── Whole-document idempotency ──────────────────────────────── */

const RTL_FRAGMENT_MARKER_RE = /<!--\s*retkit-rtl:v(?:1|2(?::(?:text|mirror|document))?)\s*-->/i;
const RTL_V2_MARKER_RE = /<!--\s*retkit-rtl:v2:(text|mirror|document)\s*-->/i;

function getAppliedRtlMode(html) {
  const marker = RTL_V2_MARKER_RE.exec(String(html || ''));
  return marker ? marker[1].toLowerCase() : '';
}

function createRtlModeConflict(appliedMode, requestedMode) {
  const error = new Error(
    `[rtl] HTML is already transformed in "${appliedMode}" mode and cannot be switched to ` +
    `"${requestedMode}" after mutation. Rebuild from clean source (Original) and apply the requested mode.`
  );
  error.code = 'RETKIT_RTL_MODE_CONFLICT';
  error.appliedMode = appliedMode;
  error.requestedMode = requestedMode;
  return error;
}

function hasRtlAppliedMarker(html) {
  return /<html\b[^>]*\bdata-retkit-rtl\s*=\s*(["']?)1\1/i.test(html)
    || RTL_FRAGMENT_MARKER_RE.test(html);
}

function looksLikeLegacyRtlOutput(html) {
  // Builds emitted before the explicit marker can still re-enter the RTL
  // pipeline through a preview endpoint. Re-running the physical-side pass on
  // such HTML toggles left/right back to LTR. These signatures are only added
  // by this transformer and are therefore safe evidence that the pass already
  // ran once.
  // data-rtl-swapped is emitted only by RetKit. A plain dir="rtl" is not
  // enough evidence: it may be deliberate source markup and must still get
  // the remaining text/CTA treatment.
  return /\bdata-rtl-swapped\s*=/i.test(html);
}

function markRtlApplied(html, mode) {
  if (hasRtlAppliedMarker(html)) return html;
  const marker = `<!--retkit-rtl:v2:${normalizeRtlMode({ mode })}-->`;
  if (/<html\b/i.test(html)) {
    // Keep the doctype first (standards mode) and avoid adding non-XHTML
    // attributes to legacy Strict email documents.
    return html.replace(/<html\b[^>]*>/i, (open) => `${open}${marker}`);
  }
  return `${marker}${html}`;
}

/* ─── Smart icon-text mirroring inside <a>/<button> ──────────── */

function smartMirrorButtonIcons(html) {
  return html.replace(
    /<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi,
    (m, tag, attrs, inner) => {
      if (!/<(?:img|svg|i\b|span\s+class=["'][^"']*\bicon)/i.test(inner)) return m;
      if (!hasVisibleText(inner)) return m;
      if (/\bdirection\s*:/i.test(attrs)) return m;
      let nextAttrs;
      if (/\bstyle\s*=/i.test(attrs)) {
        nextAttrs = attrs.replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i,
          (_full, q, body) => `style=${q}${body.replace(/\s*;?\s*$/, ';')} direction: rtl;${q}`);
      } else {
        nextAttrs = `${attrs} style="direction: rtl;"`;
      }
      return `<${tag}${nextAttrs}>${inner}</${tag}>`;
    }
  );
}

/* ─── Public entry point ────────────────────────────────────── */

/* ─── Document mode: the whole email becomes an Arabic email ─────────
 *
 * The way the retention team arabizes a finished English email by hand
 * (reference pair: tests/fixtures/rtl/photo-welcome2.*):
 *   – <html dir="rtl" lang="ar">, <body dir="rtl" style="direction: rtl; …">;
 *   – dir="rtl" on every block (table, td, th, div, p, h1–h6, li, ul, ol), so
 *     columns, cards, icons and store badges flow right-to-left by themselves;
 *   – every physical side is mirrored, inline AND in <style>: text-align
 *     left → right, padding/margin/border left ↔ right, float, the 4-value
 *     margin/padding shorthand, align="left" → "right";
 *   – nothing else moves: centered blocks stay centered, colours, sizes and
 *     text are untouched, and no cell order is swapped (dir already does it).
 * Unlike "mirror", !important declarations are mirrored too: in this mode the
 * whole email is the RTL version, so an LTR-only !important is not intent.
 */
const DOC_BLOCK_TAGS = /^(?:table|td|th|div|p|h[1-6]|li|ul|ol)$/i;

function swapFourValueShorthand(css) {
  return css.replace(/\b(margin|padding)\s*:\s*([^;}\n]+)/gi, (match, prop, value) => {
    const important = /\s*!\s*important\s*$/i.test(value) ? ' !important' : '';
    const parts = value.replace(/\s*!\s*important\s*$/i, '').trim().split(/\s+/);
    if (parts.length !== 4 || parts[1] === parts[3]) return match;
    return `${prop}: ${parts[0]} ${parts[3]} ${parts[2]} ${parts[1]}${important}`;
  });
}

function mirrorCssForDocument(css) {
  if (!css) return css;
  const L = '\x00DL\x00';
  const R = '\x00DR\x00';
  let out = css.replace(/\b(text-align\s*:\s*)(left|start)\b/gi, (_m, head) => `${head}right`);
  out = out.replace(/\bfloat\s*:\s*(left|right)\b/gi, (_m, v) => `float: ${v.toLowerCase() === 'left' ? R : L}`);
  out = out.replace(/\b(padding|margin|border)-(left|right)(?=\s*:|-(?:width|style|color)\s*:)/gi,
    (_m, prop, side) => `${prop}-${side.toLowerCase() === 'left' ? R : L}`);
  out = out.replace(/\b(left|right)(\s*:\s*[^;}\n]+)/gi, (m, side, rest, offset, all) => {
    // Absolute offsets (left: 10px) — only as a standalone property.
    const before = all.slice(Math.max(0, offset - 1), offset);
    if (before && /[\w-]/.test(before)) return m;
    return `${side.toLowerCase() === 'left' ? R : L}${rest}`;
  });
  out = out.replace(new RegExp(L, 'g'), 'left').replace(new RegExp(R, 'g'), 'right');
  out = swapFourValueShorthand(out);
  // background-position keywords, reusing the mirror pass logic.
  out = out.replace(/\bbackground(-position)?\s*:\s*([^;}\n]+)/gi, (match, longhand, value) => {
    if (!/\b(?:left|right)\b/.test(value.replace(/url\([^)]*\)/g, ''))) return match;
    const swapped = value.replace(/(url\([^)]*\))|\bleft\b|\bright\b/g,
      (m, urlPart) => (urlPart ? urlPart : (m === 'left' ? R : L)));
    return `background${longhand || ''}: ${swapped}`;
  });
  return out.replace(new RegExp(L, 'g'), 'left').replace(new RegExp(R, 'g'), 'right');
}

function setAttr(attrs, name, value, { overwrite = false } = {}) {
  const re = new RegExp(`\\s${name}\\s*=\\s*(["'])[\\s\\S]*?\\1|\\s${name}\\s*=\\s*[^\\s"'>]+`, 'i');
  if (re.test(attrs)) return overwrite ? attrs.replace(re, ` ${name}="${value}"`) : attrs;
  return ` ${name}="${value}"${attrs}`;
}

function applyDocumentRtl(html, opts = {}) {
  const lang = String(opts.lang || 'ar').replace(/[^a-zA-Z_-]/g, '').replace('_', '-') || 'ar';
  let out = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open, css, close) => `${open}${mirrorCssForDocument(css)}${close}`);
  out = out.replace(/<([a-z][\w:-]*)([^>]*)>/gi, (m, tag, attrs) => {
    if (/^(?:style|script)$/i.test(tag)) return m;
    let next = attrs;
    if (/\bstyle\s*=/i.test(next)) {
      next = next.replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i, (_f, q, body) => `style=${q}${mirrorCssForDocument(body)}${q}`);
    }
    if (/\balign\s*=/i.test(next)) next = flipAlignAttr(next).replace(/\balign\s*=\s*(["']?)right\1(?![\s\S]*\balign=)/i, 'align="right"');
    const lower = tag.toLowerCase();
    if (lower === 'html') {
      next = setAttr(next, 'lang', lang, { overwrite: true });
      next = setAttr(next, 'dir', 'rtl', { overwrite: true });
    } else if (lower === 'body') {
      next = setAttr(next, 'dir', 'rtl', { overwrite: true });
      if (/\bstyle\s*=/i.test(next)) {
        if (!/\bdirection\s*:/i.test(next)) next = next.replace(/\bstyle\s*=\s*(["'])/i, (f) => `${f}direction: rtl; `);
      } else next = `${next} style="direction: rtl;"`;
    } else if (DOC_BLOCK_TAGS.test(lower)) {
      next = setAttr(next, 'dir', 'rtl');
    }
    return next === attrs ? m : `<${tag}${next}>`;
  });
  // The marker goes after the opening <html> (doctype stays first).
  return markRtlApplied(out, 'document');
}

function applyRtl(html, opts = {}) {
  if (!html || typeof html !== 'string') return html;
  const mode = normalizeRtlMode(opts);
  const appliedMode = getAppliedRtlMode(html);
  if (appliedMode) {
    if (appliedMode === mode) return html;
    throw createRtlModeConflict(appliedMode, mode);
  }
  // v1/data-retkit-rtl had no mode metadata. A second pass cannot safely
  // infer whether physical sides were already swapped, so require Original.
  if (hasRtlAppliedMarker(html)) throw createRtlModeConflict('legacy/unknown', mode);
  if (looksLikeLegacyRtlOutput(html)) {
    if (mode !== 'mirror') throw createRtlModeConflict('mirror', mode);
    return markRtlApplied(html, 'mirror');
  }
  if (mode === 'document') return applyDocumentRtl(html, opts);
  let out = html;

  // Legacy cleanup is explicit. Unmarked dir="rtl" in a fresh source can be
  // author intent, so silently stripping it is not safe.
  if (opts && typeof opts === 'object' && opts.cleanupLegacy === true) {
    out = stripStaleDirRtl(out);
  }

  // By the time RTL runs, inline-css has copied framework selectors onto
  // body/table/td/img. Global inline passes therefore still move the whole
  // email even when <head> is preserved. They are opt-in only.
  if (mode === 'mirror') {
    out = flipAllInlineStyles(out);
    out = swapPhysicalSidesOnAllTags(out);
    out = flipAlignOnAllTags(out);
  }

  // 4) Button shells: force align="right" (no dir).
  out = alignButtonShellsRight(out);

  // 4.5) Numbered/icon two-column rows (td.m-w + td.w-a): swap cell
  //      order so the number/icon column sits on the RIGHT in RTL.
  if (mode === 'mirror') out = mirrorTwoColumnRows(out);

  // 5) p / h* / li: add dir="rtl" + text-align: right (if missing).
  //    In text mode, mixed text/media blocks get alignment without dir so an
  //    inline image keeps its authored position.
  out = addRtlAndAlignToPHLi(out, { preserveInlineOrder: mode !== 'mirror' });

  // 6) leaf <div> with real text: add dir="rtl" + text-align: right.
  //    "Leaf" = no block children (p/h*/li/div/table) inside; mixed
  //    text/media leaves keep source order in text mode.
  out = addRtlToLeafDivs(out, { preserveInlineOrder: mode !== 'mirror' });

  // 6.5) Plain text directly inside a td/th (possibly wrapped only by inline
  //      tags) needs direction too. Structural cells containing nested block
  //      layout remain byte-for-byte untouched.
  out = addRtlToDirectTextCells(out, { preserveInlineOrder: mode !== 'mirror' });

  // The broad depth-based td pass is intentionally not invoked. The precise
  // direct-text pass above covers unwrapped copy while keeping layout cells,
  // card grids and nested table structure free from direction changes.

  // 7) Button cells get dir="rtl" so localized link text reads RTL.
  out = addDirToButtCells(out);

  //   Also note: the previous addRtlToInnermostTextTd pass caused
  //   multi-card grids (inline-block sibling divs) to render in
  //   reversed order. With dir living only on the block text
  //   elements above, card source order is preserved.

  // 8) Icon-in-button visual order flip (opt-out via opts.smart === false).
  if (mode === 'mirror' && opts.smart !== false) {
    out = smartMirrorButtonIcons(out);
  }

  return markRtlApplied(out, mode);
}

module.exports = { isRtlLocale, applyRtl };

  root.RetKitRtlCore = module.exports;
})(typeof globalThis !== 'undefined' ? globalThis : this);
