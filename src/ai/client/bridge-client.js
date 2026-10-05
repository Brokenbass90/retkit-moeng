(function (root) {
  'use strict';

  function nextConnectionState(current, event, detail = null) {
    const status = typeof current === 'string' ? current : current?.status || 'offline';
    if (event === 'connect') return { status: 'connecting' };
    if (event === 'open') return { status: 'connected' };
    if (event === 'close') return { status: 'offline' };
    if (event === 'error') return { status: 'error', ...(detail ? { detail: String(detail) } : {}) };
    return { status };
  }

  function reconnectDelay(attempt) {
    return Math.min(8000, 1000 * (2 ** Math.max(0, Number(attempt) || 0)));
  }

  function shouldRecordBridgeFailure(hadSuccessfulConnection, status) {
    return Boolean(hadSuccessfulConnection) && String(status || '') === 'error';
  }

  root.__RetKitAiBridgeCore = { nextConnectionState, reconnectDelay, shouldRecordBridgeFailure };

  const protocol = root.__RetKitAiProtocol;
  if (!protocol) return;

  function createBridgeClient(options = {}) {
    const listeners = new Set();
    const stateListeners = new Set();
    let socket = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let desired = false;
    let state = { status: 'offline' };
    let sessionSecret = '';
    let bridgeSessionId = '';
    let hadSuccessfulConnection = false;

    const wsUrl = options.wsUrl || protocol.BRIDGE_WS_URL;
    const httpUrl = options.httpUrl || protocol.BRIDGE_HTTP_URL;
    const workspaceId = options.workspaceId || `rk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    function notifyState(next) {
      state = next;
      if (shouldRecordBridgeFailure(hadSuccessfulConnection, next?.status)) {
        try { root.__RetKitDiagnostics?.incident?.('ai_bridge_error', next.detail || 'AI bridge connection error', { status: next.status }); } catch {}
      }
      for (const listener of stateListeners) {
        try { listener({ ...state }); } catch (error) { console.error('[RetKit AI] state listener failed', error); }
      }
    }

    function emit(event) {
      if (!protocol.isBridgeEvent(event)) return;
      if (event.type === 'bridge.error') {
        try { root.__RetKitDiagnostics?.incident?.('ai_bridge_event_error', event.message || event.code || 'Bridge error', { code: event.code || '', requestType: event.requestType || '' }); } catch {}
      }
      if (event.type === 'bridge.ready') {
        sessionSecret = String(event.sessionSecret || '');
        bridgeSessionId = String(event.sessionId || '');
      }
      for (const listener of listeners) {
        try { listener(event); } catch (error) { console.error('[RetKit AI] event listener failed', error); }
      }
    }

    function clearReconnect() {
      if (reconnectTimer) root.clearTimeout?.(reconnectTimer);
      reconnectTimer = null;
    }

    function scheduleReconnect() {
      if (!desired || reconnectTimer) return;
      const delay = reconnectDelay(reconnectAttempt++);
      reconnectTimer = root.setTimeout?.(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function connect() {
      desired = true;
      clearReconnect();
      if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
      if (typeof root.WebSocket !== 'function') {
        notifyState(nextConnectionState(state, 'error', 'WebSocket unavailable'));
        scheduleReconnect();
        return;
      }
      notifyState(nextConnectionState(state, 'connect'));
      try {
        socket = new root.WebSocket(wsUrl);
      } catch (error) {
        notifyState(nextConnectionState(state, 'error', error?.message || error));
        scheduleReconnect();
        return;
      }
      socket.addEventListener('open', () => {
        reconnectAttempt = 0;
        hadSuccessfulConnection = true;
        notifyState(nextConnectionState(state, 'open'));
        const hello = protocol.makeClientMessage('hello', {
          workspaceId,
          page: String(root.location?.href || ''),
          clientVersion: '0.7.7',
        });
        socket.send(JSON.stringify(hello));
      });
      socket.addEventListener('message', (message) => {
        try { emit(JSON.parse(String(message.data || ''))); } catch (error) { emit({ type: 'bridge.error', code: 'BAD_JSON', message: String(error?.message || error) }); }
      });
      socket.addEventListener('error', () => {
        notifyState(nextConnectionState(state, 'error', 'Bridge connection error'));
      });
      socket.addEventListener('close', () => {
        socket = null;
        sessionSecret = '';
        bridgeSessionId = '';
        notifyState(nextConnectionState(state, 'close'));
        scheduleReconnect();
      });
    }

    function disconnect() {
      desired = false;
      clearReconnect();
      try { socket?.close?.(); } catch {}
      socket = null;
      sessionSecret = '';
      bridgeSessionId = '';
      notifyState({ status: 'offline' });
    }

    function send(type, payload = {}) {
      if (!socket || socket.readyState !== 1 || state.status !== 'connected') {
        return Promise.reject(new Error('Bridge offline'));
      }
      const message = protocol.makeClientMessage(type, payload);
      socket.send(JSON.stringify(message));
      return Promise.resolve(message);
    }

    async function uploadAttachment(file) {
      if (state.status !== 'connected' || !sessionSecret) throw new Error('Bridge offline');
      if (typeof root.fetch !== 'function') throw new Error('Fetch unavailable');
      const response = await root.fetch(`${httpUrl}/attachments`, {
        method: 'POST',
        headers: {
          'Content-Type': file?.type || 'application/octet-stream',
          'X-RetKit-Session': sessionSecret,
          'X-RetKit-Name': encodeURIComponent(file?.name || 'attachment'),
        },
        body: file,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.message || `Attachment upload failed (${response.status})`);
      return data;
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function subscribeState(listener) {
      stateListeners.add(listener);
      try { listener({ ...state }); } catch {}
      return () => stateListeners.delete(listener);
    }

    function getState() {
      return { ...state, sessionSecret: Boolean(sessionSecret), sessionId: bridgeSessionId, workspaceId };
    }

    return { connect, disconnect, send, uploadAttachment, subscribe, subscribeState, getState };
  }

  root.__RetKitAiBridge = { createBridgeClient };
})(typeof globalThis !== 'undefined' ? globalThis : this);
