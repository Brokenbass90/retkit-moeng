import assert from 'node:assert/strict';
import fs from 'node:fs';

const core = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');
const between = (src, from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} must exist`);
  return src.slice(a, b);
};

// Clicking a locale tab first saves the open locale; a failed save stops the switch.
const tabClick = between(bridge, "tab.addEventListener('click', async () => {", 'const wrap = document.createElement');
const flushAt = tabClick.indexOf('flushBeforeLocaleSwitch');
const switchAt = tabClick.indexOf('switchNativeLocale(locale)');
assert.ok(flushAt > 0 && switchAt > flushAt, 'flush runs before the native switch');
assert.match(tabClick, /flush\.ok === false[\s\S]*?return;/, 'failed flush keeps the user on the locale');

const flush = between(core, 'async function flushBeforeLocaleSwitch', 'function rebindNativeEditorFromMoEngage');
assert.match(flush, /clearTimeout\(STATE\.syncTimer\)/, 'pending idle sync is taken over');
assert.match(flush, /while \(STATE\.applying/, 'waits for an in-flight write');
assert.match(flush, /pushOverlayToNative\(true\)/, 'writes the edit now');
assert.match(flush, /locale_switch_blocked_unsaved/, 'blocked switch reaches Diagnostics');
assert.match(core, /flushBeforeLocaleSwitch: \(options\) => flushBeforeLocaleSwitch\(options\)/, 'exposed to the bridge');

// A locale change is never a "late revert": the overlay takes the new
// locale's HTML as is, and nothing from one locale is ever written to another.
const rebind = between(core, 'function rebindNativeEditorFromMoEngage', 'function currentBridgeLocale');
assert.doesNotMatch(rebind, /unsavedByLocale|scheduleNativeSync/, 'rebind never re-injects or writes another locale\'s HTML');
assert.match(rebind, /STATE\.lastAppliedAt = 0;/, 'previous locale write is not compared with the new locale');
const pull = between(core, 'function pullNativeToOverlay', 'function rebindNativeEditorFromMoEngage');
assert.match(pull, /localeSwitchUntil/, 'pull treats a switch window as a locale change');
assert.match(pull, /currentBridgeLocale\(\) !== STATE\.boundLocale/, 'pull treats another active locale as a locale change');
assert.doesNotMatch(core, /unsavedByLocale|unsaved_edit_stashed/, 'the cross-locale stash is gone');

// Slow MoEngage settle is not a rejection.
const commit = between(core, 'async function commitThroughFroala', 'function describeHtmlDifference');
assert.match(commit, /for \(let waited = 0; !ok && waited < 3000/, 'commit waits up to 3s more before calling it rejected');
assert.match(commit, /sync\.settled-late/, 'late settle is visible in Diagnostics');
console.log('✓ RetKit v0.8.5 slow MoEngage settle is not a rejection');

// Empty <body> never overwrites an email with content (pt_PT arrived with <body></body>).
{
  const fnSrc = between(core, 'function htmlBodyHasContent(', 'function shouldSkipNativeCommit');
  // eslint-disable-next-line no-new-func
  const api = new Function(`${fnSrc}; return { htmlBodyHasContent, shouldBlockEmptyNativeCommit };`)();
  const full = '<html><head><style>p{}</style></head><body><table><tr><td>Olá</td></tr></table></body></html>';
  const empty = '<html><head><style>p{}</style></head><body></body></html>';
  assert.equal(api.htmlBodyHasContent(empty), false);
  assert.equal(api.htmlBodyHasContent(full), true);
  assert.equal(api.shouldBlockEmptyNativeCommit({ localHtml: empty, nativeHtml: full }), true, 'empty body blocked');
  assert.equal(api.shouldBlockEmptyNativeCommit({ localHtml: full, nativeHtml: empty }), false, 'filling an empty email is allowed');
  assert.equal(api.shouldBlockEmptyNativeCommit({ localHtml: '<p>x</p>', nativeHtml: full }), false, 'fragments still allowed');
  assert.match(between(core, 'async function commitThroughFroala', 'function describeHtmlDifference'), /shouldBlockEmptyNativeCommit/, 'every writer is guarded');
  console.log('✓ RetKit v0.8.5 empty <body> never overwrites an email');
}
