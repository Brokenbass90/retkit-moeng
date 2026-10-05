import assert from 'node:assert/strict';
import fs from 'node:fs';

const coreSource = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const bridgeSource = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');

// v0.7.4: one "Replace with…" field for the current locale AND across locales
// (two fields were easy to mix up). Bulk apply reads the main field.
assert.doesNotMatch(coreSource, /multiLocaleReplaceInput/, 'the second across-locales replacement field is gone');
const applyStart = coreSource.indexOf('async function applyMultiLocaleReplace');
const applyEnd = coreSource.indexOf('\n  async function refreshLocaleManager', applyStart);
const applyBody = coreSource.slice(applyStart, applyEnd);
assert.ok(applyStart >= 0, 'bulk apply function should exist');
assert.match(applyBody, /document\.getElementById\(IDS\.replaceInput\)/, 'bulk apply uses the main replacement field');
assert.match(applyBody, /readLocaleHtmlFast\(item\.locale\)/, 'bulk apply re-reads each locale before writing');

// Bulk apply must use the hidden native writer rather than rebinding RetKit to every locale.
assert.match(bridgeSource, /setLocaleHtmlFast:/, 'bridge should expose a hidden fast locale writer');
assert.match(bridgeSource, /async function setNativeLocaleHtmlFast\(/, 'bridge should implement hidden native locale writing');
assert.match(coreSource, /commitNativeHtml:/, 'core should expose a native commit primitive for the bridge');
assert.match(applyBody, /setLocaleHtml(?:Fast|Stable)/, 'bulk apply should use a hidden native writer');
assert.doesNotMatch(applyBody, /STATE\.overlayEditor\?\.getValue/, 'bulk apply should not read/rebind the visible RetKit editor for each locale');
assert.doesNotMatch(applyBody, /bridge\.switchLocale\(/, 'bulk apply should not visibly switch RetKit locale itself');
assert.match(applyBody, /setLocaleHtml(?:Fast|Stable)/, 'bulk apply should commit through a hidden native writer');


const restoreStart = coreSource.indexOf('async function restoreMultiLocaleOrigin');
const restoreEnd = coreSource.indexOf('\n  function renderMultiLocalePlanRows', restoreStart);
const restoreBody = coreSource.slice(restoreStart, restoreEnd);
assert.match(restoreBody, /preferNative:\s*true/, 'origin restore must compare against the hidden native locale, not the unchanged visible RetKit locale');
assert.match(bridgeSource, /switchLocale:\s*\(locale, options\)/, 'bridge locale switch API should pass restore options through');

// Add-locale confirmation must not require an exact "Add" button inside the smallest options root.
const addActionStart = bridgeSource.indexOf('function findOpenAddLocaleAction');
const addActionEnd = bridgeSource.indexOf('\n  function closeNativeAddLocaleMenu', addActionStart);
const addActionBody = bridgeSource.slice(addActionStart, addActionEnd);
assert.ok(addActionStart >= 0, 'add-locale action finder should exist');
assert.match(addActionBody, /Add locale|Apply|Save|Done/i, 'action finder should understand MoEngage confirmation label variants');
assert.match(addActionBody, /parentElement|closest\(/, 'action finder should search a broader popup ancestor, not only the smallest option root');
assert.match(addActionBody, /document\.querySelectorAll\('button,\[role="button"\].*input\[type="submit"\]/, 'action finder should have a bounded nearby-button fallback for portal layouts');

console.log('✓ RetKit v0.6.7 bulk replace + add-locale contracts');
