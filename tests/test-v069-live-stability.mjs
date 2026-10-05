import assert from 'node:assert/strict';
import fs from 'node:fs';

const coreSource = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const bridgeSource = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');

// 1) Never confuse RetKit's own "Add selected" with MoEngage's native action.
const retkitElStart = bridgeSource.indexOf('function isRetKitElement');
const retkitElEnd = bridgeSource.indexOf('\n  function limitedElementWalk', retkitElStart);
const retkitElBody = bridgeSource.slice(retkitElStart, retkitElEnd);
assert.match(retkitElBody, /addLocalePopover/, 'RetKit add-locale popover must be excluded from native action discovery');

// 2) Bulk scan/apply must freeze visible RetKit state while native MoEngage is switched underneath.
const pullStart = coreSource.indexOf('function pullNativeToOverlay');
const pullEnd = coreSource.indexOf('\n\n  function rebindNativeEditorFromMoEngage', pullStart);
const pullBody = coreSource.slice(pullStart, pullEnd);
assert.match(pullBody, /multiLocaleBusy/, 'native locale changes during bulk operations must not overwrite the visible RetKit editor');
assert.match(coreSource, /multiLocaleLoading/, 'bulk operations should have a dedicated loading overlay');
assert.match(coreSource, /Scanning locales/i, 'scan should show a loading state instead of visible locale flicker');
assert.match(coreSource, /Replacing locales/i, 'apply should show a loading state instead of visible locale flicker');

// 3) Bulk writes must use a stable/persisted writer, not the tentative fast writer.
const applyStart = coreSource.indexOf('async function applyMultiLocaleReplace');
const applyEnd = coreSource.indexOf('\n  async function rollbackMultiLocaleReplace', applyStart);
const applyBody = coreSource.slice(applyStart, applyEnd);
assert.match(bridgeSource, /setLocaleHtmlStable:/, 'bridge should expose a persisted hidden locale writer');
assert.match(bridgeSource, /async function setNativeLocaleHtmlStable\(/, 'bridge should implement persisted hidden locale writes');
assert.match(applyBody, /setLocaleHtmlStable/, 'bulk replace should use the persisted hidden writer');
assert.doesNotMatch(applyBody, /setLocaleHtmlFast/, 'bulk replace should no longer trust tentative fast commits');
assert.match(bridgeSource, /stability|settle|persist/i, 'stable writer should include a delayed persistence check');

// 4) Backup control must render a real SVG icon, not a font glyph that can become a tofu square.
assert.match(bridgeSource, /backupDownloadIcon|backupIcon|downloadIcon/i, 'backup button should use an explicit icon helper');
assert.match(bridgeSource, /<svg|createElementNS\([^)]*svg/i, 'backup icon should be SVG-based');
assert.doesNotMatch(bridgeSource, /backupLocales\.textContent\s*=\s*['"]↓['"]/, 'backup button must not rely on the down-arrow glyph');

console.log('✓ RetKit v0.6.9 live locale stability contracts');
