// Copies the studio's RTL core (retantion-future/email-base/tools/rtl.js) into
// RetKit as a browser module. One transformer for both tools: RTL Fix in
// MoEngage and the studio produce the same Arabic email.
//   node scripts/sync-rtl-core.mjs [path/to/rtl.js]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.resolve(process.argv[2] || path.join(root, '..', '..', 'retantion-future', 'email-base', 'tools', 'rtl.js'));
const to = path.join(root, 'src', 'shared', 'rtl-core.js');
if (!fs.existsSync(from)) {
  console.log(`[sync-rtl-core] studio copy not found at ${from}; keeping ${path.relative(root, to)}`);
  process.exit(0);
}
const body = fs.readFileSync(from, 'utf8').replace(/^\s*'use strict';\s*$/m, '');
const out = `// GENERATED from retantion-future/email-base/tools/rtl.js by scripts/sync-rtl-core.mjs.
// Do not edit here — change the studio file and re-run the script.
(function (root) {
  'use strict';
  const module = { exports: {} };
${body}
  root.RetKitRtlCore = module.exports;
})(typeof globalThis !== 'undefined' ? globalThis : this);
`;
fs.writeFileSync(to, out);
console.log(`[sync-rtl-core] ${path.relative(root, to)} ← ${from}`);
