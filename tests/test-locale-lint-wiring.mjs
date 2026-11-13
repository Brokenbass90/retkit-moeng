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
