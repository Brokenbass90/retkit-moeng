import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');

function block(start, end) {
  const a = source.indexOf(start);
  assert.ok(a >= 0, `missing block start: ${start}`);
  const b = source.indexOf(end, a + start.length);
  assert.ok(b >= 0, `missing block end: ${end}`);
  return source.slice(a, b).replace(/\r\n?/g, '\n').trim();
}

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex').slice(0, 8);
}

// Keep the v0.6.9 RTL transformer itself frozen; only delivery/state handling
// around it is allowed to evolve.
const transformRtl = block('function transformRtlHtml', 'function normaliseTestPreferences');
assert.equal(md5(transformRtl), '71010212', 'restore v0.6.9 RTL transformer exactly');

const rtlAction = block('function applyRtlFix', 'function renderLocaleStrip');
assert.doesNotMatch(rtlAction, /commitNativeHtml/, 'RTL must use the stable workspace sync path rather than a competing direct writer');
assert.match(rtlAction, /rtlToggleStates/, 'RTL state must be tracked per locale');
assert.match(rtlAction, /replaceOverlayHtmlAsEdit\(editor, result\.html/, 'RetKit editor should carry the RTL HTML into the dirty-aware sync pipeline');
assert.match(rtlAction, /allParagraphs:\s*true/, 'RTL remains a manual action for any open locale');

const findTestSection = block('function findTestCampaignSection', 'function isInsideTestCampaign');
assert.doesNotMatch(findTestSection, /testCampaignSectionCacheAt/, 'keep the later stable Test Campaign locator without stale negative caching');
assert.match(findTestSection, /test_email_wrapper/, 'prefer the real native Test Campaign wrapper when available');

const localeAction = block('async function selectExplicitTestLocales', 'const TEST_SEND_VIA_OPTIONS');
assert.match(localeAction, /findTestCampaignLocaleControl\(section\)/, 'keep the proven dedicated live-DOM locale control locator');
assert.match(localeAction, /Select all|setExactTestLocaleOptions/, 'keep exact native option selection with Select all fallback');
assert.match(localeAction, /wantsAll/, 'full-locale sends must still identify the all-locales case');
assert.match(localeAction, /test-campaign-variation-locale-dropdown-option-|waitForTestLocaleOptions|setExactTestLocaleOptions/, 'partial locale sends must use live portal options and set exact state');

const submitAction = block('async function submitNativeTestCampaign', 'function readTestPreferences');
// Submission stays on the proven old path; the only allowed compatibility delta
// is accepting MoEngage's post-run "Rerun Test" label as the same native action.
assert.match(submitAction, /testButton\.click\(\)|activateReactClickable\(testButton\)/, 'native Test Campaign button must use the native button action');
assert.match(submitAction, /Rerun Test/, 'current MoEngage Rerun Test label must remain supported');
assert.doesNotMatch(submitAction, /activateNativeControl\(testButton\)/, 'do not use the generic synthetic submit path');

console.log('v0.6.22 stable transformer / live Test Campaign contract passed');
