import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// RTL Fix = полная арабизация тем же движком, что в студии.
// Эталон команды: tests/fixtures/rtl/photo-welcome2.source.html → .ar-rtl.expected.html
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const sb = { globalThis: {} };
sb.globalThis.globalThis = sb.globalThis;
vm.createContext(sb);
vm.runInContext(read('src/shared/rtl-core.js'), sb);
const engine = sb.globalThis.RetKitRtlCore;
assert.ok(engine?.applyRtl, 'engine exposed as RetKitRtlCore');

const source = read('tests/fixtures/rtl/photo-welcome2.source.html');
const expected = read('tests/fixtures/rtl/photo-welcome2.ar-rtl.expected.html');
const out = engine.applyRtl(source, { mode: 'document', lang: 'ar' });

const PROPS = ['text-align', 'padding-left', 'padding-right', 'margin-left', 'margin-right', 'float', 'direction'];
const elements = (html) => [...html.replace(/<style[\s\S]*?<\/style>/gi, '').matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)]
  .filter((m) => !/^(?:br|meta)$/i.test(m[1]))
  .map((m) => {
    const attr = (n) => (m[2].match(new RegExp(`\\b${n}\\s*=\\s*"([^"]*)"`, 'i')) || [])[1] || '';
    const style = attr('style');
    const props = {};
    for (const p of PROPS) {
      const all = [...style.matchAll(new RegExp(`(?:^|;)\\s*${p}\\s*:\\s*([^;]+)`, 'gi'))];
      if (all.length) props[p] = all[all.length - 1][1].trim();
    }
    return JSON.stringify({ tag: m[1].toLowerCase(), dir: attr('dir'), align: attr('align'), props });
  });
const got = elements(out);
const want = elements(expected);
assert.equal(got.length, want.length);
const diffs = got.map((g, i) => (g === want[i] ? null : `${i}: ${g} ≠ ${want[i]}`)).filter(Boolean);
assert.equal(diffs.length, 0, diffs.slice(0, 3).join('\n'));
assert.equal(engine.applyRtl(out, { mode: 'document' }), out, 'idempotent');

// Та же копия, что в студии (если студия лежит рядом).
const studio = path.resolve(root, '..', '..', 'retantion-future', 'email-base', 'tools', 'rtl.js');
if (fs.existsSync(studio)) {
  const body = fs.readFileSync(studio, 'utf8').replace(/^\s*'use strict';\s*$/m, '');
  assert.ok(read('src/shared/rtl-core.js').includes(body), 'run: node scripts/sync-rtl-core.mjs');
}

const bridge = read('src/moengage/native-bridge.user.js');
assert.match(bridge, /documentRtl\(currentHtml, active\) \|\| transformRtlHtml\(/, 'RTL Fix uses the document engine, old one as fallback');
assert.match(read('scripts/build.mjs'), /src\/shared\/rtl-core\.js/);
assert.ok(read('dist/retkit-moengage.user.js').includes('root.RetKitRtlCore = module.exports'), 'engine is in the built userscript');

console.log('v0.8.3 RTL Fix = document arabization: ok');
