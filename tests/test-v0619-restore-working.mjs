import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');

function functionBody(name) {
  const starts = [`async function ${name}`, `function ${name}`]
    .map((needle) => source.indexOf(needle)).filter((i) => i >= 0);
  assert.ok(starts.length, `${name} should exist`);
  const start = Math.min(...starts);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (!depth) return source.slice(start, i + 1);
    }
  }
  throw new Error(`cannot parse ${name}`);
}

// Restore the proven v0.6.2 Test Campaign multi-select flow.  When all RetKit
// locales are requested it must use MoEngage's own Select all action rather
// than infer every locale from a portal fragment.
const openPopup = functionBody('openTestLocalePopup');
assert.match(openPopup, /Select all|findTestLocalePopupAction\(popup, 'Select all'\)/, 'native locale popup should expose Select all from the live portal');
assert.match(openPopup, /Clear all|findTestLocalePopupAction\(popup, 'Clear all'\)/, 'native locale popup should expose Clear all from the live portal');

const selectLocales = functionBody('selectExplicitTestLocales');
assert.match(selectLocales, /Clear all|setExactTestLocaleOptions/, 'partial selection should still be able to clear or exactly reset native state first');
assert.match(selectLocales, /wantsAll/, 'all-locales path should use native Select all');
assert.match(selectLocales, /Select all|setExactTestLocaleOptions/, 'all-locales path should use exact options or native Select all');

// v0.6.19 temporarily introduced a separate RTL native-commit path. That
// path was later identified as a regression and intentionally rolled back.
// RTL delivery is covered by the v0.6.21 restore test instead.

console.log('✓ RetKit keeps the proven Test Campaign native Select-all flow');
