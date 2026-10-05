import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VERSION_PATTERNS } from '../scripts/version-files.mjs';

const root = new URL('../', import.meta.url);
const expected = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')).version;
for (const { file, re } of VERSION_PATTERNS) {
  const source = fs.readFileSync(new URL(file, root), 'utf8');
  const matches = [...source.matchAll(new RegExp(re.source, 'g'))];
  assert.ok(matches.length, `version marker missing in ${file}`);
  for (const match of matches) assert.equal(match[2], expected, `${file} carries ${match[2]}, package.json says ${expected}`);
}
const dist = fs.readFileSync(new URL('dist/retkit-moengage.user.js', root), 'utf8');
assert.match(dist, new RegExp(`@version\\s+${expected.replace(/\./g, '\\.')}\\b`), 'dist must be rebuilt for the current version');
console.log(`✓ RetKit version ${expected} is consistent across ${VERSION_PATTERNS.length} markers`);
