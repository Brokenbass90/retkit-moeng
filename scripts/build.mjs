import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const corePath = path.join(root, 'src/core/retkit-moengage-core.user.js');
const bridgePath = path.join(root, 'src/retkit-moengage-v0.5.user.js');
const distPath = path.join(root, 'dist/retkit-moengage.user.js');

const core = fs.readFileSync(corePath, 'utf8');
const bridge = fs.readFileSync(bridgePath, 'utf8');

function splitUserscript(source) {
  const end = source.indexOf('// ==/UserScript==');
  if (end === -1) throw new Error('userscript metadata header not found');
  const after = end + '// ==/UserScript=='.length;
  return {
    header: source.slice(0, after),
    body: source.slice(after).replace(/^\s+/, ''),
  };
}

const coreParts = splitUserscript(core);
const bridgeParts = splitUserscript(bridge);
const header = bridgeParts.header
  .split('\n')
  .filter((line) => !/^\/\/ @require\s+/.test(line))
  .join('\n');

const output = `${header}\n\n${coreParts.body.trim()}\n\n${bridgeParts.body.trim()}\n`;
fs.mkdirSync(path.dirname(distPath), { recursive: true });
fs.writeFileSync(distPath, output);
console.log(`Built ${path.relative(root, distPath)} (${Buffer.byteLength(output)} bytes)`);
