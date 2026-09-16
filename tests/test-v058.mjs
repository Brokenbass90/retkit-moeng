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
}), true);

const allPlan = core.resolveTestLocaleSelectionPlan(
  ['EN', 'AR', 'ES', 'FR', 'ID', 'PT', 'TH', 'VI'],
  ['Default', 'ES', 'AR', 'FR', 'ID', 'PT', 'TH', 'VI'],
);
assert.equal(allPlan.useSelectAll, true, 'all requested locales should use native Select all');
assert.deepEqual([...allPlan.missing], []);

const subsetPlan = core.resolveTestLocaleSelectionPlan(
  ['EN', 'FR', 'AR'],
  ['Default', 'ES', 'AR', 'FR', 'ID', 'PT', 'TH', 'VI'],
);
assert.equal(subsetPlan.useSelectAll, false);
assert.deepEqual([...subsetPlan.labels], ['Default', 'FR', 'AR']);
assert.deepEqual([...subsetPlan.missing], []);

const missingPlan = core.resolveTestLocaleSelectionPlan(
  ['EN', 'TL'],
  ['Default', 'AR', 'ES'],
);
assert.deepEqual([...missingPlan.missing], ['TL']);

assert.equal(core.testLocaleLabelToDisplay('Default'), 'EN');
assert.equal(core.testLocaleLabelToDisplay('FR'), 'FR');

console.log('v0.5.8 regression tests passed');
