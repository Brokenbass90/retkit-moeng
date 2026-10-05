import assert from 'node:assert/strict';
import fs from 'node:fs';

const coreSource = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const bridgeSource = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');

// 1) Bulk progress is an inline progress bar/state inside Across locales, not a modal screen.
assert.match(coreSource, /rk-ml-progress-bar/, 'Across locales should render an inline progress bar');
assert.match(coreSource, /Please wait|Keep this tab open|Do not edit/i, 'bulk progress should clearly tell the user the operation is still running');
assert.doesNotMatch(coreSource, /position:\s*fixed[^}]*multiLocaleLoading|multiLocaleLoading[^}]*position:\s*fixed/s, 'bulk progress must not become a fixed-screen overlay');

// 2) Stable freeze removes the experimental bulk Undo path entirely.
assert.doesNotMatch(coreSource, /data-rk-multilocale-undo/, 'Across locales should not expose the removed bulk Undo control');
assert.doesNotMatch(coreSource, /rollbackMultiLocaleReplace/, 'removed bulk Undo must not keep rollback code in core');

// 3) Hidden locale work freezes the visible RetKit locale/subject while native MoEngage switches underneath.
const subjectStart = bridgeSource.indexOf('function syncSubjectFromMoEngage');
const subjectEnd = bridgeSource.indexOf('\n  function commitSubjectToMoEngage', subjectStart);
assert.match(bridgeSource.slice(subjectStart, subjectEnd), /multiLocaleBusy/, 'subject sync must pause during hidden multi-locale work');
const localeUiStart = bridgeSource.indexOf('function updateLocaleUi');
const localeUiEnd = bridgeSource.indexOf('\n  function ensureBridgeToolbar', localeUiStart);
assert.match(bridgeSource.slice(localeUiStart, localeUiEnd), /multiLocaleBusy/, 'locale tabs must not visibly follow hidden native switching');

// 4) Stable bulk writes must not pay a second fixed settle delay after commitThroughFroala already verified persistence.
const stableStart = bridgeSource.indexOf('async function setNativeLocaleHtmlStable');
const stableEnd = bridgeSource.indexOf('\n  async function verifyNativeLocaleHtmlFast', stableStart);
const stableBody = bridgeSource.slice(stableStart, stableEnd);
assert.doesNotMatch(stableBody, /await\s+wait\(stabilityMs\)/, 'stable writer should not duplicate commitThroughFroala persistence waiting');

// 5) When MoEngage exposes no automatable add action, RetKit must hand control to the real native picker instead of failing again.
assert.match(bridgeSource, /native locale picker|Finish adding|Continue in MoEngage/i, 'locale add should have a native-picker fallback');
assert.match(bridgeSource, /nativeLocaleAssist|NativeLocaleAdd/i, 'native locale fallback should be implemented explicitly');

console.log('✓ RetKit stable progress + hidden UI freeze + native locale fallback contracts');
