import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const diagnosticsPath = path.join(root, 'src/diagnostics/incident-recorder.js');
const functionMapPath = path.join(root, 'src/diagnostics/function-map.js');
const corePath = path.join(root, 'src/core/retkit-moengage-core.user.js');
const bridgePath = path.join(root, 'src/moengage/native-bridge.user.js');
const distPath = path.join(root, 'dist/retkit-moengage.user.js');

const aiModulePaths = [
  'src/shared/replace-across.js',
  'src/shared/rtl-core.js',
  'src/backup/original-snapshots.js',
  'src/ai/shared/protocol.js',
  'src/ai/client/bridge-client.js',
  'src/ai/context/context-adapter.js',
  'src/ai/ui/attachment-dropzone.js',
  'src/ai/ui/diff-view.js',
  'src/ai/ui/connect-card.js',
  'src/ai/ui/chat-view.js',
  'src/ai/ui/ai-panel.js',
];

const diagnostics = fs.readFileSync(diagnosticsPath, 'utf8');
const functionMap = fs.readFileSync(functionMapPath, 'utf8');
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

const aiModules = aiModulePaths
  .filter((relativePath) => fs.existsSync(path.join(root, relativePath)))
  .map((relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8').trim());

const sections = [diagnostics.trim(), functionMap.trim(), coreParts.body.trim(), ...aiModules, bridgeParts.body.trim()];
const output = `${header}\n\n${sections.join('\n\n')}\n`;
fs.mkdirSync(path.dirname(distPath), { recursive: true });
fs.writeFileSync(distPath, output);
console.log(`Built ${path.relative(root, distPath)} (${Buffer.byteLength(output)} bytes)`);
