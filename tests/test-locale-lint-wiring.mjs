// RetKit for MoEngage wires the shared locale-lint: dist ships it, tabs get marks, agents get a tool.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const dist = read('dist/retkit-moengage.user.js');
const core = read('src/core/retkit-moengage-core.user.js');
assert.ok(dist.includes('root.RetKitLocaleLint = api'), 'dist ships the checker');
assert.ok(dist.includes('root.RetKitLocaleLintData'), 'dist ships the language models');
assert.ok(dist.indexOf('root.RetKitLocaleLintData') < dist.indexOf('root.RetKitLocaleLint = api'), 'models load before the checker');
assert.ok(core.includes('lintLocales: aiLintLocales'), 'workspace API exposes the check to agents');
assert.ok(core.includes("rememberActiveLocaleHtml(html)"), 'edits of the open locale re-check it');
assert.ok(core.includes('rememberLocaleHtmlMap(htmlByLocale, locales)'), 'across-locales search feeds the checker');
assert.ok(read('src/moengage/native-bridge.user.js').includes('tab.dataset.rkLocale'), 'locale tabs carry their code for marks');
assert.ok(read('src/ai/client/agent-relay.js').includes("tool === 'lint_locales'"), 'relay answers lint_locales');
assert.ok(read('bridge/src/tools/retkit-tools.mjs').includes("name: 'lint_locales'"), 'bridge tool list has lint_locales');
for (const f of ['locale-lint.js', 'locale-lint-data.js']) assert.equal(read(`shared/${f}`), read(`src/shared/${f}`), `shared/${f} is published as is`);
console.log('✓ locale-lint wiring: dist, workspace API, tab marks, agent relay, bridge tool, shared/ copies');

// Live case 16.11: paste → fast undo while a sync is in flight.
assert.ok(core.includes("if (result?.ok && nativeNow && htmlEquivalentForSync(nativeNow, next)) rememberNativeHtml(nativeNow);"), 'a stale sync still remembers what it wrote');
assert.ok(core.includes('STATE.localeLintRetryTimer = setTimeout(() => rememberActiveLocaleHtml('), 'an edit during the switch window is re-checked, not dropped');
console.log('✓ live fixes: stale sync remembers its write; locale dot follows undo');

// 0.10.2: dots without a click; another campaign in the same tab starts clean.
{
  const core2 = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
  assert.ok(core2.includes("status('Loaded from MoEngage', 'ok');\n      scheduleAutoLocaleLint();"), 'auto check on open');
  assert.ok(core2.includes('STATE.localeLintAutoKey = STATE.localeLintCampaign;'), 'once per campaign');
  assert.ok(/const busy = STATE\.dirty \|\| STATE\.applying/.test(core2), 'never while an edit is syncing');
  assert.ok(core2.includes('STATE.localeHtmlCache = {};'), 'cache is per campaign');
  console.log('✓ auto locale check on open, per campaign, idle only');
}

// 0.10.6: click an issue → its place in code and preview; «игнор» hides the case in every locale of this email.
{
  const core3 = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
  assert.ok(core3.includes("row.addEventListener('click', () => { void revealLocaleIssue(item); });"), 'row reveals the issue');
  assert.ok(core3.includes('editor.scrollIntoView({ from, to }, 140);') && core3.includes("best.scrollIntoView({ block: 'center' });"), 'code and preview scroll to it');
  assert.ok(core3.includes('ignore: localeLintIgnored()'), 'ignore list goes to the checker');
  assert.ok(core3.includes('retkit-mo-lint-ignore:${String(location.pathname'), 'ignore list per email');
  console.log('✓ issue click reveals code + preview; ignore per email in all locales');
}

// 0.10.7: the agent sees the locale-check summary in status and read_email without a separate call.
{
  const relay = fs.readFileSync(new URL('../src/ai/client/agent-relay.js', import.meta.url), 'utf8');
  assert.ok(relay.includes('...lintHint(),') && relay.includes('hash: stableHash(html), ...lintHint() };'), 'status + read_email carry localeLint');
  console.log('✓ agent sees localeLint in status / read_email');
}
