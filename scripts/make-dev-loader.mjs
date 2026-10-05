// Creates dev/retkit-dev-loader.user.js — install it in Tampermonkey ONCE.
// It loads dist/retkit-moengage.user.js straight from this folder on every
// MoEngage page load: after `npm run build` (or git pull) just reload the tab.
// Needs: chrome://extensions → Tampermonkey → Details → "Allow access to file URLs".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localDist = path.join(root, 'dist/retkit-moengage.user.js');
// Optional: absolute path as seen by the browser's computer (if generated elsewhere).
const distFile = process.argv[2] || localDist;
const header = fs.readFileSync(localDist, 'utf8').split('// ==/UserScript==')[0];
const match = (header.match(/^\/\/ @match\s+.+$/gm) || ['// @match        https://dashboard-02.moengage.com/*']).join('\n');
const out = `// ==UserScript==
// @name         RetKit for MoEngage (local build)
// @namespace    https://github.com/Brokenbass90/retkit-moeng/dev
// @version      1.0.0
// @description  Loads RetKit from ${distFile} on every page load. Disable the regular RetKit script while this one is on.
${match}
// @require      ${pathToFileURL(distFile).href}
// @grant        none
// @run-at       document-idle
// ==/UserScript==
// Everything comes from the @require above.
`;
fs.mkdirSync(path.join(root, 'dev'), { recursive: true });
const target = path.join(root, 'dev/retkit-dev-loader.user.js');
fs.writeFileSync(target, out);
console.log(`Created ${path.relative(root, target)} → loads ${distFile}`);
