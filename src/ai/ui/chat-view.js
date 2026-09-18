(function (root) {
  'use strict';

  function keyAction(event) {
    if (event?.key !== 'Enter') return 'none';
    return event.shiftKey ? 'newline' : 'send';
  }

  function normalizeMessage(input) {
    return {
      id: String(input?.id || `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`),
      role: ['user', 'assistant', 'system'].includes(input?.role) ? input.role : 'system',
      text: String(input?.text || ''),
      attachments: Array.isArray(input?.attachments) ? input.attachments : [],
      status: String(input?.status || 'done'),
    };
  }

  root.__RetKitAiChatCore = { keyAction, normalizeMessage };
  if (typeof document === 'undefined') return;

  const STYLE_ID = 'retkit-ai-chat-style';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .rk-ai-chat { height:100%; display:flex; flex-direction:column; min-height:0; }
      .rk-ai-messages { flex:1; min-height:0; overflow:auto; padding:10px; display:flex; flex-direction:column; gap:8px; }
      .rk-ai-msg { max-width:92%; padding:8px 10px; border-radius:10px; white-space:pre-wrap; word-break:break-word; font:12px/1.45 Inter,ui-sans-serif,sans-serif; }
      .rk-ai-msg[data-role="user"] { align-self:flex-end; background:#21468f; color:#eef4ff; }
      .rk-ai-msg[data-role="assistant"] { align-self:flex-start; background:#172130; color:#dce6f4; border:1px solid #29384c; }
      .rk-ai-msg[data-role="system"] { align-self:center; background:transparent; color:#8395aa; font-size:11px; }
      .rk-ai-msg[data-status="error"] { border-color:#7b3037; color:#ffabb0; }
      .rk-ai-composer { flex:0 0 auto; border-top:1px solid #263140; padding:8px; background:#0e1621; }
      .rk-ai-composer-row { display:flex; align-items:flex-end; gap:6px; }
      .rk-ai-input { flex:1; min-height:38px; max-height:120px; resize:vertical; border:1px solid #334155; border-radius:9px; padding:8px 9px; background:#0a111a; color:#e7edf6; outline:none; font:12px/1.4 inherit; }
      .rk-ai-input:focus { border-color:#5f83ff; box-shadow:0 0 0 2px rgba(72,111,255,.14); }
      .rk-ai-send,.rk-ai-stop { min-width:58px; height:36px; border:1px solid #466ed9; border-radius:8px; background:#315be9; color:#fff; cursor:pointer; font:700 11px inherit; }
      .rk-ai-stop { background:#7c3038; border-color:#a64650; display:none; }
      .rk-ai-chat[data-busy="1"] .rk-ai-send { display:none; }
      .rk-ai-chat[data-busy="1"] .rk-ai-stop { display:block; }
      .rk-ai-chat-hint { margin-top:5px; color:#64768c; font-size:10px; }
    `;
    document.head.appendChild(style);
  }

  function createChatView(options = {}) {
    injectStyle();
    const bridgeClient = options.bridgeClient;
    const rootEl = document.createElement('div');
    rootEl.className = 'rk-ai-chat';
    rootEl.dataset.busy = '0';
    const messagesEl = document.createElement('div');
    messagesEl.className = 'rk-ai-messages';
    const composer = document.createElement('div');
    composer.className = 'rk-ai-composer';
    const row = document.createElement('div');
    row.className = 'rk-ai-composer-row';
    const textarea = document.createElement('textarea');
    textarea.className = 'rk-ai-input';
    textarea.placeholder = 'Ask Codex or Claude about this email…';
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'rk-ai-send';
    sendBtn.textContent = 'Send';
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'rk-ai-stop';
    stopBtn.textContent = 'Stop';
    row.append(textarea, sendBtn, stopBtn);
    const hint = document.createElement('div');
    hint.className = 'rk-ai-chat-hint';
    hint.textContent = 'Enter sends · Shift+Enter adds a new line';
    const attachmentTray = root.__RetKitAiAttachments?.createAttachmentTray?.({ bridgeClient, dropTarget: rootEl });
    if (attachmentTray?.element) composer.append(attachmentTray.element);
    composer.append(row, hint);
    rootEl.append(messagesEl, composer);

    const messages = [];
    let busy = false;
    let currentAssistant = null;
    let activeProvider = options.provider || 'codex';
    let activeMode = 'agent';

    function renderMessage(message) {
      let el = messagesEl.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = 'rk-ai-msg';
        el.dataset.messageId = message.id;
        el.dataset.role = message.role;
        messagesEl.appendChild(el);
      }
      el.dataset.status = message.status;
      el.textContent = message.text || (message.status === 'streaming' ? '…' : '');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function addMessage(input) {
      const message = normalizeMessage(input);
      messages.push(message);
      renderMessage(message);
      return message;
    }

    function setBusy(value) {
      busy = Boolean(value);
      rootEl.dataset.busy = busy ? '1' : '0';
      textarea.disabled = busy;
    }

    async function send() {
      const text = textarea.value.trim();
      if (!text || busy) return false;
      const bridgeState = bridgeClient?.getState?.();
      if (bridgeState?.status !== 'connected') {
        addMessage({ role: 'system', text: 'Bridge offline. Start RetKit AI Bridge and retry.', status: 'error' });
        return false;
      }
      const context = await options.getContext?.().catch?.(() => null) || await Promise.resolve(options.getContext?.()) || null;
      const attachments = attachmentTray?.getPending?.() || options.getAttachments?.() || [];
      addMessage({ role: 'user', text, attachments, status: 'done' });
      currentAssistant = addMessage({ role: 'assistant', text: '', status: 'streaming' });
      textarea.value = '';
      setBusy(true);
      try {
        await bridgeClient.send('chat.send', {
          provider: activeProvider,
          mode: activeMode,
          text,
          context,
          attachmentIds: attachments.map((item) => item.attachmentId).filter(Boolean),
        });
        attachmentTray?.clearPending?.();
        options.onSent?.();
        return true;
      } catch (error) {
        currentAssistant.text = error?.message || String(error);
        currentAssistant.status = 'error';
        renderMessage(currentAssistant);
        setBusy(false);
        return false;
      }
    }

    function handleEvent(event) {
      if (!event) return;
      if (event.type === 'chat.delta') {
        if (!currentAssistant) currentAssistant = addMessage({ role: 'assistant', text: '', status: 'streaming' });
        currentAssistant.text += String(event.text || '');
        currentAssistant.status = 'streaming';
        renderMessage(currentAssistant);
      } else if (event.type === 'chat.done') {
        if (currentAssistant) {
          currentAssistant.status = 'done';
          renderMessage(currentAssistant);
        }
        currentAssistant = null;
        setBusy(false);
      } else if (event.type === 'chat.error' || (event.type === 'bridge.error' && busy)) {
        if (!currentAssistant) currentAssistant = addMessage({ role: 'assistant', text: '', status: 'error' });
        currentAssistant.text += String(event.message || event.code || 'AI error');
        currentAssistant.status = 'error';
        renderMessage(currentAssistant);
        currentAssistant = null;
        setBusy(false);
      }
    }

    const unsubscribe = bridgeClient?.subscribe?.(handleEvent) || (() => {});
    textarea.addEventListener('keydown', (event) => {
      const action = keyAction(event);
      if (action === 'send') {
        event.preventDefault();
        send();
      }
    });
    sendBtn.addEventListener('click', send);
    stopBtn.addEventListener('click', async () => {
      try { await bridgeClient?.send?.('chat.cancel', { provider: activeProvider }); } catch {}
      setBusy(false);
    });

    return {
      element: rootEl,
      messages,
      send,
      handleEvent,
      setProvider(provider) { activeProvider = provider === 'claude' ? 'claude' : 'codex'; },
      getProvider() { return activeProvider; },
      setMode() { activeMode = 'agent'; },
      getMode() { return activeMode; },
      destroy() { unsubscribe(); },
      focus() { textarea.focus(); },
      get busy() { return busy; },
    };
  }

  root.__RetKitAiChat = { createChatView };
})(typeof globalThis !== 'undefined' ? globalThis : this);
