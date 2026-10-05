// Runs the whole RetKit test suite: syntax check of every source file, then
// every tests/test-*.mjs in its own Node process (in parallel).
// Usage: node scripts/test.mjs [filter]   e.g. `npm test -- locale`
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = 'dist/retkit-moengage.user.js';
const filter = process.argv[2] || '';

function walk(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(rel) : (/\.m?js$/.test(entry.name) ? [rel] : []);
  });
}

if (!filter) {
  for (const file of [...walk('src'), dist]) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) {
      process.stderr.write(result.stderr);
      console.error(`✗ syntax: ${file}`);
      process.exit(1);
    }
  }
  console.log('✓ syntax check: src/** and dist');
}

const tests = fs.readdirSync(path.join(root, 'tests'))
  .filter((name) => /^test-.*\.mjs$/.test(name) && name.includes(filter))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

function run(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('tests', name), dist], { cwd: root });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ name, code, output }));
  });
}

const queue = [...tests];
const failures = [];
const workers = Array.from({ length: Math.max(1, Math.min(8, os.cpus().length)) }, async () => {
  while (queue.length) {
    const result = await run(queue.shift());
    if (result.code === 0) console.log(`✓ ${result.name}`);
    else { failures.push(result); console.log(`✗ ${result.name}`); }
  }
});
await Promise.all(workers);

for (const failure of failures) {
  console.error(`\n──── ${failure.name} ────\n${failure.output.trim()}`);
}
console.log(`\n${tests.length - failures.length}/${tests.length} test files passed`);
process.exit(failures.length ? 1 : 0);
