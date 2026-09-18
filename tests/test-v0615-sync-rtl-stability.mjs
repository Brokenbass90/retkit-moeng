import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mainSource = fs.readFileSync(new URL('../src/retkit-moengage.user.js', import.meta.url), 'utf8');
const coreSource = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const bridgeSource = fs.readFileSync(new URL('../src/retkit-moengage-v0.5.user.js', import.meta.url), 'utf8');

// 1) delete -> undo must not trigger a needless Froala commit when the local
// working copy is already equivalent to native MoEngage HTML, even if dirty=true.
const coreSandbox = { console, globalThis: null, location: { hostname: 'not-moengage.invalid' } };
coreSandbox.globalThis = coreSandbox;
vm.createContext(coreSandbox);
vm.runInContext(coreSource, coreSandbox, { filename: 'retkit-moengage-core.user.js' });
const core = coreSandbox.__RetKitMoEngageCore;
assert.ok(core, 'core should be exposed');
assert.equal(typeof core.shouldSkipNativeCommit, 'function', 'core should expose native no-op commit guard');
const pretty = '<table>\n  <tbody>\n    <tr><td>Hello</td></tr>\n  </tbody>\n</table>';
const compact = '<table><tbody><tr><td>Hello</td></tr></tbody></table>';
assert.equal(core.shouldSkipNativeCommit({ localHtml: pretty, nativeHtml: compact }), true, 'equivalent local/native HTML should skip commit regardless of dirty state');
assert.equal(core.shouldSkipNativeCommit({ localHtml: pretty.replace('Hello', 'Changed'), nativeHtml: compact }), false, 'real content changes must still commit');

const pushStart = mainSource.indexOf('async function pushOverlayToNative');
const pushEnd = mainSource.indexOf('\n  function pullNativeToOverlay', pushStart);
const pushBody = mainSource.slice(pushStart, pushEnd);
assert.match(pushBody, /shouldSkipNativeCommit|htmlEquivalentForSync\(next,\s*native\.getValue\(\)\)/, 'push path should short-circuit equivalent HTML before Froala commit');

// 2) Full production-like RTL block remains conservative in the frozen build.
const bridgeSandbox = { console, setTimeout, clearTimeout, globalThis: {} };
bridgeSandbox.globalThis.globalThis = bridgeSandbox.globalThis;
vm.createContext(bridgeSandbox);
vm.runInContext(bridgeSource, bridgeSandbox, { filename: 'retkit-moengage-v0.5.user.js' });
const bridgeCore = bridgeSandbox.globalThis.__RetKitMoEngageBridgeCore;
assert.ok(bridgeCore, 'bridge core should be exposed');
const realBlock = `
<table><tbody><tr>
  <td class="pb0 m-w"><p class="number">1</p></td>
  <td class="pb0 w-a"><p class="text" style="text-align:left">انتقل إلى قسم العروض ثم أكمل الإيداع</p></td>
</tr></tbody></table>`;
const rtl = bridgeCore.transformRtlHtml(realBlock);
assert.ok(rtl.html.indexOf('class="pb0 m-w"') < rtl.html.indexOf('class="pb0 w-a"'), 'frozen RTL must not reorder the numbered row');
assert.match(rtl.html, /dir="rtl"/, 'frozen RTL should still apply RTL direction');

console.log('✓ RetKit sync no-op guard + conservative RTL stability');
