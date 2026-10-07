import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RETKIT_TOOL_NAMES } from '../bridge/src/tools/retkit-tools.mjs';

// Models get the same across-locales flow as people, and never write by themselves.
assert.ok(RETKIT_TOOL_NAMES.includes('find_across_locales'));
assert.ok(RETKIT_TOOL_NAMES.includes('propose_replace_across_locales'));
const adapter = fs.readFileSync(new URL('../src/ai/context/context-adapter.js', import.meta.url), 'utf8');
const block = adapter.slice(adapter.indexOf("case 'propose_replace_across_locales'"), adapter.indexOf("case 'apply_approved_patch'"));
assert.match(block, /mode === 'ask'/, 'ask mode cannot prepare replacements');
assert.match(block, /awaiting_user/, 'replacement waits for the user click');
assert.doesNotMatch(block, /applyMultiLocaleReplace|setLocaleHtml/, 'the model path never writes to MoEngage');
const core = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const fn = core.slice(core.indexOf('async function aiAcrossLocales'), core.indexOf('root.__RetKitAiWorkspaceApi = {'));
assert.match(fn, /scanMultiLocaleReplace\(\)/);
assert.doesNotMatch(fn, /applyMultiLocaleReplace\(/);
console.log('✓ AI across-locales tools: find + user-approved replace');

// Own replacement per locale: the bulk apply takes the locale's own value first.
const applyBody = core.slice(core.indexOf('async function applyMultiLocaleReplace'), core.indexOf('\n  async function refreshLocaleManager'));
assert.match(applyBody, /multiLocaleOverrides/, 'bulk apply honours per-locale values');
// v0.8.5: per-locale values stay for AI tools only; the UI has one replacement field
// (a per-locale field was mistaken for the main one and deleted text in 8 locales).
assert.doesNotMatch(core, /dataset\.rkLocaleOverride/, 'no per-locale input in the UI');
console.log('✓ per-locale replacement values');
