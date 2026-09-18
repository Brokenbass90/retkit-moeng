import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const name = `retkit-moengage-v${pkg.version}`;
const releaseRoot = path.join(root, 'release');
const target = path.join(releaseRoot, name);
const excluded = new Set(['.git', '.worktrees', 'node_modules', 'release', '.DS_Store']);

async function copyTree(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
  }
}

await fs.rm(target, { recursive: true, force: true });
await fs.mkdir(releaseRoot, { recursive: true });
await copyTree(root, target);

const zipPath = path.join(releaseRoot, `${name}.zip`);
await fs.rm(zipPath, { force: true });
const zip = spawnSync('zip', ['-qr', zipPath, name], { cwd: releaseRoot, stdio: 'inherit' });
if (zip.error?.code === 'ENOENT') console.log(`Packaged folder ${path.relative(root, target)} (zip command unavailable)`);
else if (zip.status !== 0) throw new Error(`zip failed with status ${zip.status}`);
else console.log(`Packaged ${path.relative(root, zipPath)}`);
