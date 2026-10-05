import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const coreSource = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const bridgeSource = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');

function functionBody(source, name) {
  const startCandidates = [`async function ${name}`, `function ${name}`]
    .map((needle) => source.indexOf(needle))
    .filter((index) => index >= 0);
  assert.ok(startCandidates.length, `${name} should exist`);
  const start = Math.min(...startCandidates);
  const nextAsync = source.indexOf('\n  async function ', start + 10);
  const nextSync = source.indexOf('\n  function ', start + 10);
  const ends = [nextAsync, nextSync].filter((index) => index > start);
  const end = ends.length ? Math.min(...ends) : source.length;
  return source.slice(start, end);
}

// Freeze scope: no bulk-undo feature or snapshot state. Cmd/Ctrl+Z is enough.
assert.doesNotMatch(coreSource, /rollbackMultiLocaleReplace/, 'bulk rollback function must be removed');
assert.doesNotMatch(coreSource, /data-rk-multilocale-undo|rk-ml-undo/, 'bulk undo UI must be removed');
assert.doesNotMatch(coreSource, /multiLocaleLastRun/, 'bulk undo snapshot state must be removed');

// Restore the known-working one-click ZIP backup flow from the pre-two-step implementation.
const backupBody = functionBody(bridgeSource, 'downloadLocaleBackup');
assert.match(backupBody, /buildStoredZip\(entries\)/, 'backup must build a ZIP containing locale entries');
assert.match(backupBody, /index\.html/, 'backup must store <locale>/index.html entries');
assert.match(backupBody, /link\.download\s*=\s*filename\s*\|\|\s*`\$\{folder\}\.zip`/, 'backup fallback must name the downloaded ZIP after the chosen folder');
assert.match(backupBody, /link\.click\(\)/, 'backup must download immediately in the same action');
assert.doesNotMatch(backupBody, /preparedLocaleBackup|Backup ready|click Download/, 'two-step prepared backup flow must be removed');

// Restore the known-good Test Campaign locator: no negative/stale cache between clicks.
const testSectionBody = functionBody(bridgeSource, 'findTestCampaignSection');
assert.doesNotMatch(testSectionBody, /testCampaignSectionCache|testCampaignSectionCacheAt/, 'Send test locator must not cache a missing/stale Test Campaign section');
assert.match(testSectionBody, /findExactMarker\('Locales and Variations'\)/, 'Send test locator must use the native locale marker');
assert.match(testSectionBody, /findExactMarker\('Send via'\)/, 'Send test locator must use the native Send via marker');

// Roll RTL back to the conservative pre-number-reorder behavior.
const sandbox = {
  console,
  globalThis: null,
  location: { hostname: 'not-moengage.invalid' },
  TextEncoder,
  Uint8Array,
  DataView,
  Date,
  Math,
  Set,
  Map,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(bridgeSource, sandbox, { filename: 'native-bridge.user.js' });
const bridgeCore = sandbox.__RetKitMoEngageBridgeCore;
assert.equal(typeof bridgeCore?.transformRtlHtml, 'function');
const rtlInput = `
<table><tbody><tr>
  <td class="marker"><p>1</p></td>
  <td class="copy"><p style="text-align:left">انتقل إلى قسم العروض ثم أكمل الإيداع</p></td>
</tr></tbody></table>`;
const rtl = bridgeCore.transformRtlHtml(rtlInput);
assert.ok(rtl.html.indexOf('class="marker"') < rtl.html.indexOf('class="copy"'), 'stable RTL must not reorder numbered table cells');
assert.match(rtl.html, /<p[^>]*dir="rtl"[^>]*>/, 'stable RTL must still add rtl direction to Arabic copy');
assert.doesNotMatch(functionBody(bridgeSource, 'transformRtlHtml'), /reorderRtlStepRows|rtlStepRowPlans/, 'stable RTL transform must not use smart numbered-row reordering');

console.log('✓ RetKit v0.6.17 stable-freeze rollback contracts');
