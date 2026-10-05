import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const bridgeSource = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');
const coreSource = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');

const bridgeSandbox = { console, setTimeout, clearTimeout, globalThis: {} };
bridgeSandbox.globalThis.globalThis = bridgeSandbox.globalThis;
vm.createContext(bridgeSandbox);
vm.runInContext(bridgeSource, bridgeSandbox, { filename: 'native-bridge.user.js' });
const bridgeCore = bridgeSandbox.globalThis.__RetKitMoEngageBridgeCore;
assert.ok(bridgeCore, 'bridge core should be exposed');

// 1) Stable freeze rolls RTL back to the conservative pre-row-reorder behavior.
const realStepBlock = `
<div class="blue-block" style="padding:24px">
<table class="w100"><tbody><tr>
<td class="pb0 m-w" style="width:78px"><p class="number">3</p></td>
<td class="pb0 w-a"><p class="text" style="text-align:left">Use Indicators and choose from over 100 tools.</p></td>
</tr></tbody></table>
</div>`;
const rtlTest = bridgeCore.transformRtlHtml(realStepBlock, { allParagraphs: true });
assert.ok(rtlTest.html.indexOf('class="pb0 m-w"') < rtlTest.html.indexOf('class="pb0 w-a"'), 'frozen RTL test mode must not reorder numbered cells');
assert.match(rtlTest.html, /dir="rtl"/, 'frozen RTL test mode still applies rtl direction');

const arabicBlock = realStepBlock.replace('Use Indicators and choose from over 100 tools.', 'استخدم المؤشرات واختر من بين أكثر من 100 أداة.');
const rtlArabic = bridgeCore.transformRtlHtml(arabicBlock);
assert.ok(rtlArabic.html.indexOf('class="pb0 m-w"') < rtlArabic.html.indexOf('class="pb0 w-a"'), 'Arabic mode must also keep original cell order in the stable freeze');
assert.match(rtlArabic.html, /dir="rtl"/, 'Arabic copy still gets rtl direction');

// 2) Sync equivalence must tolerate formatting-only Froala normalization but
// still detect real content changes.
const coreSandbox = { console, globalThis: null, location: { hostname: 'not-moengage.invalid' } };
coreSandbox.globalThis = coreSandbox;
vm.createContext(coreSandbox);
vm.runInContext(coreSource, coreSandbox, { filename: 'retkit-moengage-core.user.js' });
const core = coreSandbox.__RetKitMoEngageCore;
assert.ok(core, 'core exported');
assert.equal(typeof core.htmlEquivalentForSync, 'function', 'sync equivalence helper should be exported');
const pretty = `<table>\n  <tbody>\n    <tr>\n      <td>Hello</td>\n    </tr>\n  </tbody>\n</table>`;
const compact = `<table><tbody><tr><td>Hello</td></tr></tbody></table>`;
assert.equal(core.htmlEquivalentForSync(pretty, compact), true, 'formatting-only differences should not be treated as a revert');
assert.equal(core.htmlEquivalentForSync(pretty, compact.replace('Hello', 'Goodbye')), false, 'real content changes must still be rejected');

// 3) Locale picker discovery must wait for the complete popup instead of
// committing to the first checkbox fragment that appears.
const waitStart = bridgeSource.indexOf('function waitForNativeAddLocaleMenu');
const waitEnd = bridgeSource.indexOf('\n  async function openNativeAddLocaleMenu', waitStart);
const waitBody = bridgeSource.slice(waitStart, waitEnd);
assert.match(waitBody, /settle|stabil|complete|best/i, 'locale picker discovery should wait for the complete popup');
assert.doesNotMatch(waitBody, /if \(rootNode && collectOpenAddLocaleOptions\(rootNode\)\.length\) finish\(rootNode\)/, 'must not finish immediately on the first checkbox fragment');

const popupStart = bridgeSource.indexOf('function findVisibleAddLocalePopupRoot');
const popupEnd = bridgeSource.indexOf('\n  function waitForNativeAddLocaleMenu', popupStart);
const popupBody = bridgeSource.slice(popupStart, popupEnd);
assert.match(popupBody, /Search to select|New Locale|optionCount|checkbox/i, 'complete popup scoring should recognize the full native locale picker');

console.log('✓ RetKit stable locale popup + conservative RTL + sync equivalence');
