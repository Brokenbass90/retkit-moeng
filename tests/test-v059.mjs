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

// Regression: the Test Campaign locale label can span a wide row. Scoring by
// centre point accidentally prefers the Send via dropdown in the next column.
const labelRect = { left: 110, right: 791, top: 555, bottom: 575, width: 681, height: 20 };
const localeRect = { left: 115, right: 451, top: 583, bottom: 615, width: 336, height: 32 };
const sendViaRect = { left: 482, right: 742, top: 583, bottom: 617, width: 260, height: 34 };
const localeScore = core.labeledControlGeometryScore(labelRect, localeRect);
const sendViaScore = core.labeledControlGeometryScore(labelRect, sendViaRect);
assert.ok(localeScore < sendViaScore, `locale control should beat adjacent Send via control (${localeScore} < ${sendViaScore})`);

// Regression: MoEngage MDS dropdowns are not guaranteed to react to a plain
// HTMLElement.click(). The bridge should have an explicit activation fallback.
const calls = [];
const fake = {
  focus() { calls.push('focus'); },
  click() { calls.push('click'); },
  dispatchEvent(event) { calls.push(event.type); return true; },
};
const eventFactory = (type) => ({ type });
core.activateNativeControl(fake, eventFactory);
assert.deepEqual(calls, ['focus', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);

console.log('v0.5.9 regression tests passed');
