import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const file = process.argv[2];
const code = fs.readFileSync(file, 'utf8');
const context = { console, globalThis: null };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(code, context, { filename: file });
const core = context.__RetKitMoEngageBridgeCore;
assert.ok(core, 'bridge core should be exported');

assert.equal(core.isTextLikeSubjectFieldMeta({
  tagName: 'DIV', contentEditable: 'true', placeholder: 'Email Subject', role: 'contentinfo'
}), true, 'contenteditable Email Subject DIV must be recognized');
assert.equal(core.isTextLikeSubjectFieldMeta({
  tagName: 'DIV', contentEditable: 'true', placeholder: 'Preview Text', role: 'contentinfo'
}), false, 'Preview Text DIV must not be mistaken for Subject');

assert.equal(core.isMdsPopupOptionMeta({
  className: 'mds-dropdown__popup__list__item ignore-lang',
  text: 'Email ID (Non-registered users)'
}, 'Email ID (Non-registered users)'), true, 'exact MDS Send via option must match');
assert.equal(core.isMdsPopupOptionMeta({
  className: 'mds-dropdown__popup__list__item ignore-lang',
  text: 'Email ID (Registered users)'
}, 'Email ID (Non-registered users)'), false, 'wrong Send via option must not match');

assert.equal(core.rtlToggleDecision('BEFORE', 'AFTER', 'AFTER'), 'revert');
assert.equal(core.rtlToggleDecision('BEFORE', 'AFTER', 'CHANGED AFTER RTL'), 'apply');

const rtl = core.ensureRtlOpeningTag('<table align="left" style="text-align: left; width:100%">');
assert.equal(rtl.changed, true);
assert.match(rtl.value, /dir="rtl"/);
assert.match(rtl.value, /align="right"/);
assert.match(rtl.value, /text-align: right/);

console.log('v0.5.7 regression tests passed');
