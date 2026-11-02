// v0.9.9: вес письма в шапке HTML — те же пороги, что в студии.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const bridge = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');
const start = bridge.indexOf('  const WEIGHT_KB = 1024;');
const end = bridge.indexOf('  let weightGeneration = null;');
const { measureEmailWeight } = new Function(`${bridge.slice(start, end)}; return { measureEmailWeight };`)();
const pad = (n) => 'x'.repeat(n);
assert.equal(measureEmailWeight(`<html><body>${pad(50 * 1024)}</body></html>`).level, 'ok');
assert.equal(measureEmailWeight(`<body>${pad(95 * 1024)}</body>`).level, 'warn');
assert.equal(measureEmailWeight(`<body>${pad(103 * 1024)}</body>`).level, 'clip');
assert.equal(measureEmailWeight(`<style>${pad(17 * 1024)}</style><body>x</body>`).level, 'warn', 'big <style> is a warning even when light');
assert.equal(measureEmailWeight('ж').bytes, 2, 'UTF-8 bytes, not characters');
assert.match(measureEmailWeight(`<body>${pad(1024)}</body>`).label, /^⚖ 1(\.\d)? КБ$/);
assert.match(bridge, /try \{ paintWeightChip\(\); \} catch \{\}/, 'heartbeat keeps the weight current');
console.log('✓ v0.9.9: weight chip');
