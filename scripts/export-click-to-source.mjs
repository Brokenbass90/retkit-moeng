// Exports RetKit's preview-click -> source matcher as a standalone browser
// module so other RetKit tools (Retention Future Studio) use the exact same,
// tested logic. Output: shared/click-to-source.js (exposes globalThis.RetKitClickToSource).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corePath = path.join(root, 'src/core/retkit-moengage-core.user.js');
const outPath = path.join(root, 'shared/click-to-source.js');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const core = fs.readFileSync(corePath, 'utf8');

const FUNCTIONS = [
  'escapeRegExp', 'decodeHtmlText', 'normalizeComparableText', 'findOccurrenceIndex',
  'findTextOccurrenceRange', 'findTagOccurrenceStart', 'findTextNodeRangeInElement',
  'findElementRange', 'findElementContentRange', 'findEnclosingElementContentRangeAtIndex',
  'findOpeningTagStart', 'findRangeFromDescriptor', 'parseTagName',
  'normalizePointText', 'textNodeRectsHit', 'textNodeAtPoint', 'textNodeGlobalOccurrence',
  'getPointTextFromClick', 'countOccurrenceInDocument', 'descriptorFromElement',
];

function extractFunction(name) {
  const start = core.indexOf(`\n  function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in core`);
  const end = core.indexOf('\n  }\n', start);
  if (end === -1) throw new Error(`end of ${name} not found`);
  return core.slice(start + 1, end + 4);
}

function extractConst(name) {
  const start = core.indexOf(`\n  const ${name} = `);
  if (start === -1) throw new Error(`const ${name} not found in core`);
  const end = core.indexOf(');\n', start);
  return core.slice(start + 1, end + 3);
}

const body = [extractConst('VOID_TAGS'), ...FUNCTIONS.map(extractFunction)].join('\n\n');
const output = `/*! RetKit click-to-source v${pkg.version} — generated from retkit-moeng
 *  src/core/retkit-moengage-core.user.js by scripts/export-click-to-source.mjs.
 *  Do not edit by hand: change the core, run \`npm run build\`, copy shared/click-to-source.js. */
(function (root) {
  'use strict';

${body}

  // Map a click inside a same-origin preview document to a source range.
  // Returns { kind, start, end, descriptor } or null.
  function resolveClick(event, doc, source) {
    const target = event?.target?.nodeType === 1 ? event.target : event?.target?.parentElement;
    if (!target || !doc) return null;
    const point = getPointTextFromClick(event, doc);
    const descriptor = descriptorFromElement(target, doc, point);
    const range = findRangeFromDescriptor(String(source || ''), descriptor);
    return range ? { ...range, descriptor } : null;
  }

  root.RetKitClickToSource = {
    version: '${pkg.version}',
    findRangeFromDescriptor,
    descriptorFromElement,
    getPointTextFromClick,
    findOccurrenceIndex,
    findTextOccurrenceRange,
    resolveClick,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
`;
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, output);
console.log(`Built ${path.relative(root, outPath)} (${Buffer.byteLength(output)} bytes)`);

// The smart find/replace core is already standalone: publish it next to the matcher.
const replaceSrc = path.join(root, 'src/shared/replace-across.js');
const replaceOut = path.join(root, 'shared/replace-across.js');
fs.writeFileSync(replaceOut, fs.readFileSync(replaceSrc, 'utf8'));
console.log(`Built ${path.relative(root, replaceOut)}`);
