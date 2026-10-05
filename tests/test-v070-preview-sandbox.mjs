import assert from 'node:assert/strict';
import fs from 'node:fs';

// The preview iframe must stay same-origin (RetKit reads and patches its DOM)
// but must never run email scripts with MoEngage dashboard privileges.
const source = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const match = source.match(/frame\.setAttribute\('sandbox', '([^']*)'\)/);
assert.ok(match, 'preview iframe must declare a sandbox');
const tokens = match[1].split(/\s+/).filter(Boolean);
assert.deepEqual(tokens, ['allow-same-origin'], 'preview sandbox must not allow scripts, forms or popups');
console.log('v0.7.0 preview sandbox checks passed');
