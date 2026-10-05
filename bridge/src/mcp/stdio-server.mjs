import { fileURLToPath } from 'node:url';
import { RETKIT_TOOL_SPECS, RETKIT_TOOL_NAMES } from '../tools/retkit-tools.mjs';

const TOOL_SET = new Set(RETKIT_TOOL_NAMES);

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message: String(message || code) } }; }

export function createMcpRequestHandler(options = {}) {
  const bridgeUrl = String(options.bridgeUrl || process.env.RETKIT_BRIDGE_URL || 'http://127.0.0.1:43118').replace(/\/$/, '');
  const sessionSecret = String(options.sessionSecret || process.env.RETKIT_SESSION_SECRET || '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('MCP forwarder requires fetch');

  return async function handle(request) {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return rpcError(request?.id ?? null, -32600, 'Invalid Request');
    const id = request.id;
    if (request.method === 'notifications/initialized') return null;
    if (request.method === 'ping') return id == null ? null : rpcResult(id, {});
    if (request.method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: String(request.params?.protocolVersion || '2025-06-18'),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'retkit-ai', title: 'RetKit AI Tools', version: '0.7.0' },
      });
    }
    if (request.method === 'tools/list') {
      return rpcResult(id, { tools: RETKIT_TOOL_SPECS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    }
    if (request.method === 'tools/call') {
      const tool = String(request.params?.name || '');
      if (!TOOL_SET.has(tool)) return rpcError(id, -32602, `Unknown RetKit tool: ${tool}`);
      if (!sessionSecret) return rpcError(id, -32001, 'RetKit bridge session is missing');
      try {
        const response = await fetchImpl(`${bridgeUrl}/internal/tool`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RetKit-Session': sessionSecret },
          body: JSON.stringify({ tool, args: request.params?.arguments && typeof request.params.arguments === 'object' ? request.params.arguments : {} }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
          const error = data.error || { code: `HTTP_${response.status}`, message: data.message || 'RetKit tool failed' };
          return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true });
        }
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(data.result ?? null) }], isError: false });
      } catch (error) {
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'BRIDGE_UNAVAILABLE', message: error?.message || String(error) } }) }], isError: true });
      }
    }
    if (id == null) return null;
    return rpcError(id, -32601, `Method not found: ${request.method}`);
  };
}

export async function runStdioMcpServer(options = {}) {
  const handle = createMcpRequestHandler(options);
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    while (true) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const raw = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!raw) continue;
      let request;
      try { request = JSON.parse(raw); }
      catch { process.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`); continue; }
      const response = await handle(request);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) runStdioMcpServer().catch((error) => {
  process.stderr.write(`[RetKit MCP] ${error?.stack || error}\n`);
  process.exitCode = 1;
});
