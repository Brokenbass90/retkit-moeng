export const PROTOCOL_VERSION = 1;
export const BRIDGE_VERSION = '0.8.3';

const CLIENT_TYPES = new Set([
  'hello', 'provider.connect', 'provider.disconnect', 'provider.select',
  'chat.send', 'chat.cancel', 'tool.result', 'proposal.apply', 'proposal.cancel',
]);

export function validateClientMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid RetKit AI message');
  if (value.protocol !== PROTOCOL_VERSION) throw new Error(`Protocol mismatch: expected ${PROTOCOL_VERSION}`);
  if (!CLIENT_TYPES.has(value.type)) throw new Error(`Unknown RetKit AI message type: ${String(value.type)}`);
  return value;
}

export function errorEvent(code, message, requestType = null) {
  return { type: 'bridge.error', protocol: PROTOCOL_VERSION, code, message: String(message || code), ...(requestType ? { requestType } : {}) };
}

export function bridgeEvent(type, payload = {}) {
  return { type, protocol: PROTOCOL_VERSION, ...payload };
}
