import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const bridgePath = new URL('../src/moengage/native-bridge.user.js', import.meta.url);
const bridgeSource = fs.readFileSync(bridgePath, 'utf8');
const coreSource = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');

const sandbox = { console, setTimeout, clearTimeout, globalThis: {} };
sandbox.globalThis.globalThis = sandbox.globalThis;
vm.createContext(sandbox);
vm.runInContext(bridgeSource, sandbox, { filename: 'native-bridge.user.js' });
const core = sandbox.globalThis.__RetKitMoEngageBridgeCore;
assert.ok(core, 'bridge core should be exposed');

// 1) Stable RTL is deliberately conservative: it adds direction/alignment but does not reorder table cells.
const rtlInput = `
<table><tbody><tr>
  <td class="marker"><p>1</p></td>
  <td class="copy"><p style="text-align:left">انتقل إلى قسم العروض ثم أكمل الإيداع</p></td>
</tr></tbody></table>`;
const rtl = core.transformRtlHtml(rtlInput);
assert.ok(rtl.html.indexOf('class="marker"') < rtl.html.indexOf('class="copy"'), 'conservative RTL must not reorder numbered cells');
assert.match(rtl.html, /dir="rtl"/, 'conservative RTL still adds rtl direction');

// 2) Bulk Undo was removed for the stable freeze.
assert.doesNotMatch(coreSource, /rollbackMultiLocaleReplace|data-rk-multilocale-undo/, 'bulk Undo experiment must stay removed');

// 3) Multi-locale operations must capture and restore editor scroll/cursor state.
assert.match(coreSource, /captureEditorViewState|captureEditorViewport/, 'core should capture editor viewport state');
assert.match(coreSource, /restoreEditorViewState|restoreEditorViewport/, 'core should restore editor viewport state');
assert.match(coreSource, /getScrollInfo\s*\(/, 'viewport capture should read CodeMirror scroll position');
assert.match(coreSource, /scrollTo\s*\(/, 'viewport restore should restore CodeMirror scroll position');
assert.match(coreSource, /listSelections|getCursor\s*\(/, 'viewport capture should preserve selection/cursor');

// 4) Locale removal should use the same native handoff safety model as add.
assert.match(bridgeSource, /Finish removing|Remove .* in MoEngage|native.*remove.*assist/i, 'locale removal should expose a native MoEngage handoff');
assert.match(bridgeSource, /removeNativeLocale[\s\S]{0,5000}handOffNativeLocaleRemove|handOffNativeLocaleRemove[\s\S]{0,5000}removeNativeLocale/, 'remove flow should call the native removal handoff');

console.log('✓ RetKit stable conservative RTL + editor viewport + native remove contracts');
