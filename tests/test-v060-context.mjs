import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const file = new URL('../src/ai/context/context-adapter.js', import.meta.url);
const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const sandbox = { console, globalThis: null, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
if (source) vm.runInContext(source, sandbox, { filename: 'context-adapter.js' });

const core = sandbox.__RetKitAiContextCore;
assert.ok(core, 'context core should be exposed');
assert.equal(core.stableHash('abc'), core.stableHash('abc'));
assert.notEqual(core.stableHash('abc'), core.stableHash('abcd'));

const context = await core.buildInitialContext({
  getCurrentHtml: () => '<html lang="en"><p>Hello</p></html>',
  getSubject: () => 'Hello',
  getActiveLocale: () => 'EN',
  listLocales: () => ['EN', 'AR', 'FR'],
  getSelectedSource: () => ({ text: '<p>Hello</p>', from: 16, to: 28 }),
  getValidatorIssues: () => [{ severity: 'warning', code: 'img-alt', line: 10, message: 'Missing alt' }],
  getPreviewMode: () => 'desktop',
});
assert.equal(context.activeLocale, 'EN');
assert.equal(context.subject, 'Hello');
assert.equal(context.currentHtml.includes('Hello'), true);
assert.deepEqual(JSON.parse(JSON.stringify(context.locales)), ['EN','AR','FR']);
assert.equal('localeHtml' in context, false, 'initial context must not eagerly include all locale HTML');
assert.equal(context.validator.count, 1);

const state = { html: '<p>A</p>', subject: 'Subject A', snapshots: [], calls: [] };
const api = {
  getCurrentHtml: () => state.html,
  getSubject: () => state.subject,
  getActiveLocale: () => 'EN',
  saveAiSnapshot: ({ html, subject }) => state.snapshots.push({ html, subject }),
  setHtml: async (html) => { state.calls.push(['html', html]); state.html = html; return true; },
  setSubject: async (subject) => { state.calls.push(['subject', subject]); state.subject = subject; return true; },
};
const store = core.createProposalStore(api);
const proposal = store.proposeHtml({ baseHash: core.stableHash(state.html), html: '<p>B</p>', summary: 'Change A to B' });
state.html = '<p>changed manually</p>';
await assert.rejects(store.apply(proposal.id), (error) => error?.code === 'STALE_PROPOSAL');

state.html = '<p>A</p>';
const proposal2 = store.proposeHtml({ baseHash: core.stableHash(state.html), html: '<p>B</p>', summary: 'Change A to B' });
await store.apply(proposal2.id);
assert.equal(state.html, '<p>B</p>');
assert.equal(state.snapshots.length, 1);
assert.equal(state.snapshots[0].html, '<p>A</p>');
await store.undo();
assert.equal(state.html, '<p>A</p>');

console.log('✓ RetKit v0.6.0 AI context/proposals');
