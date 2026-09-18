import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const coreSource = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const bridgeSource = fs.readFileSync(new URL('../src/retkit-moengage-v0.5.user.js', import.meta.url), 'utf8');

const sandbox = {
  console,
  globalThis: null,
  location: { hostname: 'not-moengage.invalid' },
  localStorage: { getItem: () => null, setItem: () => {} },
  setTimeout,
  clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(coreSource, sandbox, { filename: 'retkit-moengage-core.user.js' });
const core = sandbox.__RetKitMoEngageCore;
assert.ok(core, 'core should load outside MoEngage');

const incomplete = JSON.parse(JSON.stringify(core.validateEmailHtml('<table><tr><td')));
assert.ok(incomplete.some((issue) => issue.code === 'incomplete-tag' && issue.severity === 'error'), 'unfinished <td must be a structural error');

const quote = JSON.parse(JSON.stringify(core.validateEmailHtml('<img src="https://cdn.example/image.png>')));
assert.ok(quote.some((issue) => issue.code === 'unclosed-attribute-quote' && issue.severity === 'error'), 'unclosed attribute quote must be reported');
assert.equal(typeof core.hasBlockingPreviewSyntaxIssue, 'function', 'preview safety helper should be exposed');
assert.equal(core.hasBlockingPreviewSyntaxIssue('<td'), true, 'incomplete tag blocks live preview mutation');
assert.equal(core.hasBlockingPreviewSyntaxIssue('<div>ok</div>'), false, 'valid markup can update live preview');

const changeHandlerStart = coreSource.indexOf("overlay.on('change'");
const changeHandlerEnd = coreSource.indexOf('STATE.nativeChangeHandler', changeHandlerStart);
const changeHandler = coreSource.slice(changeHandlerStart, changeHandlerEnd);
assert.ok(changeHandlerStart >= 0, 'editor change handler should exist');
assert.doesNotMatch(changeHandler, /applyPreviewHtml\(overlay\.getValue\(\),\s*true\)/, 'typing must not hard reload iframe srcdoc on every keystroke');
assert.match(changeHandler, /scheduleLocalPreview\(overlay\.getValue\(\)\)/, 'typing should use debounced soft preview updates');
assert.match(coreSource, /function softUpdatePreviewDocument\(/, 'preview should have an in-place DOM update path');

assert.doesNotMatch(coreSource, /#\$\{IDS\.multiLocaleDrawer\}\s*\{\s*position:fixed/, 'multi-locale scope must not float at the top-right');
const drawerStart = coreSource.indexOf('function renderMultiLocaleDrawer');
const drawerEnd = coreSource.indexOf('\n  function buildFindBar', drawerStart);
const drawerBody = coreSource.slice(drawerStart, drawerEnd);
assert.match(drawerBody, /insertAdjacentElement\(['"]afterend['"],\s*drawer\)/, 'auto locale panel should expand directly below the find bar');
assert.doesNotMatch(drawerBody, /document\.body\.appendChild\(drawer\)/, 'locale panel should stay inside the editor pane');

const scanStart = coreSource.indexOf('async function scanMultiLocaleReplace');
const scanEnd = coreSource.indexOf('\n  function selectedMultiLocaleItems', scanStart);
const scanBody = coreSource.slice(scanStart, scanEnd);
assert.match(scanBody, /readLocaleHtmlFast/, 'multi-locale scan must use the lightweight native locale reader');
assert.doesNotMatch(scanBody, /STATE\.overlayEditor\?\.getValue/, 'scan must not depend on a full RetKit editor rebind for each locale');
assert.doesNotMatch(coreSource, /makeButton\('Cancel'/, 'multi-locale UI should not expose a technical Cancel control');
assert.match(coreSource, /Replace \${selectedMatches} match/, 'multi-locale UI should expose one clear replace action with match counts');

assert.match(bridgeSource, /readLocaleHtmlFast:/, 'bridge API should expose the lightweight locale reader');
assert.match(bridgeSource, /async function readNativeLocaleHtmlFast\(/, 'bridge should implement lightweight native locale reads');
const switchStart = bridgeSource.indexOf('async function switchNativeLocale');
const switchEnd = bridgeSource.indexOf('\n  async function rebindWorkspaceAfterLocaleChange', switchStart);
const switchBody = bridgeSource.slice(switchStart, switchEnd);
assert.match(switchBody, /options\s*=\s*\{\}/, 'locale switch should support lightweight options');
assert.match(switchBody, /rebind\s*!==\s*false/, 'locale switch should be able to skip workspace rebind');
assert.doesNotMatch(switchBody, /\[120,\s*280,\s*550,\s*900,\s*1500,\s*2400\]/, 'locale switch must not use cumulative multi-second sleep ladders');


const optionStart = bridgeSource.indexOf('function findVisibleLocaleOption');
const optionEnd = bridgeSource.indexOf('\n  async function switchNativeLocale', optionStart);
const optionBody = bridgeSource.slice(optionStart, optionEnd);
assert.ok(optionStart >= 0, 'locale dropdown option finder should exist');
assert.doesNotMatch(optionBody, /document\.querySelectorAll\([^)]*div,span/, 'locale dropdown fallback must not scan every div/span on the page');
assert.doesNotMatch(optionBody, /isInsideTestCampaign\(/, 'locale dropdown fallback must not run expensive Test Campaign detection per candidate');
assert.match(bridgeSource, /async function waitForLocaleListCondition\(/, 'locale create/remove verification should use bounded polling');

console.log('✓ RetKit v0.6.6 editor responsiveness + auto-scan contract');
