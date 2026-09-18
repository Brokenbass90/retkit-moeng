import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const panelSource = fs.readFileSync(new URL('../src/ai/ui/ai-panel.js', import.meta.url), 'utf8');
assert.doesNotMatch(panelSource, /data-mode-choice=/, 'AI header should not expose Ask/Suggest/Agent mode buttons');
assert.doesNotMatch(panelSource, /rk-ai-provider-row/, 'provider connection must not be duplicated in a second card');
assert.match(panelSource, /rk-ai-provider-dot/, 'provider buttons should carry their own connection indicator');

const attachmentSource = fs.readFileSync(new URL('../src/ai/ui/attachment-dropzone.js', import.meta.url), 'utf8');
const attachmentSandbox = { console, globalThis: null };
attachmentSandbox.globalThis = attachmentSandbox;
vm.createContext(attachmentSandbox);
vm.runInContext(attachmentSource, attachmentSandbox, { filename: 'attachment-dropzone.js' });
const attachmentCore = attachmentSandbox.__RetKitAiAttachmentCore;
assert.ok(attachmentCore);
assert.equal(attachmentCore.validateAttachmentMeta({ type: 'image/png', size: 100 }).ok, true);
assert.equal(attachmentCore.validateAttachmentMeta({ type: 'text/html', size: 100 }).ok, true, 'HTML files should be accepted for chat drag/drop');
assert.equal(attachmentCore.validateAttachmentMeta({ type: 'application/json', size: 100 }).ok, true, 'JSON files should be accepted for chat drag/drop');
assert.match(attachmentSource, /style\.setProperty\(['"]display['"],\s*['"]none['"],\s*['"]important['"]\)/, 'native file input must stay hidden even under MoEngage CSS');
assert.doesNotMatch(attachmentSource, /rk-ai-attach-btn/, 'chat should not expose a separate + attachment button');

const bridgeClientSource = fs.readFileSync(new URL('../src/ai/client/bridge-client.js', import.meta.url), 'utf8');
const bridgeSandbox = { console, globalThis: null };
bridgeSandbox.globalThis = bridgeSandbox;
vm.createContext(bridgeSandbox);
vm.runInContext(bridgeClientSource, bridgeSandbox, { filename: 'bridge-client.js' });
assert.equal(typeof bridgeSandbox.__RetKitAiBridgeCore?.shouldRecordBridgeFailure, 'function', 'bridge diagnostic gate should be exported');
assert.equal(bridgeSandbox.__RetKitAiBridgeCore.shouldRecordBridgeFailure(false, 'error'), false, 'initial offline/error state is not an incident');
assert.equal(bridgeSandbox.__RetKitAiBridgeCore.shouldRecordBridgeFailure(true, 'error'), true, 'failure after a successful connection is an incident');

const localeSource = fs.readFileSync(new URL('../src/retkit-moengage-v0.5.user.js', import.meta.url), 'utf8');
assert.doesNotMatch(localeSource, /collect\(['"]div,span['"]\)/, 'locale bar discovery must never scan every div/span in MoEngage');
const addStart = localeSource.indexOf('function findNativeAddLocaleTrigger()');
const addEnd = localeSource.indexOf('\n  function ', addStart + 20);
const addBody = localeSource.slice(addStart, addEnd);
assert.ok(addStart >= 0);
assert.doesNotMatch(addBody, /roots\.push\(document\.body\)|document\.body\.querySelectorAll/, '+ Locale trigger search must stay near the locale bar');
assert.doesNotMatch(addBody, /div,span/, '+ Locale trigger search must stay semantic');
assert.doesNotMatch(addBody, /isInsideTestCampaign\(/, '+ Locale trigger hot path must not rescan Test Campaign for every candidate');
assert.doesNotMatch(localeSource, /testCampaignSectionCacheAt/, 'stable Send test locator must not retain the stale negative Test Campaign cache');
const candidateStart = localeSource.indexOf('function collectNativeLocaleCandidates()');
const candidateEnd = localeSource.indexOf('\n  function findNativeLocaleBar', candidateStart);
const candidateBody = localeSource.slice(candidateStart, candidateEnd);
assert.doesNotMatch(candidateBody, /findTestCampaignSection\(|isInsideTestCampaign\(/, 'locale discovery must not invoke expensive Test Campaign discovery');
assert.match(localeSource, /MutationObserver/, 'locale popup discovery should be event-driven instead of polling full DOM');
const waitStart = localeSource.indexOf('function waitForNativeAddLocaleMenu');
const waitEnd = localeSource.indexOf('\n  async function openNativeAddLocaleMenu', waitStart);
const waitBody = localeSource.slice(waitStart, waitEnd);
assert.doesNotMatch(waitBody, /findOpenAddLocaleMenuRoot\(/, 'native + Locale popup wait must inspect the newly mounted popup, not rescan page checkboxes');

const popStart = localeSource.indexOf('async function renderAddLocalePopover()');
const popEnd = localeSource.indexOf('\n  function closeWorkspaceForNativeSection', popStart);
const popBody = localeSource.slice(popStart, popEnd);
assert.ok(popBody.indexOf('document.body.appendChild(pop)') >= 0 && popBody.indexOf('document.body.appendChild(pop)') < popBody.indexOf('await listNativeAddableLocales()'), 'RetKit locale popover should render before native locale discovery begins');

console.log('✓ RetKit v0.6.5 UI + locale performance contract');
