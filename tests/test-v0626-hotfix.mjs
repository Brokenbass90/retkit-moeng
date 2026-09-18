import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/retkit-moengage-v0.5.user.js', import.meta.url), 'utf8');

function functionBody(name) {
  const starts = [`async function ${name}`, `function ${name}`]
    .map((needle) => source.indexOf(needle)).filter((index) => index >= 0);
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

assert.match(source, /@version\s+0\.6\.31/, 'userscript should be v0.6.31');

const rtlDecision = functionBody('rtlToggleDecision');
assert.match(rtlDecision, /htmlEquivalentForSync/, 'RTL revert detection should survive MoEngage formatting changes');
const rtl = functionBody('applyRtlFix');
assert.doesNotMatch(rtl, /commitNativeHtml/, 'RTL must not race the normal editor sync with a direct Froala commit');
assert.match(rtl, /rtlToggleStates\.set/, 'RTL should keep a per-locale snapshot');
assert.match(rtl, /replaceOverlayHtmlAsEdit\(editor, result\.html/, 'RTL should use the dirty-aware overlay editor sync path');

const popup = functionBody('findExactTestLocalePopup');
assert.match(popup, /querySelectorAll/, 'locale popup lookup should handle duplicate Tether portals');
assert.match(popup, /optionCount/, 'locale popup lookup should prefer populated portals');

const waitAction = functionBody('waitForTestLocaleAction');
assert.match(waitAction, /while/, 'Select all/Clear all must be waited for instead of sampled once');

const exact = functionBody('setExactTestLocaleOptions');
assert.match(exact, /isTestLocaleOptionChecked/, 'native locale rows should be set to an exact state');
assert.match(exact, /activateNativeControl/, 'legacy exact-state helper should retain the native fallback');

const select = functionBody('selectExplicitTestLocales');
assert.match(select, /Select all/, 'Select all should be the primary all-locales path');
assert.match(select, /activateReactClickable\(selectAll\)/, 'Select all should use the proven React click handler');
assert.match(select, /Clear all/, 'partial selection should clear the native picker through its live action');
assert.match(select, /activateReactClickable\(item\.row\)/, 'partial locale rows should use React onClick');
assert.match(select, /test-campaign-variation-locale-dropdown-option-/, 'locale selection should use the exact MoEngage option test ids');

console.log('v0.6.31 urgent Test Campaign + RTL hotfix regression checks passed');
