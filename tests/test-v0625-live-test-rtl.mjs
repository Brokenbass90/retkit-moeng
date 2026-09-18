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

assert.match(source, /const rtlToggleStates = new Map\(\)/, 'RTL toggle state should be stored per locale');
const rtl = functionBody('applyRtlFix');
assert.doesNotMatch(rtl, /commitNativeHtml/, 'RTL should use the proven workspace sync path instead of racing Froala directly');
assert.match(rtl, /rtlToggleStates\.get/, 'RTL should read the active locale snapshot');
assert.match(rtl, /rtlToggleStates\.set/, 'RTL should keep an independent snapshot for the active locale');
assert.match(rtl, /rtlToggleStates\.delete/, 'RTL revert should clear only the active locale snapshot');

const options = functionBody('collectTestLocaleOptions');
assert.match(options, /test-campaign-variation-locale-dropdown-option-/, 'locale picker should use MoEngage option test ids');
assert.match(options, /mds-dropdown__popup__list__item__label/, 'locale picker should read the dedicated option label');

const plan = functionBody('waitForTestLocalePlan');
assert.match(plan, /while/, 'locale matching should wait for lazy popup rendering');
assert.match(plan, /resolveTestLocaleSelectionPlan/, 'locale matching should re-evaluate the live popup until complete');

const select = functionBody('selectExplicitTestLocales');
assert.match(select, /wantsAll/, 'all locales should take the native Select all fast path');
assert.match(select, /available\.length > 1 && selected\.length === available\.length/, 'all-locale detection should compare against the live popup locale set');
assert.match(select, /activateReactClickable\(selectAll\)/, 'all selection should commit through the native React Select all handler');
assert.match(select, /activateReactClickable\(item\.row\)/, 'partial selection should commit each locale through the native React option row');
assert.match(select, /isTestLocaleOptionChecked/, 'partial selection should verify React kept each locale');

const submit = functionBody('submitNativeTestCampaign');
assert.match(submit, /selectExplicitTestLocales\(section, selectedLocales\)/, 'recorded native flow should set locales explicitly');
assert.match(submit, /selectNativeSendVia\(section, prefs\.sendVia\)/, 'recorded native flow should apply Send via through MoEngage');
assert.match(submit, /setNativeValue\(emailField, prefs\.email\)/, 'recorded native flow should fill the native recipient field');
assert.match(submit, /waitForNativeTestButton/, 'RetKit should wait for the native Test button to become enabled');
assert.match(submit, /activateReactClickable\(testButton\)/, 'native Test\/Rerun Test should use the React click handler');

console.log('v0.6.31 live Test Campaign + per-locale RTL regression checks passed');
