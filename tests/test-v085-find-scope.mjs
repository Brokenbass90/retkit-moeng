import assert from 'node:assert/strict';
import fs from 'node:fs';

const core = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');

// v0.8.5: typing in Find searches only the open locale. Walking all locales
// switches MoEngage tabs, so it starts only from "Search all locales".
const slice = (from, to) => {
  const a = core.indexOf(from);
  const b = core.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} must exist`);
  return core.slice(a, b);
};
const inputHandler = slice("find.addEventListener('input'", "find.addEventListener('keydown'");
assert.doesNotMatch(inputHandler, /scheduleMultiLocaleAutoScan|scanMultiLocaleReplace/, 'typing must not walk locales');
assert.match(inputHandler, /resetMultiLocalePlanForQuery/, 'typing drops a stale all-locales result');

const open = slice('function openFindBar()', 'function replaceCurrent()');
assert.doesNotMatch(open, /scheduleMultiLocaleAutoScan/, 'opening Find must not walk locales');
const replaceAll = slice('function replaceAllMatches()', 'function captureEditorViewState()');
assert.doesNotMatch(replaceAll, /scheduleMultiLocaleAutoScan/, 'replace in this locale must not walk locales');
const apply = slice('async function applyMultiLocaleReplace', 'function renderMultiLocaleDrawer');
assert.doesNotMatch(apply, /scheduleMultiLocaleAutoScan/, 'bulk replace must not re-walk locales by itself');
const drawer = slice('function renderMultiLocaleDrawer', 'function renderMultiLocaleDetails');
assert.doesNotMatch(drawer, /scheduleMultiLocaleAutoScan/, 'mode toggle must not walk locales');

assert.match(core, /searchAll\.addEventListener\('click', \(\) => requestMultiLocaleScan\(\)\)/, 'button starts the walk');
const scan = slice('async function scanMultiLocaleReplace', 'function resetMultiLocalePlanForQuery');
assert.match(scan, /multiLocalePlanKey = /, 'a finished walk remembers which query it answered');

// Sync rejection diagnostics now say what MoEngage kept.
assert.match(core, /function describeHtmlDifference\(/, 'diff helper exists');
assert.match(core, /outcome === 'reverted'/, 'reverted vs changed are told apart');

// describeHtmlDifference behaviour
const fnSrc = slice('function describeHtmlDifference(', '\n  }\n') + '\n  }';
// eslint-disable-next-line no-new-func
const describe = new Function(`${fnSrc}; return describeHtmlDifference;`)();
const d = describe('<p>abc</p><b>x</b>', '<p>abc</p><b style="y">x</b>');
assert.equal(d.at, 12);
assert.equal(d.lengthDelta, 10);
assert.equal(d.expected, '');
assert.equal(d.actual, ' style="y"');
assert.equal(describe('same', 'same').lengthDelta, 0);

console.log('✓ RetKit v0.8.5 find scope + sync diff diagnostics');

// Every bulk replace leaves a persistent report with before → after snippets.
assert.match(core, /diagIncident\('multilocale_apply_report'/, 'bulk replace report is an incident (persists across reloads)');
assert.match(core, /function replaceSnippets\(/, 'report shows what changed around each match');
console.log('✓ RetKit v0.8.5 bulk replace report');

// v0.8.5 safety after the "aff=764878 deleted" incident.
const applyAll = slice('async function applyMultiLocaleReplace()', 'async function applyMultiLocaleReplaceRun');
assert.match(applyAll, /STATE\.multiLocaleApplying = true/, 'busy is taken before the first await (no double run)');
assert.ok(applyAll.indexOf('STATE.multiLocaleApplying = true') < applyAll.indexOf('await '), 'lock precedes any await');
assert.match(applyAll, /=== ''[\s\S]*root\.confirm/, 'an empty replacement asks before deleting');
assert.match(applyAll, /resetMultiLocalePlanForQuery\(true\)/, 'a finished run needs a new search before another replace');
assert.match(core, /with \$\{shown\}/, 'the button shows the replacement value or DELETE');
console.log('✓ RetKit v0.8.5 bulk replace: no double run, no silent delete');
