(function (root) {
  'use strict';

  // "Connect Claude / Codex" card shown inside RetKit AI while the local bridge
  // is not running (or the model CLI is missing / not logged in). The browser
  // cannot install programs by itself, so the card does the most it can:
  // detects Mac / Windows, gives the one installer for that system (copy one
  // line on Mac, download a .cmd on Windows) and waits for the bridge to come up.

  const INSTALL_BASE = 'https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/install';
  const CARD_ID = 'retkit-ai-connect-card';

  function detectOs(nav = root.navigator) {
    const raw = String(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '').toLowerCase();
    if (raw.includes('win')) return 'windows';
    if (raw.includes('mac') || raw.includes('darwin')) return 'mac';
    if (raw.includes('linux')) return 'linux';
    return 'mac';
  }

  function installCommand(os, { codex = false } = {}) {
    if (os === 'windows') {
      const prefix = codex ? '$env:RETKIT_CODEX="1"; ' : '';
      return `${prefix}irm ${INSTALL_BASE}/install-windows.ps1 | iex`;
    }
    return `curl -fsSL ${INSTALL_BASE}/install-mac.sh | bash${codex ? ' -s -- --codex' : ''}`;
  }

  function windowsCmdFile({ codex = false } = {}) {
    return [
      '@echo off',
      'rem RetKit AI setup: installs Claude Code, the RetKit bridge and autostart.',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${codex ? '$env:RETKIT_CODEX=\'1\'; ' : ''}irm ${INSTALL_BASE}/install-windows.ps1 | iex"`,
      'echo.',
      'pause',
      '',
    ].join('\r\n');
  }

  // What the card should say for the current bridge/provider state.
  function connectView({ bridge = {}, provider = {}, providerId = 'claude' } = {}) {
    const name = providerId === 'codex' ? 'Codex' : 'Claude';
    if (String(bridge.status || '') !== 'connected') return { step: 'install', title: `Подключить ${name}` };
    if (!provider.detected) return { step: 'install', title: `${name} не найден на этом компьютере` };
    if (provider.authenticated === 'no') return { step: 'login', title: `Войдите в ${name}` };
    return null;
  }

  function render(host, state = {}) {
    if (typeof document === 'undefined' || !host) return;
    const view = connectView(state);
    let card = document.getElementById(CARD_ID);
    if (!view) { card?.remove(); return; }
    const os = detectOs();
    const key = `${view.step}|${view.title}|${os}`;
    if (card && card.dataset.key === key) return;
    card?.remove();
    card = document.createElement('div');
    card.id = CARD_ID;
    card.dataset.key = key;
    card.className = 'rk-ai-connect';

    const title = document.createElement('strong');
    title.textContent = view.title;
    card.appendChild(title);

    if (view.step === 'login') {
      const text = document.createElement('p');
      text.textContent = state.providerId === 'codex'
        ? 'Откройте Терминал, введите codex login и войдите в браузере. RetKit подхватит вход сам.'
        : 'Откройте Терминал, введите claude и войдите в браузере (потом /exit). RetKit подхватит вход сам.';
      card.appendChild(text);
      host.prepend(card);
      return;
    }

    // Work machines: no installers, no autostart from inside the page.
    const intro = document.createElement('p');
    intro.textContent = 'RetKit AI работает через вашу модель на этом компьютере. Запустите связку RetKit в Терминале из папки RetKit и оставьте окно открытым:';
    const code = document.createElement('code');
    code.className = 'rk-ai-connect-note';
    code.textContent = 'npm run bridge';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'rk-ai-connect-secondary';
    copy.textContent = 'Скопировать';
    copy.addEventListener('click', async () => { try { await root.navigator.clipboard.writeText('npm run bridge'); copy.textContent = 'Скопировано'; } catch {} });
    const row = document.createElement('div');
    row.className = 'rk-ai-connect-row';
    row.append(code, copy);
    const wait = document.createElement('p');
    wait.className = 'rk-ai-connect-wait';
    wait.textContent = 'Нужен установленный и залогиненный Claude Code (или Codex). На рабочем компьютере — только с согласия IT. RetKit подключится сам, как только связка запущена.';
    card.append(intro, row, wait);
    host.prepend(card);
  }

  root.__RetKitAiConnect = { detectOs, installCommand, windowsCmdFile, connectView, render, INSTALL_BASE };
})(typeof globalThis !== 'undefined' ? globalThis : this);
