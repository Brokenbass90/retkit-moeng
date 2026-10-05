(function (root) {
  'use strict';

  const IDS = {
    style: 'retkit-ai-style',
    stack: 'retkit-ai-left-stack',
    panel: 'retkit-ai-panel',
    grip: 'retkit-ai-vertical-grip',
    toggle: 'retkit-ai-toggle',
    header: 'retkit-ai-header',
    body: 'retkit-ai-body',
    status: 'retkit-ai-status',
    usage: 'retkit-ai-usage',
  };
  const STORAGE = {
    open: 'retkit-ai-panel-open',
    height: 'retkit-ai-panel-height',
  };
  const DEFAULT_HEIGHT = 320;
  const MIN_CHAT = 180;
  const MIN_CODE = 180;

  function clampAiHeight(value, totalHeight) {
    const total = Math.max(MIN_CHAT + MIN_CODE, Number(totalHeight) || (MIN_CHAT + MIN_CODE));
    const max = Math.max(MIN_CHAT, total - MIN_CODE);
    return Math.max(MIN_CHAT, Math.min(max, Number(value) || DEFAULT_HEIGHT));
  }

  function nextAiPanelState(state, action) {
    const current = { open: Boolean(state?.open), height: Number(state?.height) || DEFAULT_HEIGHT };
    if (action?.type === 'toggle') return { ...current, open: !current.open };
    if (action?.type === 'open') return { ...current, open: true };
    if (action?.type === 'close') return { ...current, open: false };
    if (action?.type === 'height') return { ...current, height: Number(action.height) || current.height };
    return current;
  }

  function providerStatusView(provider = {}, runtime = {}) {
    const state = String(runtime?.state || '');
    if (state === 'error') return { label: 'Error', tone: 'error', ...(runtime.detail ? { detail: String(runtime.detail) } : {}) };
    if (state === 'connecting') return { label: 'Connecting', tone: 'warning' };
    if (state === 'busy') return { label: 'Busy', tone: 'ok' };
    if (state === 'connected') return { label: 'Connected', tone: 'ok' };
    if (!provider?.detected) return { label: 'Not detected', tone: 'error' };
    if (provider?.authenticated === 'no') return { label: 'Authentication required', tone: 'error' };
    return { label: 'Detected', tone: 'warning' };
  }

  function providerButtonView(provider = {}, runtime = {}, bridge = {}) {
    if (String(bridge?.status || '') !== 'connected') {
      return { label: 'Bridge offline', tone: 'error', detail: bridge?.detail ? String(bridge.detail) : 'Start the local RetKit AI bridge' };
    }
    return providerStatusView(provider, runtime);
  }

  function normalizeAiMode(value) {
    const mode = String(value || '').toLowerCase();
    return ['ask', 'suggest', 'agent'].includes(mode) ? mode : 'agent';
  }

  function compactNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return null;
    if (number >= 1000000) return `${(number / 1000000).toFixed(number >= 10000000 ? 0 : 1).replace(/\.0$/, '')}m`;
    if (number >= 1000) return `${(number / 1000).toFixed(number >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
    return String(Math.round(number));
  }

  function usageStatusText(usage) {
    if (!usage || typeof usage !== 'object') return '';
    const input = usage.input_tokens ?? usage.inputTokens ?? usage.input ?? usage.prompt_tokens ?? usage.promptTokens;
    const output = usage.output_tokens ?? usage.outputTokens ?? usage.output ?? usage.completion_tokens ?? usage.completionTokens;
    const total = usage.total_tokens ?? usage.totalTokens ?? ((Number.isFinite(Number(input)) || Number.isFinite(Number(output))) ? (Number(input) || 0) + (Number(output) || 0) : null);
    const shown = compactNumber(total);
    return shown == null ? '' : `Usage ${shown} tokens`;
  }

  root.__RetKitAiUiCore = { clampAiHeight, nextAiPanelState, providerStatusView, providerButtonView, normalizeAiMode, usageStatusText };

  if (typeof document === 'undefined') return;

  let workspaceApi = null;
  let bridgeClient = null;
  let state = {
    open: root.localStorage?.getItem(STORAGE.open) === '1',
    height: Number(root.localStorage?.getItem(STORAGE.height)) || DEFAULT_HEIGHT,
  };
  let bridgeState = { status: 'offline' };
  const providerInfo = {
    codex: { id: 'codex', detected: false, authenticated: 'unknown', version: null, detail: null },
    claude: { id: 'claude', detected: false, authenticated: 'unknown', version: null, detail: null },
  };
  const providerRuntime = { codex: { state: '' }, claude: { state: '' } };
  const providerUsage = { codex: null, claude: null };
  let activeProvider = root.localStorage?.getItem('retkit-ai-provider') === 'claude' ? 'claude' : 'codex';
  const activeMode = 'agent';
  let chat = null;

  function injectStyle() {
    if (document.getElementById(IDS.style)) return;
    const style = document.createElement('style');
    style.id = IDS.style;
    style.textContent = `
      #retkit-mo-editor-pane { position:relative; }
      .rk-ai-connect { margin:10px; padding:12px 14px; border:1px solid #2f4b7a; border-radius:12px; background:#101c2d; color:#dce6f4; font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; display:grid; gap:8px; }
      .rk-ai-connect strong { font-size:14px; }
      .rk-ai-connect p { margin:0; color:#a9b8cc; }
      .rk-ai-connect-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
      .rk-ai-connect-primary { border:1px solid #4c75e7; background:#315be9; color:#fff; border-radius:8px; padding:8px 12px; cursor:pointer; font-weight:700; }
      .rk-ai-connect-secondary { border:1px solid #334155; background:#172130; color:#dce6f4; border-radius:8px; padding:7px 10px; cursor:pointer; }
      .rk-ai-connect-opt { color:#a9b8cc; cursor:pointer; }
      .rk-ai-connect-note { color:#91ddb0; word-break:break-all; }
      .rk-ai-connect-wait { font-size:11.5px; color:#7f8ea3 !important; }
      #${IDS.stack} { flex:1; min-height:0; display:grid; grid-template-rows:minmax(0,1fr) 0 38px; overflow:hidden; }
      #${IDS.stack}[data-ai-open="1"] { grid-template-rows:minmax(0,1fr) 6px var(--rk-ai-height,320px); }
      #${IDS.panel} { min-height:0; overflow:hidden; display:flex; flex-direction:column; background:#0d141e; border-top:1px solid #263140; }
      #${IDS.panel}[data-open="0"] #${IDS.body} { display:none; }
      #${IDS.panel}[data-open="0"] .rk-ai-provider-switch, #${IDS.panel}[data-open="0"] #${IDS.usage} { display:none; }
      #${IDS.header} { height:36px; flex:0 0 36px; display:flex; align-items:center; gap:8px; padding:0 9px; border-bottom:1px solid #263140; background:#101925; }
      #${IDS.header} strong { font-size:12px; color:#e8eef8; }
      .rk-ai-provider-switch { display:flex; align-items:center; gap:4px; }
      .rk-ai-choice { height:25px; border:1px solid #3b4b61; border-radius:7px; background:#172130; color:#b9c7d8; font:700 10px inherit; padding:0 8px; cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
      .rk-ai-choice:hover { background:#223149; color:#fff; }
      .rk-ai-choice.rk-active { background:#315fd6; border-color:#6388ef; color:#fff; box-shadow:0 0 0 1px rgba(99,136,239,.15) inset; }
      .rk-ai-provider-dot { width:7px; height:7px; border-radius:999px; background:#708198; box-shadow:0 0 0 1px rgba(255,255,255,.08); }
      .rk-ai-choice[data-tone="ok"] .rk-ai-provider-dot { background:#55cf91; }
      .rk-ai-choice[data-tone="warning"] .rk-ai-provider-dot { background:#e5b858; }
      .rk-ai-choice[data-tone="error"] .rk-ai-provider-dot { background:#ed6f78; }
      #${IDS.usage} { margin-left:auto; font-size:10px; color:#71839a; white-space:nowrap; }
      #${IDS.status} { font-size:10px; color:#8fa2b8; white-space:nowrap; max-width:190px; overflow:hidden; text-overflow:ellipsis; }
      #${IDS.status}[data-tone="ok"] { color:#66d49b; }
      #${IDS.status}[data-tone="warning"] { color:#f0bd62; }
      #${IDS.status}[data-tone="error"] { color:#ff858c; }
      #${IDS.body} { flex:1; min-height:0; overflow:hidden; padding:0; color:#9fb0c4; font-size:12px; display:flex; flex-direction:column; }
      #${IDS.body} > .rk-ai-chat { flex:1 1 auto; min-height:0; }
      #${IDS.grip} { background:#202a37; cursor:row-resize; position:relative; }
      #${IDS.grip}:hover { background:#4368d8; }
      #${IDS.grip}[aria-hidden="true"] { visibility:hidden; pointer-events:none; }
      #${IDS.toggle} { width:28px; height:26px; border:0; border-radius:7px; background:transparent; color:#8fa2b8; font:700 15px/1 inherit; cursor:pointer; margin-left:2px; }
      #${IDS.toggle}:hover { background:#1e2b3d; color:#fff; }
    `;
    document.head.appendChild(style);
  }

  function persist() {
    try {
      root.localStorage?.setItem(STORAGE.open, state.open ? '1' : '0');
      root.localStorage?.setItem(STORAGE.height, String(Math.round(state.height)));
    } catch {}
  }

  function refreshLayout() {
    try { workspaceApi?.refreshEditorLayout?.(); } catch {}
  }

  function renderState() {
    const stack = document.getElementById(IDS.stack);
    const panel = document.getElementById(IDS.panel);
    const grip = document.getElementById(IDS.grip);
    const toggle = document.getElementById(IDS.toggle);
    if (!stack) return;
    const rect = stack.getBoundingClientRect?.();
    const total = rect?.height || 720;
    state.height = clampAiHeight(state.height, total);
    stack.style.setProperty('--rk-ai-height', `${Math.round(state.height)}px`);
    stack.dataset.aiOpen = state.open ? '1' : '0';
    if (panel) panel.dataset.open = state.open ? '1' : '0';
    grip?.setAttribute('aria-hidden', state.open ? 'false' : 'true');
    const title = document.getElementById('retkit-ai-title');
    if (title) title.textContent = state.open ? 'RetKit AI' : '✦ Ask AI…';
    if (toggle) {
      toggle.dataset.open = state.open ? '1' : '0';
      toggle.textContent = state.open ? '⌄' : '⌃';
      toggle.title = state.open ? 'Collapse RetKit AI' : 'Open RetKit AI';
    }
    persist();
    refreshLayout();
  }

  function toggleAiPanel(force) {
    state = nextAiPanelState(state, typeof force === 'boolean' ? { type: force ? 'open' : 'close' } : { type: 'toggle' });
    renderState();
    if (state.open) ensureBridgeConnection();
    return getAiPanelState();
  }

  function setAiPanelHeight(px) {
    const stack = document.getElementById(IDS.stack);
    const total = stack?.getBoundingClientRect?.().height || 720;
    state = nextAiPanelState(state, { type: 'height', height: clampAiHeight(px, total) });
    renderState();
    return state.height;
  }

  function getAiPanelState() {
    return { open: state.open, height: state.height, provider: activeProvider, mode: activeMode };
  }

  function selectedProviderButton() {
    return document.querySelector(`[data-provider-choice="${activeProvider}"]`);
  }

  function renderProviders() {
    for (const id of ['claude', 'codex']) {
      const button = document.querySelector(`[data-provider-choice="${id}"]`);
      if (!button) continue;
      const view = providerButtonView(providerInfo[id], providerRuntime[id], bridgeState);
      button.classList.toggle('rk-active', id === activeProvider);
      button.dataset.tone = view.tone;
      const detail = view.detail || providerRuntime[id]?.detail || providerInfo[id]?.detail || providerInfo[id]?.version || '';
      button.title = `${id === 'claude' ? 'Claude' : 'Codex'} · ${view.label}${detail ? ` · ${detail}` : ''}`;
      button.setAttribute('aria-label', button.title);
    }

    const selected = activeProvider;
    const selectedView = providerButtonView(providerInfo[selected], providerRuntime[selected], bridgeState);
    const status = document.getElementById(IDS.status);
    if (status) {
      status.textContent = selectedView.label;
      status.dataset.tone = selectedView.tone;
      status.title = selectedProviderButton()?.title || selectedView.label;
    }
    try {
      root.__RetKitAiConnect?.render?.(document.getElementById(IDS.body), {
        bridge: bridgeState,
        provider: providerInfo[selected] || {},
        providerId: selected,
      });
    } catch {}
    const usageEl = document.getElementById(IDS.usage);
    if (usageEl) {
      usageEl.textContent = usageStatusText(providerUsage[selected]);
      usageEl.title = usageEl.textContent ? 'Provider-reported usage for the last completed turn' : '';
    }
  }

  function handleBridgeUiEvent(event) {
    if (!event) return;
    if (event.type === 'provider.status' && event.provider?.id && providerInfo[event.provider.id]) {
      providerInfo[event.provider.id] = { ...providerInfo[event.provider.id], ...event.provider };
    } else if (event.type === 'provider.state' && providerRuntime[event.provider]) {
      providerRuntime[event.provider] = { state: String(event.state || ''), ...(event.detail ? { detail: String(event.detail) } : {}) };
    } else if (event.type === 'provider.connected' && providerRuntime[event.provider]) {
      providerRuntime[event.provider] = { state: 'connected' };
      if (event.status) providerInfo[event.provider] = { ...providerInfo[event.provider], ...event.status };
    } else if (event.type === 'provider.disconnected' && providerRuntime[event.provider]) {
      providerRuntime[event.provider] = { state: '' };
    } else if (event.type === 'chat.done' && event.provider && Object.hasOwn(providerUsage, event.provider)) {
      providerUsage[event.provider] = event.usage || null;
    }
    renderProviders();
  }

  function ensureBridgeClient() {
    if (bridgeClient || !root.__RetKitAiBridge?.createBridgeClient) return bridgeClient;
    bridgeClient = root.__RetKitAiBridge.createBridgeClient();
    bridgeClient.subscribeState((connection) => {
      bridgeState = { ...connection };
      renderProviders();
    });
    bridgeClient.subscribe((event) => {
      handleBridgeUiEvent(event);
      root.__RetKitAiUi?.onBridgeEvent?.(event);
    });
    root.__RetKitAiContext?.attach?.({ bridgeClient, workspaceApi: root.__RetKitAiWorkspaceApi });
    return bridgeClient;
  }

  function ensureBridgeConnection() {
    const client = ensureBridgeClient();
    if (!client) return null;
    const connection = client.getState?.() || bridgeState;
    if (!['connected', 'connecting'].includes(String(connection?.status || ''))) client.connect();
    return client;
  }

  function selectAndConnectProvider(provider) {
    activeProvider = provider === 'claude' ? 'claude' : 'codex';
    try { root.localStorage?.setItem('retkit-ai-provider', activeProvider); } catch {}
    chat?.setProvider?.(activeProvider);
    renderProviders();
    ensureBridgeConnection();
    if (bridgeState.status !== 'connected') return;
    bridgeClient?.send?.('provider.select', { provider: activeProvider }).catch(() => {});
    if (['connected', 'busy', 'connecting'].includes(providerRuntime[activeProvider]?.state)) return;
    if (!providerInfo[activeProvider]?.detected) return;
    providerRuntime[activeProvider] = { state: 'connecting' };
    renderProviders();
    bridgeClient?.send?.('provider.connect', { provider: activeProvider }).catch((error) => {
      providerRuntime[activeProvider] = { state: 'error', detail: error?.message || String(error) };
      renderProviders();
    });
  }

  function mountAiPanel(api) {
    workspaceApi = api || workspaceApi;
    injectStyle();
    const editorPane = workspaceApi?.getEditorPaneElement?.() || document.getElementById('retkit-mo-editor-pane');
    const sourceHost = workspaceApi?.getSourceHostElement?.() || document.getElementById('retkit-mo-source-host');
    if (!editorPane || !sourceHost) return false;
    if (document.getElementById(IDS.stack)) {
      renderState();
      return true;
    }

    const stack = document.createElement('div');
    stack.id = IDS.stack;
    const panel = document.createElement('section');
    panel.id = IDS.panel;
    panel.innerHTML = `<div id="${IDS.header}"><strong id="retkit-ai-title">RetKit AI</strong><div class="rk-ai-provider-switch" aria-label="AI provider"><button type="button" class="rk-ai-choice" data-provider-choice="claude"><span class="rk-ai-provider-dot" aria-hidden="true"></span><span>Claude</span></button><button type="button" class="rk-ai-choice" data-provider-choice="codex"><span class="rk-ai-provider-dot" aria-hidden="true"></span><span>Codex</span></button></div><span id="${IDS.usage}"></span><span id="${IDS.status}">Bridge offline</span><button type="button" id="${IDS.toggle}" title="Open or collapse AI">⌄</button></div><div id="${IDS.body}"></div>`;
    const grip = document.createElement('div');
    grip.id = IDS.grip;
    grip.title = 'Drag to resize AI chat and code';

    sourceHost.parentElement?.insertBefore(stack, sourceHost);
    stack.append(sourceHost, grip, panel);

    root.__RetKitAiContext?.setMode?.('agent');
    chat = root.__RetKitAiChat?.createChatView?.({
      bridgeClient: ensureBridgeClient(),
      provider: activeProvider,
      mode: 'agent',
      getContext: () => root.__RetKitAiContext?.getInitialContext?.() || null,
    });
    const body = panel.querySelector(`#${IDS.body}`);
    if (body && chat?.element) body.appendChild(chat.element);

    panel.querySelectorAll('[data-provider-choice]').forEach((button) => {
      button.addEventListener('click', () => selectAndConnectProvider(button.dataset.providerChoice));
    });
    panel.querySelector(`#${IDS.toggle}`)?.addEventListener('click', (event) => { event.stopPropagation(); toggleAiPanel(); });
    panel.querySelector(`#${IDS.header}`)?.addEventListener('dblclick', () => toggleAiPanel());

    let dragging = false;
    grip.addEventListener('pointerdown', (event) => {
      if (!state.open) return;
      dragging = true;
      grip.setPointerCapture?.(event.pointerId);
      event.preventDefault?.();
    });
    grip.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const rect = stack.getBoundingClientRect();
      setAiPanelHeight(rect.bottom - event.clientY);
    });
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      refreshLayout();
    };
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);

    renderState();
    if (state.open) ensureBridgeConnection();
    renderProviders();
    return true;
  }

  root.__RetKitAiUi = {
    mountAiPanel,
    toggleAiPanel,
    setAiPanelHeight,
    getAiPanelState,
    getBridgeClient: () => bridgeClient,
    onBridgeEvent: null,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
