(function (root) {
  'use strict';

  // RetKit AI Workbench browser/bridge protocol.
  const PROTOCOL_VERSION = 1;
  const BRIDGE_WS_URL = 'ws://127.0.0.1:43118/ws';
  const BRIDGE_HTTP_URL = 'http://127.0.0.1:43118';
  const CLIENT_TYPES = new Set([
    'hello', 'provider.connect', 'provider.disconnect', 'provider.select',
    'chat.send', 'chat.cancel', 'tool.result', 'proposal.apply', 'proposal.cancel',
  ]);

  function makeClientMessage(type, payload = {}) {
    if (!CLIENT_TYPES.has(type)) throw new Error(`Unknown RetKit AI client message: ${type}`);
    return { type, protocol: PROTOCOL_VERSION, ...payload };
  }

  function isBridgeEvent(value) {
    return Boolean(value && typeof value === 'object' && typeof value.type === 'string');
  }

  root.__RetKitAiProtocol = {
    PROTOCOL_VERSION,
    BRIDGE_WS_URL,
    BRIDGE_HTTP_URL,
    makeClientMessage,
    isBridgeEvent,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
