import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const bridgePath = new URL('../src/retkit-moengage-v0.5.user.js', import.meta.url);
const corePath = new URL('../src/core/retkit-moengage-core.user.js', import.meta.url);
const bridgeSource = fs.readFileSync(bridgePath, 'utf8');
const coreSource = fs.readFileSync(corePath, 'utf8');

function body(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not parse ${name}`);
}

// RTL Fix is a manual toggle for the currently open locale. It must not
// inspect whether the locale/content is Arabic before deciding what to transform.
const rtlBody = body(bridgeSource, 'applyRtlFix');
assert.doesNotMatch(rtlBody, /shouldAllowRtlFix\(/, 'RTL Fix must not gate itself on Arabic locale/content');
assert.match(rtlBody, /transformRtlHtml\(currentHtml,\s*\{\s*allParagraphs:\s*true\s*\}\)/, 'RTL Fix must transform the current locale in manual test mode every time');


const updateLocaleUiBody = body(bridgeSource, 'updateLocaleUi');
assert.doesNotMatch(updateLocaleUiBody, /isArabicLocale\(/, 'RTL button active state must not be tied to AR locale');
assert.match(updateLocaleUiBody, /rtlToggleState/, 'RTL button active state must follow the manual toggle state');

// Automatic editor sync must never push an empty document into MoEngage. Locale
// deletion/unmounts can transiently clear the editor and must not destroy content.
const sandbox = { window: {}, console, setTimeout, clearTimeout, URL, location: undefined };
sandbox.window = sandbox;
vm.runInNewContext(coreSource, sandbox, { filename: 'retkit-moengage-core.user.js' });
const core = sandbox.__RetKitMoEngageCore;
assert.equal(typeof core.shouldBlockEmptyNativeCommit, 'function', 'core must export an empty-commit guard');
assert.equal(core.shouldBlockEmptyNativeCommit({ localHtml: '', nativeHtml: '<p>safe</p>' }), true, 'empty local HTML must be blocked when native HTML is non-empty');
assert.equal(core.shouldBlockEmptyNativeCommit({ localHtml: '   ', nativeHtml: '<p>safe</p>' }), true, 'whitespace-only local HTML must be blocked');
assert.equal(core.shouldBlockEmptyNativeCommit({ localHtml: '<p>x</p>', nativeHtml: '<p>safe</p>' }), false, 'non-empty edits remain allowed');

const pushBody = body(coreSource, 'pushOverlayToNative');
assert.match(pushBody, /shouldBlockEmptyNativeCommit/, 'pushOverlayToNative must apply the empty-commit guard before Froala commit');

// After native locale removal, RetKit must rebind to the surviving native editor
// instead of keeping the deleted locale's stale/empty editor state.
const removeBody = body(bridgeSource, 'handOffNativeLocaleRemove');
assert.match(removeBody, /rebindNativeEditorFromMoEngage/, 'locale removal completion must rebind RetKit to the current native editor');

console.log('v0.6.21 RTL toggle / empty sync / locale removal regression tests passed');
