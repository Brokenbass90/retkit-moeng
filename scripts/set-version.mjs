import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION_PATTERNS } from './version-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next || '')) {
  console.error('usage: npm run version:set -- <major.minor.patch>');
  process.exit(1);
}
for (const { file, re } of VERSION_PATTERNS) {
  const full = path.join(root, file);
  const source = fs.readFileSync(full, 'utf8');
  re.lastIndex = 0;
  if (!re.test(source)) throw new Error(`version marker not found in ${file}: ${re}`);
  re.lastIndex = 0;
  fs.writeFileSync(full, source.replace(re, (_, a, _v, b) => `${a}${next}${b}`));
}
console.log(`RetKit version set to ${next} in ${new Set(VERSION_PATTERNS.map((p) => p.file)).size} files. Run npm run build.`);
