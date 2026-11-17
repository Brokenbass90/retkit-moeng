/*! RetKit locale-lint — one locale checker for every RetKit tool
 *  (RetKit for MoEngage, Retention Future Studio, agent tools over MCP).
 *  Pure logic, no DOM, no network, no keys. Source of truth:
 *  retkit-moeng/src/shared/locale-lint.js (Studio keeps a byte-identical copy).
 *
 *  What it catches in every locale, against the reference locale (en):
 *   error  empty          — block is blank while the reference has text
 *   error  missing_block  — locale has fewer/more blocks than the reference
 *   error  var_mismatch   — {{variables}} differ from the reference
 *   error  markup         — @@bold@@ markers broken or differ from the reference
 *   error  placeholder    — raw draft junk: lorem ipsum, TODO, TBD, XXX, ???, [text], "title here"…
 *   error  mojibake       — broken encoding: Ã©, â€™, �
 *   error  gibberish      — keyboard mash / vowel-less words / ###~~~ instead of text
 *   error  untranslated   — text is the reference text, letter for letter
 *   error  wrong_script   — letters are not of the locale's alphabet (ar, ru, th, ja…)
 *   error  wrong_lang     — whole locale is written in another language
 *   warn   wrong_lang     — a close language (es/pt, id/ms, no/sv, ru/uk, ar/ur) or one long block
 *   warn   length         — translation is several times longer/shorter than the reference
 *
 *  Language detection: the trigram method of franc (MIT © Titus Wormer) with
 *  its models trimmed to RetKit locales (locale-lint-data.js). Short strings
 *  carry no language signal, so language is judged on long blocks and on the
 *  whole locale; alphabets are judged on any block with enough letters.
 *
 *  API (root.RetKitLocaleLint):
 *   lint({ locales: {code: string[]}, refCode?, mode?: 'txt'|'html', keep?: string[] }) → result
 *   lintHtml({ htmlByLocale: {code: html}, refCode?, keep? }) → result   (MoEngage: one HTML per locale)
 *   textsFromHtml(html) → string[]
 *   format(result, { detail?: 'summary'|'errors'|'all', locale?, limit? }) → compact text for agents
 *   langOf(code) → { code, base, lang, script } | null
 *   detect(text, candidates?) → [[lang, score], …]
 *   fingerprint(locales) → string
 */
(function (root) {
  'use strict';

  const VERSION = '1.0.0';

  // locale base code → franc language (null: alphabet alone identifies it) + alphabet
  const LANGS = {
    en: ['eng', 'Latin'], de: ['deu', 'Latin'], es: ['spa', 'Latin'], fr: ['fra', 'Latin'],
    it: ['ita', 'Latin'], nl: ['nld', 'Latin'], no: ['nob', 'Latin'], nb: ['nob', 'Latin'],
    se: ['swe', 'Latin'], sv: ['swe', 'Latin'], tr: ['tur', 'Latin'], id: ['ind', 'Latin'],
    ms: ['zlm', 'Latin'], tl: ['tgl', 'Latin'], fil: ['tgl', 'Latin'], vi: ['vie', 'Latin'],
    az: ['azj', 'Latin'], pt: ['por', 'Latin'], ru: ['rus', 'Cyrillic'], uk: ['ukr', 'Cyrillic'],
    ar: ['arb', 'Arabic'], ur: ['urd', 'Arabic'], hi: ['hin', 'Devanagari'], bn: [null, 'Bengali'],
    th: [null, 'Thai'], ja: [null, 'Japanese'], ko: [null, 'Hangul'], zh: [null, 'Han'], cn: [null, 'Han'],
    ge: [null, 'Georgian'], ka: [null, 'Georgian'],
    hl: [null, 'Latin'], // Hinglish: Hindi in Latin letters — alphabet only, no trigram model
  };
  // MoEngage shows languages by name in some campaigns
  const NAMES = {
    english: 'en', german: 'de', deutsch: 'de', spanish: 'es', espanol: 'es', french: 'fr', italian: 'it',
    dutch: 'nl', norwegian: 'no', swedish: 'se', turkish: 'tr', indonesian: 'id', malay: 'ms',
    tagalog: 'tl', filipino: 'tl', vietnamese: 'vi', azerbaijani: 'az', portuguese: 'pt', russian: 'ru',
    ukrainian: 'uk', arabic: 'ar', urdu: 'ur', hindi: 'hi', bengali: 'bn', bangla: 'bn', thai: 'th',
    japanese: 'ja', korean: 'ko', chinese: 'zh', georgian: 'ka',
  };
  // Languages that share most trigrams: a mix-up between them is only a warning.
  const CLOSE = [['spa', 'por'], ['ind', 'zlm'], ['nob', 'swe'], ['rus', 'ukr'], ['arb', 'urd'], ['tur', 'azj']];
  const SCRIPT_RE = {
    Latin: /\p{Script=Latin}/gu, Cyrillic: /\p{Script=Cyrillic}/gu, Arabic: /\p{Script=Arabic}/gu,
    Devanagari: /\p{Script=Devanagari}/gu, Bengali: /\p{Script=Bengali}/gu, Thai: /\p{Script=Thai}/gu,
    Hangul: /\p{Script=Hangul}/gu, Han: /\p{Script=Han}/gu, Georgian: /\p{Script=Georgian}/gu,
    Kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu,
  };
  const SCRIPT_LABEL = {
    Latin: 'латиницы', Cyrillic: 'кириллицы', Arabic: 'арабских букв', Devanagari: 'деванагари',
    Bengali: 'бенгальских букв', Thai: 'тайских букв', Hangul: 'хангыля', Han: 'иероглифов',
    Japanese: 'японских знаков', Georgian: 'грузинских букв',
  };
  const LANG_LABEL = {
    eng: 'английский', deu: 'немецкий', spa: 'испанский', fra: 'французский', ita: 'итальянский',
    nld: 'нидерландский', nob: 'норвежский', swe: 'шведский', tur: 'турецкий', ind: 'индонезийский',
    zlm: 'малайский', tgl: 'тагальский', vie: 'вьетнамский', azj: 'азербайджанский', por: 'португальский',
    rus: 'русский', ukr: 'украинский', arb: 'арабский', urd: 'урду', hin: 'хинди',
  };
  // Names that stay the same in every language (brands, stores, networks).
  const DEFAULT_KEEP = [
    'IQ Option', 'IQ Broker', 'IQOption', 'IQ', 'MoEngage',
    'App Store', 'Google Play', 'AppGallery', 'Apple', 'Android', 'iOS', 'iPhone', 'Windows', 'macOS',
    'Instagram', 'Telegram', 'Facebook', 'YouTube', 'TikTok', 'WhatsApp', 'LinkedIn', 'Twitter', 'Discord', 'Viber',
    'Visa', 'Mastercard', 'PayPal', 'Skrill', 'Neteller', 'Bitcoin', 'Ethereum', 'USDT',
  ];

  // Thresholds (calibrated on the Studio email base: 0 errors on shipped locales).
  const T = {
    scriptBlockMin: 8,       // letters in a block before its alphabet is judged (non-Latin locales: brands stay Latin)
    latinBlockMin: 3,        // same for Latin locales
    scriptBlockShare: 0.25,  // non-Latin locale: below this share of own letters → error
    latinForeignShare: 0.5,  // Latin locale: above this share of foreign letters → error
    langLocaleMin: 60,       // letters in a whole locale before its language is judged
    langBlockMin: 60,        // letters in one block before its language is judged
    langMargin: 0.02,        // expected language must lose by more than this
    untranslatedMin: 10,     // letters (and ≥ 2 words) before "same as reference" counts
    lengthMin: 25,           // reference chars before length ratio counts
  };

  // ---------- text helpers ----------

  const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', euro: '€', zwnj: '', zwj: '', shy: '' };
  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return Number.isFinite(n) ? String.fromCodePoint(n) : m; } catch { return m; }
      }
      const v = ENTITIES[e.toLowerCase()];
      return v === undefined ? m : v;
    });
  }

  const VAR_RE = /\$\{\{[\s\S]*?\}\}\$|\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|%%[\w.-]+%%/g;
  // Locale suffix inside a MoEngage content block name: ContentBlock['iq_risk_warning_noreg_EN'] / …_ES_ES'].
  const BLOCK_LOCALE_RE = /[_-]([A-Za-z]{2})(?:[_-][A-Za-z]{2})?(?=['"]\s*\])/;
  // Variables compare without whitespace and without that suffix: _EN in en and _FR in fr are the same block.
  function varsOf(text) {
    return (String(text || '').match(VAR_RE) || []).map((v) => v.replace(/\s+/g, '').replace(BLOCK_LOCALE_RE, ''));
  }
  // Studio placeholder ${{ ns.block_NN }}$ left in text = the locale text never arrived.
  const UNRESOLVED_RE = /\$\{\{\s*[\w.-]+\s*\}\}\$/;
  /** Content blocks of the reference language used in another locale (…_EN inside FR). */
  function foreignBlocks(text, refBase, ownBase) {
    if (!refBase || !ownBase || refBase === ownBase) return [];
    return (String(text || '').match(VAR_RE) || []).filter((v) => {
      const m = v.match(BLOCK_LOCALE_RE);
      return m && m[1].toLowerCase() === refBase;
    });
  }

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Text a reader actually reads: no variables, links, tokens, markers, brand names.
  function plain(text, keepRe) {
    let s = decodeEntities(String(text || ''));
    s = s.replace(VAR_RE, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ' ')
      .replace(/\b[a-z_]+(?:\.[a-z_]+)+\b/gi, ' ') // embedded.brand_name
      .replace(/@@/g, ' ');
    if (keepRe) s = s.replace(keepRe, ' ');
    return s.replace(/\s+/g, ' ').trim();
  }

  function letters(s) { return (String(s).match(/\p{L}/gu) || []).length; }
  function count(s, script) {
    if (script === 'Japanese') return count(s, 'Kana') + count(s, 'Han');
    const re = SCRIPT_RE[script];
    if (!re) return 0;
    re.lastIndex = 0;
    return (String(s).match(re) || []).length;
  }
  function words(s) { return String(s).split(/\s+/).filter((w) => /\p{L}/u.test(w)).length; }
  function norm(s) { return decodeEntities(String(s || '')).replace(/\s+/g, ' ').trim().toLowerCase(); }
  function sample(s, n = 40) {
    const t = decodeEntities(String(s || '')).replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  }

  const JUNK = [
    [/lorem\s+ipsum|dolor\s+sit\s+amet|consectetur\s+adipiscing/i, 'lorem ipsum'],
    [/(^|[^\p{L}])(TODO|TBD|FIXME|XXX+|PLACEHOLDER)(?=$|[^\p{L}])/u, 'служебная пометка'],
    [/\?{3,}/, '???'],
    [/\[\s*(?:text|title|link|insert|placeholder|translate|translation|copy|cta|button|name|текст|перевод)[^\]]*\]/i, 'шаблон в скобках'],
    [/\b(?:your\s+)?(?:text|title|subtitle|heading|headline|button|copy|description)\s+(?:goes\s+)?here\b/i, '«… here»'],
    [/\b(?:sample|dummy|test)\s+(?:text|copy|title)\b/i, 'тестовый текст'],
    [/\b(?:title|subtitle|heading|headline|button|note|link|lead|body|caption|cta|label|step\s+\w+)\s+text\b/i, 'шаблонный текст'],
    [/(?:^|[^\p{L}])(?:текст|заголовок|подзаголовок|кнопка)\s+(?:здесь|тут)(?=$|[^\p{L}])/iu, '«текст здесь»'],
    [/\{\{(?![\s\S]*\}\})|(?<!\{\{[\s\S]*)\}\}/, 'незакрытая переменная'],
  ];
  function junkIn(text) {
    const raw = decodeEntities(String(text || ''));
    for (const [re, label] of JUNK) if (re.test(raw)) return label;
    return '';
  }
  // Набор букв вместо текста: «dfgdfg», «zxcvb», «фывапро» — слово без гласных
  // из 6+ букв или кусок раскладки. Только латиница и кириллица (там это видно надёжно).
  const KEYBOARD_RE = /(?:qwer|wert|erty|asdf|sdfg|dfgh|fghj|ghjk|hjkl|zxcv|xcvb|cvbn|vbnm|йцук|цуке|укен|фыва|ывап|вапр|апро|ячсм|чсми|смит)/i;
  const VOWELS_RE = /[aeiouyаеёиоуыэюяіїєaeiouy]/i;
  function gibberishIn(text, info) {
    if (!info || !['Latin', 'Cyrillic'].includes(info.script)) return '';
    const words = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[\p{L}]+/gu) || [];
    const own = info.script === 'Latin' ? /^\p{Script=Latin}+$/u : /^\p{Script=Cyrillic}+$/u;
    for (const w of words) {
      if (!own.test(w)) continue; // чужой алфавит — это уже wrong_script
      if (w.length >= 4 && KEYBOARD_RE.test(w)) return `набор букв «${w}»`;
      if (w.length >= 6 && !VOWELS_RE.test(w) && !/^[A-Z]+$/.test(w)) return `набор букв «${w}»`;
      if (/(\p{L})\1{3,}/u.test(w)) return `повтор букв «${w}»`;
    }
    return '';
  }
  // Мусорные символы: ###, $$$, ~~~, <<<>>> посреди текста.
  function symbolJunk(text) {
    const t = String(text).replace(VAR_RE, ' ');
    const junk = (t.match(/[#$%^&*~|\\<>_=+{}[\]]/g) || []).length;
    return junk >= 4 && junk / Math.max(1, t.replace(/\s+/g, '').length) > 0.15 ? 'мусорные символы' : '';
  }

  const MOJIBAKE_RE = /�|Ã[\u0080-¿]|â€[\u0080-¿™œ“”˜]|Ð[\u0080-¿]|Ñ[\u0080-\u008F]|Ø[ -¿]|Ù[\u0080-\u008A]/;

  // ---------- language detection (franc's algorithm, trimmed models) ----------

  let MODELS = null; // script → lang → { trigram: rank }
  function models() {
    if (MODELS) return MODELS;
    const data = root.RetKitLocaleLintData?.models || {};
    MODELS = {};
    for (const [script, langs] of Object.entries(data)) {
      MODELS[script] = {};
      for (const [lang, model] of Object.entries(langs)) {
        const list = String(model).split('|');
        const ranks = {};
        for (let i = list.length - 1; i >= 0; i -= 1) ranks[list[i]] = i;
        MODELS[script][lang] = ranks;
      }
    }
    return MODELS;
  }
  function trigramTuples(value) {
    const clean = String(value).replace(/[!-@]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const padded = ` ${clean} `;
    const dict = {};
    for (let i = 0; i + 3 <= padded.length; i += 1) {
      const g = padded.slice(i, i + 3);
      dict[g] = (dict[g] || 0) + 1;
    }
    return Object.entries(dict).sort((a, b) => a[1] - b[1]);
  }
  function scriptOfLang(lang) {
    for (const [script, langs] of Object.entries(models())) if (langs[lang]) return script;
    return '';
  }
  /** [[lang, score 0..1]] best first; candidates limit the race to these languages. */
  function detect(text, candidates) {
    const value = String(text || '').slice(0, 2048);
    if (!value) return [];
    const all = models();
    let best = ''; let bestCount = 0;
    for (const script of Object.keys(all)) {
      const c = count(value, script);
      if (c > bestCount) { best = script; bestCount = c; }
    }
    if (!best) return [];
    const tuples = trigramTuples(value);
    const pool = Object.entries(all[best]).filter(([lang]) => !candidates || candidates.includes(lang));
    if (!pool.length) return [];
    const out = pool.map(([lang, ranks]) => {
      let distance = 0;
      for (const [g, n] of tuples) {
        let d = 300;
        if (g in ranks) { d = n - ranks[g] - 1; if (d < 0) d = -d; }
        distance += d;
      }
      return [lang, distance];
    }).sort((a, b) => a[1] - b[1]);
    const min = out[0][1];
    const max = value.length * 300 - min;
    return out.map(([lang, d]) => [lang, max > 0 ? 1 - (d - min) / max : 1]);
  }

  // ---------- locale identity ----------

  function langOf(code) {
    const raw = String(code || '').trim();
    if (!raw) return null;
    const lower = raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const base = NAMES[lower] || lower.split(/[_\-\s(]/)[0];
    const hit = LANGS[base];
    if (!hit) return { code: raw, base, lang: null, script: null };
    return { code: raw, base, lang: hit[0], script: hit[1] };
  }
  function isClose(a, b) { return CLOSE.some(([x, y]) => (x === a && y === b) || (x === b && y === a)); }

  // ---------- checks ----------

  function issue(locale, block, code, severity, message, text) {
    const out = { locale, block, code, severity, message };
    if (text !== undefined && text !== null && String(text).trim()) out.sample = sample(text);
    return out;
  }

  function scriptProblem(text, info) {
    if (!info?.script) return '';
    // One all-caps Latin word (PROMOCODE, BONUS50) is a code, not a sentence.
    if (info.script !== 'Latin' && /^[A-Z0-9][A-Z0-9_-]*$/.test(String(text).trim())) return '';
    const n = letters(text);
    // Latin locale: even a short word in Greek/Cyrillic/Arabic letters is wrong.
    if (n < (info.script === 'Latin' ? T.latinBlockMin : T.scriptBlockMin)) return '';
    if (info.script === 'Latin') {
      const foreign = n - count(text, 'Latin');
      if (foreign >= 3 && foreign / n <= T.latinForeignShare) return `чужие буквы (${foreign}) в латинском тексте`;
      return foreign / n > T.latinForeignShare ? `латиницы ${Math.round(100 * (n - foreign) / n)}%` : '';
    }
    const own = count(text, info.script);
    return own / n < T.scriptBlockShare ? `${SCRIPT_LABEL[info.script]} ${Math.round(100 * own / n)}%` : '';
  }

  function langProblem(text, info, minLetters) {
    if (!info?.lang) {
      // alphabet-only languages: Japanese must have kana, Chinese must not be mostly kana
      const n = letters(text);
      if (n < minLetters) return null;
      if (info?.script === 'Japanese' && count(text, 'Kana') === 0 && count(text, 'Han') / n > 0.6) return { found: 'китайский', close: true };
      if (info?.script === 'Han' && count(text, 'Kana') / n > 0.15) return { found: 'японский', close: true };
      return null;
    }
    if (letters(text) < minLetters) return null;
    const script = scriptOfLang(info.lang);
    if (count(text, script) / Math.max(1, letters(text)) < 0.5) return null; // alphabet check owns this case
    const candidates = Object.keys(models()[script] || {});
    const ranked = detect(text, candidates);
    if (!ranked.length || ranked[0][0] === info.lang) return null;
    const mine = ranked.find(([lang]) => lang === info.lang);
    if (mine && ranked[0][1] - mine[1] <= T.langMargin) return null;
    return { found: LANG_LABEL[ranked[0][0]] || ranked[0][0], lang: ranked[0][0], close: isClose(ranked[0][0], info.lang) };
  }

  function pickRef(codes, refCode) {
    if (refCode && codes.includes(refCode)) return refCode;
    return codes.find((c) => /^en$/i.test(c)) || codes.find((c) => /^en(?:$|[_-])/i.test(c)) || codes.find((c) => langOf(c)?.lang === 'eng')
      || codes.find((c) => /^default$/i.test(c)) || codes[0];
  }

  /**
   * @param {{locales: Record<string,string[]|object>, refCode?: string, mode?: 'txt'|'html', keep?: string[]}} opts
   */
  function lint({ locales = {}, refCode, mode = 'txt', keep } = {}) {
    const codes = Object.keys(locales || {}).filter((c) => locales[c] && typeof locales[c] === 'object');
    if (!codes.length) return { ok: true, version: VERSION, refCode: null, locales: {}, issues: [], summary: 'нет локалей' };
    const ref = pickRef(codes, refCode);
    const keepList = [...DEFAULT_KEEP, ...(Array.isArray(keep) ? keep : [])].filter(Boolean).sort((a, b) => b.length - a.length);
    const keepRe = new RegExp(`(?:^|(?<=[^\\p{L}]))(?:${keepList.map(escapeRe).join('|')})(?=$|[^\\p{L}])`, 'giu');
    const refEntries = entriesOf(locales[ref]);
    const refBlocks = refEntries.map(([, t]) => t);
    const refMap = new Map(refEntries);
    const keyed = !Array.isArray(locales[ref]);
    let refInfo = langOf(ref);
    if (!refInfo?.lang && !refInfo?.script) {
      // DEFAULT / unknown reference: take the language its text is written in
      const guess = detect(refBlocks.map((b) => plain(b, keepRe)).join(' \n '));
      if (guess.length) refInfo = { code: ref, base: ref, lang: guess[0][0], script: scriptOfLang(guess[0][0]) };
    }
    const refNormSet = new Set(refBlocks.map(norm));
    const issues = [];
    const perLocale = {};
    const refBad = new Set(); // reference blocks not in the reference language

    for (const code of [ref, ...codes.filter((c) => c !== ref)]) {
      const entries = entriesOf(locales[code]);
      const blocks = entries.map(([, t]) => t);
      const isRef = code === ref;
      const info = isRef ? refInfo : langOf(code);
      const sameLang = !isRef && info?.lang && refInfo?.lang && info.lang === refInfo.lang;
      const found = [];
      const add = (...a) => found.push(issue(code, ...a));
      const flagged = new Set();
      const broken = new Set(); // empty / junk / encoding / untranslated: already reported, kept out of the whole-locale check

      // structure
      if (!isRef && mode === 'txt' && keyed) {
        const have = new Set(entries.map(([id]) => id));
        for (const [id, refText] of refEntries) {
          if (!have.has(id) && letters(plain(refText, keepRe)) > 0) add(id, 'missing_block', 'error', `нет ключа, в ${ref}: «${sample(refText, 30)}»`);
        }
      }
      if (!isRef && mode === 'txt' && !keyed && blocks.length !== refBlocks.length) {
        add(null, 'missing_block', 'error', `${blocks.length} блоков, в ${ref} — ${refBlocks.length}`);
      }
      if (!isRef && mode === 'html' && refBlocks.length >= 4 && blocks.length < refBlocks.length * 0.6) {
        add(null, 'missing_block', 'error', `${blocks.length} текстовых фрагментов, в ${ref} — ${refBlocks.length}`);
      }
      if (!isRef && mode === 'html') {
        const a = varsOf(refBlocks.join('\n')).sort().join(' ');
        const b = varsOf(blocks.join('\n')).sort().join(' ');
        if (a !== b) {
          const missing = diff(varsOf(refBlocks.join('\n')), varsOf(blocks.join('\n')));
          const extra = diff(varsOf(blocks.join('\n')), varsOf(refBlocks.join('\n')));
          add(null, 'var_mismatch', 'error', [missing.length ? `нет ${missing.slice(0, 3).join(' ')}` : '', extra.length ? `лишние ${extra.slice(0, 3).join(' ')}` : ''].filter(Boolean).join('; '));
        }
      }

      entries.forEach(([i, text]) => {
        const refText = mode === 'txt' ? refMap.get(i) : undefined;
        const visible = plain(text, keepRe);
        // empty
        if (!isRef && mode === 'txt' && refText !== undefined && letters(plain(refText, keepRe)) > 0 && !text.trim()) {
          add(i, 'empty', 'error', `пусто, в ${ref}: «${sample(refText, 30)}»`); flagged.add(i); broken.add(i); return;
        }
        // junk & encoding — every locale, the reference included
        if (UNRESOLVED_RE.test(text)) {
          add(i, 'placeholder', 'error', 'плейсхолдер ${{ }}$ не подставлен — текст локали не подтянулся', text); flagged.add(i); broken.add(i);
        }
        const junk = flagged.has(i) ? '' : junkIn(text);
        if (junk) { add(i, 'placeholder', 'error', junk, text); flagged.add(i); broken.add(i); }
        if (!isRef) {
          const foreign = foreignBlocks(text, refInfo?.base, info?.base);
          if (foreign.length) add(i, 'var_mismatch', 'warn', `в локали ${code} блок для ${ref}: ${foreign[0].replace(/\s+/g, '').slice(0, 60)}`);
        }
        if (MOJIBAKE_RE.test(text)) { add(i, 'mojibake', 'error', 'сломанная кодировка', text); flagged.add(i); broken.add(i); }
        if (!flagged.has(i)) {
          const mess = gibberishIn(visible, info) || symbolJunk(text);
          if (mess) { add(i, 'gibberish', 'error', mess, text); flagged.add(i); broken.add(i); }
        }
        if (isRef) {
          // The reference must itself be in its language: an English locale with
          // Russian text is reported once here, not as "untranslated" everywhere.
          if (!flagged.has(i)) {
            const bad = scriptProblem(visible, info);
            const lp = bad ? null : langProblem(visible, info, T.langBlockMin);
            if (bad || lp) {
              add(i, bad ? 'wrong_script' : 'wrong_lang', bad ? 'error' : 'warn', bad ? `эталон: ${bad}` : `эталон похож на ${lp.found}`, text);
              refBad.add(mode === 'txt' ? i : norm(text));
            }
          }
          return;
        }
        // variables & bold markers
        if (mode === 'txt' && refText !== undefined) {
          const missing = diff(varsOf(refText), varsOf(text));
          const extra = diff(varsOf(text), varsOf(refText));
          if (missing.length || extra.length) {
            add(i, 'var_mismatch', 'error', [missing.length ? `нет ${missing.join(' ')}` : '', extra.length ? `лишние ${extra.join(' ')}` : ''].filter(Boolean).join('; '), text);
            flagged.add(i);
          }
          const marks = (text.match(/@@/g) || []).length;
          const refMarks = (refText.match(/@@/g) || []).length;
          if (marks % 2 || marks !== refMarks) { add(i, 'markup', 'error', `@@ жирный: ${marks / 2 | 0} вместо ${refMarks / 2 | 0}`, text); flagged.add(i); }
        }
        // same text as a reference block that is itself broken: reported once, in the reference
        if (!flagged.has(i) && (mode === 'txt' ? refBad.has(i) && norm(text) === norm(refText) : refBad.has(norm(text)))) {
          flagged.add(i); broken.add(i); return;
        }
        // untranslated
        if (!sameLang && !flagged.has(i)) {
          const same = mode === 'txt' ? (refText !== undefined && norm(text) === norm(refText)) : refNormSet.has(norm(text));
          if (same && letters(visible) >= T.untranslatedMin && words(visible) >= 2) {
            add(i, 'untranslated', 'error', `как в ${ref}`, text); flagged.add(i); broken.add(i); return;
          }
        }
        // alphabet
        if (!flagged.has(i)) {
          const bad = scriptProblem(visible, info);
          if (bad) { add(i, 'wrong_script', 'error', bad, text); flagged.add(i); return; }
        }
        // one long block in another language
        if (!flagged.has(i)) {
          const lp = langProblem(visible, info, T.langBlockMin);
          if (lp) { add(i, 'wrong_lang', 'warn', `похоже на ${lp.found}`, text); flagged.add(i); }
        }
        // length
        if (mode === 'txt' && refText !== undefined && !flagged.has(i)) {
          const r = plain(refText, keepRe); const t = visible;
          if (r.length >= T.lengthMin && t.length) {
            const ratio = t.length / r.length;
            const cjk = ['Han', 'Japanese', 'Hangul', 'Thai'].includes(info?.script);
            if (ratio > 3 || ratio < (cjk ? 0.15 : 0.33)) add(i, 'length', 'warn', `длина ×${ratio.toFixed(1)} к ${ref}`, text);
          }
        }
      });

      // whole-locale language and alphabet
      if (!isRef) {
        const whole = entries.filter(([i]) => !broken.has(i)).map(([, t]) => t).map((b) => plain(b, keepRe)).join(' \n ');
        const n = letters(whole);
        if (info?.script && n >= T.langLocaleMin) {
          const own = info.script === 'Latin' ? count(whole, 'Latin') : count(whole, info.script);
          if (own / n < 0.5) add(null, 'wrong_script', 'error', `во всей локали ${SCRIPT_LABEL[info.script]} ${Math.round(100 * own / n)}%`);
          else {
            const lp = langProblem(whole, info, T.langLocaleMin);
            if (lp) {
              // one locale-level verdict instead of the same warning on every long block
              for (let k = found.length - 1; k >= 0; k -= 1) if (found[k].code === 'wrong_lang') found.splice(k, 1);
              add(null, 'wrong_lang', lp.close ? 'warn' : 'error', `локаль похожа на ${lp.found}`);
            }
          }
        }
        if (!info?.script) perLocale[code] = { note: 'язык локали не известен — проверены только структура, мусор и непереведённое' };
      }

      const errors = found.filter((x) => x.severity === 'error').length;
      const warnings = found.length - errors;
      perLocale[code] = {
        ...(perLocale[code] || {}),
        status: errors ? 'error' : warnings ? 'warn' : 'ok',
        errors, warnings, blocks: blocks.length,
        ...(isRef ? { reference: true } : {}),
        lang: info?.lang || info?.script || null,
      };
      issues.push(...found);
    }

    const result = { ok: !issues.some((x) => x.severity === 'error'), version: VERSION, mode, refCode: ref, refBlocks: refBlocks.length, locales: perLocale, issues };
    result.summary = summaryLine(result);
    return result;
  }

  // [[id, text]]: arrays keep their order (id = index), keyed JSON is flattened to dotted keys
  function entriesOf(value) {
    if (Array.isArray(value)) return value.map((t, i) => [i, typeof t === 'string' ? t : String(t ?? '')]);
    const out = [];
    const walk = (v, key) => {
      if (typeof v === 'string') out.push([key, v]);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, key ? `${key}.${i}` : String(i)));
      else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], key ? `${key}.${k}` : k);
    };
    walk(value, '');
    return out;
  }

  function diff(a, b) {
    const left = new Map();
    for (const x of b) left.set(x, (left.get(x) || 0) + 1);
    const out = [];
    for (const x of a) { const c = left.get(x) || 0; if (c) left.set(x, c - 1); else out.push(x); }
    return out;
  }

  // ---------- MoEngage: one HTML per locale ----------

  const INLINE = 'a|b|strong|i|em|u|span|font|sup|sub|small|big|s|strike|mark|abbr|code|label';
  function textsFromHtml(html) {
    let s = String(html || '');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<head[\s>][\s\S]*?<\/head>/gi, ' ')
      .replace(/<(style|script|noscript|title)[\s>][\s\S]*?<\/\1>/gi, ' ')
      // Hidden service blocks (ESP unsubscribe link, Gmail fix) are not read by anyone —
      // same text in every locale on purpose. The preheader is hidden too, but it is read.
      .replace(/<div\b(?![^>]*class="[^"]*preheader)[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/div>/gi, ' ')
      .replace(/<a\b[^>]*\bdata-msys-unsubscribe\b[^>]*>[\s\S]*?<\/a>/gi, ' ');
    // alt texts are read too (images off, screen readers)
    s = s.replace(/<img\b[^>]*?\balt\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi, (m, _q, a, b) => `\u0000${a ?? b ?? ''}\u0000`);
    s = s.replace(/<br\s*\/?>/gi, ' ');
    // Links sit next to each other («Terms</a><a>Unsubscribe») — keep them apart.
    s = s.replace(/<\/?a(?:\s[^>]*)?>/gi, ' ');
    s = s.replace(new RegExp(`<\\/?(?:${INLINE})(?:\\s[^>]*)?>`, 'gi'), '');
    s = s.replace(/<[^>]*>/g, '\u0000');
    return s.split('\u0000')
      .map((t) => decodeEntities(t).replace(/[\s​-‍﻿͏]+/g, ' ').trim())
      .filter((t) => /\p{L}/u.test(t) || /\{\{|\{%/.test(t));
  }

  function lintHtml({ htmlByLocale = {}, refCode, keep } = {}) {
    const locales = {};
    for (const [code, html] of Object.entries(htmlByLocale || {})) locales[code] = textsFromHtml(html);
    return lint({ locales, refCode, mode: 'html', keep });
  }

  // ---------- output ----------

  function summaryLine(result) {
    const parts = [];
    for (const [code, s] of Object.entries(result.locales || {})) {
      if (s.reference) { parts.push(`${code}${s.errors ? ` 🔴${s.errors}` : ''}${s.warnings ? ` 🟡${s.warnings}` : ''} (эталон)`); continue; }
      parts.push(s.status === 'ok' ? `${code} ✓` : `${code}${s.errors ? ` 🔴${s.errors}` : ''}${s.warnings ? ` 🟡${s.warnings}` : ''}`);
    }
    return parts.join(' · ');
  }

  /** Compact text for agents: one summary line, then one line per issue. */
  function format(result, { detail = 'errors', locale, limit = 40 } = {}) {
    if (!result) return '';
    const head = `locale-lint ${result.version} · эталон ${result.refCode} · ${result.ok ? 'ошибок нет' : 'есть ошибки'}\n${result.summary}`;
    if (detail === 'summary') return head;
    let list = result.issues || [];
    if (locale) list = list.filter((x) => x.locale === locale);
    if (detail !== 'all') list = list.filter((x) => x.severity === 'error');
    const lines = list.slice(0, limit).map((x) => `${x.severity === 'error' ? '🔴' : '🟡'} ${x.locale} ${x.block === null || x.block === undefined ? 'локаль' : `#${x.block}`} ${x.code} ${x.message}${x.sample ? ` «${x.sample}»` : ''}`);
    if (list.length > limit) lines.push(`… ещё ${list.length - limit}`);
    const warnHint = detail !== 'all' && (result.issues || []).some((x) => x.severity === 'warn') ? '\n(🟡 предупреждения: detail=all)' : '';
    return lines.length ? `${head}\n${lines.join('\n')}${warnHint}` : head + warnHint;
  }

  function fingerprint(locales) {
    let h = 0x811c9dc5;
    const s = JSON.stringify(Object.keys(locales || {}).sort().map((k) => [k, locales[k]]));
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return `${VERSION}:${h.toString(36)}`;
  }

  const api = { VERSION, lint, lintHtml, textsFromHtml, format, langOf, detect, fingerprint, plain, thresholds: T };
  root.RetKitLocaleLint = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
