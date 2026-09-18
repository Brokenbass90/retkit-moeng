import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const panelPath = new URL('../src/ai/ui/ai-panel.js', import.meta.url);
const panelSource = fs.existsSync(panelPath) ? fs.readFileSync(panelPath, 'utf8') : '';
const sandbox = { console, globalThis: null };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
if (panelSource) vm.runInContext(panelSource, sandbox, { filename: 'ai-panel.js' });

const core = sandbox.__RetKitAiUiCore;
assert.ok(core, 'AI panel core should be exposed');
assert.equal(core.clampAiHeight(50, 800), 180);
assert.equal(core.clampAiHeight(760, 800), 620);
assert.equal(core.clampAiHeight(400, 800), 400);
assert.equal(core.nextAiPanelState({ open: false, height: 320 }, { type: 'toggle' }).open, true);
assert.equal(core.nextAiPanelState({ open: true, height: 320 }, { type: 'height', height: 410 }).height, 410);

assert.deepEqual(JSON.parse(JSON.stringify(core.providerStatusView({ detected: false, authenticated: 'no' }))), { label: 'Not detected', tone: 'error' });
assert.deepEqual(JSON.parse(JSON.stringify(core.providerStatusView({ detected: true, authenticated: 'unknown' }))), { label: 'Detected', tone: 'warning' });
assert.deepEqual(JSON.parse(JSON.stringify(core.providerStatusView({ detected: true, authenticated: 'no' }))), { label: 'Authentication required', tone: 'error' });
assert.deepEqual(JSON.parse(JSON.stringify(core.providerStatusView({ detected: true, authenticated: 'yes' }, { state: 'connected' }))), { label: 'Connected', tone: 'ok' });
assert.deepEqual(JSON.parse(JSON.stringify(core.providerStatusView({ detected: true, authenticated: 'yes' }, { state: 'busy' }))), { label: 'Busy', tone: 'ok' });
assert.deepEqual(JSON.parse(JSON.stringify(core.providerStatusView({ detected: true, authenticated: 'yes' }, { state: 'error', detail: 'boom' }))), { label: 'Error', tone: 'error', detail: 'boom' });
assert.equal(/%|tokens? left/i.test(core.providerStatusView({ detected: true, authenticated: 'yes' }, { state: 'connected' }).label), false);
assert.equal(core.normalizeAiMode('ask'), 'ask');
assert.equal(core.normalizeAiMode('agent'), 'agent');
assert.equal(core.normalizeAiMode('wat'), 'agent');
assert.equal(core.usageStatusText({ input_tokens: 1200, output_tokens: 300 }), 'Usage 1.5k tokens');
assert.equal(core.usageStatusText(null), '');


const dist = fs.readFileSync(new URL('../dist/retkit-moengage.user.js', import.meta.url), 'utf8');
assert.match(dist, /retkit-ai-toggle/);
assert.match(dist, /retkit-ai-panel/);
assert.match(dist, /retkit-ai-vertical-grip/);
assert.doesNotMatch(dist, /data-mode-choice=/, 'AI header should not expose Ask/Suggest/Agent mode buttons');
assert.match(dist, /retkit-ai-usage/, 'AI header should reserve provider usage/context status');

const chatPath = new URL('../src/ai/ui/chat-view.js', import.meta.url);
if (fs.existsSync(chatPath)) vm.runInContext(fs.readFileSync(chatPath, 'utf8'), sandbox, { filename: 'chat-view.js' });
const chatCore = sandbox.__RetKitAiChatCore;
assert.ok(chatCore, 'chat core should be exposed');
assert.equal(chatCore.keyAction({ key: 'Enter', shiftKey: false }), 'send');
assert.equal(chatCore.keyAction({ key: 'Enter', shiftKey: true }), 'newline');
assert.equal(chatCore.keyAction({ key: 'a', shiftKey: false }), 'none');


const attachmentPath = new URL('../src/ai/ui/attachment-dropzone.js', import.meta.url);
if (fs.existsSync(attachmentPath)) vm.runInContext(fs.readFileSync(attachmentPath, 'utf8'), sandbox, { filename: 'attachment-dropzone.js' });
const attachmentCore = sandbox.__RetKitAiAttachmentCore;
assert.ok(attachmentCore, 'attachment core should be exposed');
assert.equal(attachmentCore.validateAttachmentMeta({ name: 'x.png', type: 'image/png', size: 1024 }).ok, true);
assert.equal(attachmentCore.validateAttachmentMeta({ name: 'x.svg', type: 'image/svg+xml', size: 1024 }).ok, false);
assert.equal(attachmentCore.validateAttachmentMeta({ name: 'huge.png', type: 'image/png', size: 13 * 1024 * 1024 }).ok, false);
assert.equal(attachmentCore.limitAttachments([1,2,3,4,5]).length, 4);

console.log('✓ RetKit v0.6.0 AI panel');
