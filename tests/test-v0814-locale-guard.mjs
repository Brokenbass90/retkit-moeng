// v0.8.14: правка одной локали не пишется в другую; пустой редактор — пустое превью.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const core = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return source.slice(from, to);
}

const fnSrc = between(core, '  function emailTextWords(html) {', '  function shouldSkipNativeCommit(');
const api = new Function(`${fnSrc}; return { emailTextSimilarity, nativeSwitchedUnderUs };`)();

const en = '<html lang="en"><body><table><tr><td>Are you using trend lines for trading? One line, multiple functions. Open the platform now.</td></tr></table></body></html>';
const enEdited = en.replace('Open the platform now', 'Open the app today');
const ar = '<html lang="ar" dir="rtl"><body><table><tr><td>هل تستخدم خطوط الاتجاه في التداول؟ خط واحد ووظائف متعددة. افتح المنصة الآن.</td></tr></table></body></html>';

assert.ok(api.emailTextSimilarity(en, enEdited) > 0.7, 'a small edit keeps the text similar');
assert.ok(api.emailTextSimilarity(en, ar) < 0.2, 'EN vs AR share almost no words');

// Редактор MoEngage не менялся — пишем.
assert.equal(api.nativeSwitchedUnderUs({ knownHtml: en, nativeHtml: en, sameAsKnown: true, boundLocale: 'EN', tabLocale: 'AR_KW' }), '');
// MoEngage уже на AR, а в RetKit текст EN — отказ.
assert.match(api.nativeSwitchedUnderUs({ knownHtml: en, nativeHtml: ar, boundLocale: 'EN', tabLocale: 'AR_KW' }), /AR_KW/);
// Вкладку не распознали, но текст совсем другой — тоже отказ.
assert.match(api.nativeSwitchedUnderUs({ knownHtml: en, nativeHtml: ar, boundLocale: 'EN', tabLocale: '' }), /different email/);
// Та же локаль, MoEngage чуть переформатировал — пишем.
assert.equal(api.nativeSwitchedUnderUs({ knownHtml: en, nativeHtml: enEdited, boundLocale: 'EN', tabLocale: 'DEFAULT' }), '');
// AR и AR_KW — одна вкладка.
assert.equal(api.nativeSwitchedUnderUs({ knownHtml: ar, nativeHtml: ar.replace('الآن', 'اليوم'), boundLocale: 'AR', tabLocale: 'AR_KW' }), '');
// Ещё ничего не запомнили — не мешаем.
assert.equal(api.nativeSwitchedUnderUs({ knownHtml: '', nativeHtml: ar, boundLocale: 'EN', tabLocale: 'AR_KW' }), '');

const push = between(core, '  async function pushOverlayToNative(', '  function pullNativeToOverlay(');
assert.ok(push.indexOf('nativeSwitchedUnderUs(') < push.indexOf("diagBreadcrumb('sync.start'"), 'the locale check runs before any write');
assert.match(push, /write_blocked_other_locale/, 'a blocked write is logged with its HTML');
assert.match(push, /rememberNativeHtml\(/, 'after a successful write RetKit remembers what MoEngage now holds');
assert.match(between(core, '  function rebindNativeEditorFromMoEngage(', '  function warnIfNativeBodyEmpty('), /rememberNativeHtml\(nextNative\.getValue\(\)\)/, 'a new locale resets the baseline');
assert.match(bridge, /getNativeTabLocale:/, 'bridge exposes the bare MoEngage tab');

// Пустой редактор.
const preview = between(core, '  function scheduleLocalPreview(', '  function applyPreviewHtml(');
assert.match(preview, /showEmptyPreview\(\)/, 'clearing the code clears the preview');
assert.match(between(core, '  function refreshPreviewFromMoEngage(', '  function scheduleNativeSync('), /overlayIsEmpty\(\)/, 'the MoEngage poll does not bring the old email back into an empty preview');

console.log('✓ v0.8.14: no cross-locale writes; empty editor → empty preview');
