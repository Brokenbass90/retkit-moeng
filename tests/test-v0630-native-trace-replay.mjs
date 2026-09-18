import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/retkit-moengage-v0.5.user.js', import.meta.url), 'utf8');

function body(name) {
  const start = source.indexOf(name);
  assert.ok(start >= 0, `${name} should exist`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unterminated ${name}`);
}

const open = body('async function openTestLocalePopup');
assert.match(open, /test-campaign-variation-locale-dropdown-popup/, 'recorded native popup testid should be primary');
assert.match(open, /invokeReactHandler\(host, 'onMouseDown', target\)/, 'recorded React onMouseDown should open locale picker');
assert.doesNotMatch(open, /isVisible\(popup\)/, 'exact recorded popup should not be rejected by tether visibility heuristics');

const select = body('async function selectExplicitTestLocales');
assert.match(select, /mds-dropdown__popup__select-deselect-all/, 'recorded Select all control should be used directly');
assert.match(select, /activateReactClickable\(selectAll\)/, 'Select all should use its React onClick');
assert.match(select, /All\\s\+Locales\\s\+selected/, 'native label should verify all locales');

const submit = body('async function submitNativeTestCampaign');
const localeAt = submit.indexOf('selectExplicitTestLocales');
const sendViaAt = submit.indexOf('selectNativeSendVia');
assert.ok(localeAt >= 0 && sendViaAt > localeAt, 'recorded flow should select locales before changing Send via');
assert.match(submit, /activateReactClickable\(testButton\)/, 'native Test should use its recorded React onClick path');

console.log('v0.6.31 native trace replay regression checks passed');
