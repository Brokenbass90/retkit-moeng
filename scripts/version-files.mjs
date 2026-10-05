// Single list of every place that carries the RetKit version.
// `npm run version:set -- 0.7.1` rewrites them; tests/test-version-consistency
// fails the build if any of them drifts from package.json.
export const VERSION_PATTERNS = [
  { file: 'package.json', re: /("version":\s*")(\d+\.\d+\.\d+)(")/ },
  { file: 'package-lock.json', re: /("version":\s*")(\d+\.\d+\.\d+)(")/g },
  { file: 'bridge/package.json', re: /("version":\s*")(\d+\.\d+\.\d+)(")/ },
  { file: 'bridge/package-lock.json', re: /("version":\s*")(\d+\.\d+\.\d+)(")/g },
  { file: 'bridge/src/protocol.mjs', re: /(BRIDGE_VERSION = ')(\d+\.\d+\.\d+)(')/ },
  { file: 'bridge/src/providers/codex.mjs', re: /(title: 'RetKit AI Workbench', version: ')(\d+\.\d+\.\d+)(')/ },
  { file: 'bridge/src/mcp/stdio-server.mjs', re: /(title: 'RetKit AI Tools', version: ')(\d+\.\d+\.\d+)(')/ },
  { file: 'src/core/retkit-moengage-core.user.js', re: /(\/\/ @version\s+)(\d+\.\d+\.\d+)()/ },
  { file: 'src/core/retkit-moengage-core.user.js', re: /(<span class="rk-version">v)(\d+\.\d+\.\d+)(<\/span>)/ },
  { file: 'src/core/retkit-moengage-core.user.js', re: /(version: ')(\d+\.\d+\.\d+)(',\n\s+getHtml)/ },
  { file: 'src/core/retkit-moengage-core.user.js', re: /(MoEngage workspace v)(\d+\.\d+\.\d+)( loaded)/ },
  { file: 'src/ai/client/bridge-client.js', re: /(clientVersion: ')(\d+\.\d+\.\d+)(')/ },
  { file: 'src/moengage/native-bridge.user.js', re: /(\/\/ @version\s+)(\d+\.\d+\.\d+)()/ },
  { file: 'src/moengage/native-bridge.user.js', re: /(setTextContentIfChanged\(version, 'v)(\d+\.\d+\.\d+)('\))/ },
  { file: 'src/moengage/native-bridge.user.js', re: /(MoEngage bridge v)(\d+\.\d+\.\d+)( loaded)/ },
];
