(function (root) {
  'use strict';

  function stableHash(value) {
    const input = String(value ?? '');
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${(hash >>> 0).toString(36)}:${input.length}`;
  }

  async function resolve(value) {
    return await Promise.resolve(typeof value === 'function' ? value() : value);
  }

  async function buildInitialContext(api = {}) {
    const [currentHtml, subject, activeLocale, locales, selectedSource, issues, previewMode] = await Promise.all([
      resolve(api.getCurrentHtml || ''),
      resolve(api.getSubject || ''),
      resolve(api.getActiveLocale || ''),
      resolve(api.listLocales || []),
      resolve(api.getSelectedSource || null),
      resolve(api.getValidatorIssues || []),
      resolve(api.getPreviewMode || 'desktop'),
    ]);
    const normalizedIssues = Array.isArray(issues) ? issues : [];
    return {
      activeLocale: String(activeLocale || ''),
      subject: String(subject || ''),
      currentHtml: String(currentHtml || ''),
      currentHtmlHash: stableHash(currentHtml),
      locales: Array.isArray(locales) ? locales.map(String) : [],
      selectedSource: selectedSource || null,
      validator: {
        count: normalizedIssues.length,
        issues: normalizedIssues.slice(0, 50).map((issue) => ({
          severity: issue?.severity || 'warning', code: issue?.code || '', line: Number(issue?.line || 0), message: String(issue?.message || ''),
        })),
      },
      previewMode: String(previewMode || 'desktop'),
    };
  }

  function proposalError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function createProposalStore(api = {}) {
    const proposals = new Map();
    let lastApplied = null;

    function newId() {
      return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    }

    function proposeHtml({ baseHash, html, summary = '' } = {}) {
      const proposal = { id: newId(), kind: 'html', baseHash: String(baseHash || ''), html: String(html || ''), summary: String(summary || ''), status: 'pending', createdAt: Date.now() };
      proposals.set(proposal.id, proposal);
      return { ...proposal };
    }

    function proposeSubject({ baseSubject, subject, summary = '' } = {}) {
      const proposal = { id: newId(), kind: 'subject', baseSubject: String(baseSubject ?? ''), subject: String(subject ?? ''), summary: String(summary || ''), status: 'pending', createdAt: Date.now() };
      proposals.set(proposal.id, proposal);
      return { ...proposal };
    }

    function get(id) { const proposal = proposals.get(String(id)); return proposal ? { ...proposal } : null; }
    function cancel(id) { const p = proposals.get(String(id)); if (!p) return false; p.status = 'cancelled'; return true; }

    async function apply(id) {
      const proposal = proposals.get(String(id));
      if (!proposal) throw proposalError('UNKNOWN_PROPOSAL', 'Proposal not found');
      if (proposal.status !== 'pending') throw proposalError('PROPOSAL_NOT_PENDING', 'Proposal is no longer pending');
      const beforeHtml = String(await resolve(api.getCurrentHtml || ''));
      const beforeSubject = String(await resolve(api.getSubject || ''));
      const locale = String(await resolve(api.getActiveLocale || ''));
      if (proposal.kind === 'html' && proposal.baseHash !== stableHash(beforeHtml)) {
        throw proposalError('STALE_PROPOSAL', 'HTML changed after the AI proposal was created');
      }
      if (proposal.kind === 'subject' && proposal.baseSubject !== beforeSubject) {
        throw proposalError('STALE_PROPOSAL', 'Subject changed after the AI proposal was created');
      }
      await Promise.resolve(api.saveAiSnapshot?.({ html: beforeHtml, subject: beforeSubject, locale, proposalId: proposal.id }));
      if (proposal.kind === 'html') await Promise.resolve(api.setHtml?.(proposal.html));
      else await Promise.resolve(api.setSubject?.(proposal.subject));
      proposal.status = 'applied';
      lastApplied = { proposalId: proposal.id, beforeHtml, beforeSubject, locale, appliedAt: Date.now(), kind: proposal.kind };
      return { ...proposal };
    }

    async function undo() {
      if (!lastApplied) throw proposalError('NOTHING_TO_UNDO', 'There is no AI change to undo');
      const currentLocale = String(await resolve(api.getActiveLocale || ''));
      if (lastApplied.locale && currentLocale && lastApplied.locale !== currentLocale) {
        throw proposalError('LOCALE_CHANGED', `Switch back to ${lastApplied.locale} before undoing this AI change`);
      }
      if (typeof api.setHtml === 'function') await Promise.resolve(api.setHtml(lastApplied.beforeHtml));
      if (typeof api.setSubject === 'function') await Promise.resolve(api.setSubject(lastApplied.beforeSubject));
      const undone = { ...lastApplied };
      lastApplied = null;
      return undone;
    }

    return { proposeHtml, proposeSubject, get, cancel, apply, undo, list: () => [...proposals.values()].map((p) => ({ ...p })), getLastApplied: () => lastApplied ? { ...lastApplied } : null };
  }

  root.__RetKitAiContextCore = { stableHash, buildInitialContext, createProposalStore };
  if (typeof document === 'undefined') return;

  let workspaceApi = null;
  let bridgeClient = null;
  let unsubscribe = null;
  let store = null;
  let mode = 'agent';

  function getApi() {
    workspaceApi = workspaceApi || root.__RetKitAiWorkspaceApi;
    return workspaceApi;
  }

  function ensureStore() {
    const api = getApi();
    if (!store && api) store = createProposalStore(api);
    return store;
  }

  async function getInitialContext() {
    const api = getApi();
    if (!api) return null;
    return buildInitialContext(api);
  }

  async function executeTool(tool, args = {}) {
    const api = getApi();
    if (!api) throw proposalError('WORKSPACE_UNAVAILABLE', 'RetKit workspace is not open');
    const proposalStore = ensureStore();
    switch (tool) {
      case 'get_current_html': return { html: String(await resolve(api.getCurrentHtml || '')), hash: stableHash(await resolve(api.getCurrentHtml || '')) };
      case 'get_subject': return { subject: String(await resolve(api.getSubject || '')) };
      case 'get_active_locale': return { locale: String(await resolve(api.getActiveLocale || '')) };
      case 'list_locales': return { locales: await resolve(api.listLocales || []) };
      case 'list_available_locales': return { locales: await Promise.resolve(api.listAvailableLocales?.() || []) };
      case 'add_locale': {
        if (mode !== 'agent') throw proposalError('MODE_DENIED', 'Adding a locale is a structural change. Switch RetKit AI to Agent mode first.');
        const locale = String(args.locale || '').trim().toUpperCase();
        if (!locale) throw proposalError('BAD_LOCALE', 'Locale is required');
        const available = await Promise.resolve(api.listAvailableLocales?.() || []);
        if (!available.map((item) => String(item).toUpperCase()).includes(locale)) {
          throw proposalError('LOCALE_NOT_AVAILABLE', `MoEngage does not currently offer ${locale} in + Locale`);
        }
        if (typeof root.confirm === 'function' && !root.confirm(`RetKit AI wants to add MoEngage locale ${locale}. Continue?`)) {
          throw proposalError('USER_CANCELLED', `Adding ${locale} was cancelled`);
        }
        return await Promise.resolve(api.addLocales?.([locale]) || { ok: false, reason: 'Locale bridge unavailable' });
      }
      case 'remove_locale': {
        if (mode !== 'agent') throw proposalError('MODE_DENIED', 'Removing a locale is a structural change. Switch RetKit AI to Agent mode first.');
        const locale = String(args.locale || '').trim().toUpperCase();
        if (!locale || locale === 'EN' || locale === 'DEFAULT') throw proposalError('BAD_LOCALE', 'Default/EN locale cannot be removed');
        const existing = await Promise.resolve(api.listLocales?.() || []);
        if (!existing.map((item) => String(item).toUpperCase()).includes(locale)) return { ok: true, removed: false, reason: 'Locale is not present' };
        if (typeof root.confirm === 'function' && !root.confirm(`RetKit AI wants to remove MoEngage locale ${locale}. Continue?`)) {
          throw proposalError('USER_CANCELLED', `Removing ${locale} was cancelled`);
        }
        return await Promise.resolve(api.removeLocale?.(locale) || { ok: false, reason: 'Locale bridge unavailable' });
      }
      case 'get_locale_html': return { locale: String(args.locale || ''), html: String(await Promise.resolve(api.getLocaleHtml?.(args.locale) || '')) };
      case 'get_selected_source': return await resolve(api.getSelectedSource || null);
      case 'get_validator_issues': return { issues: await resolve(api.getValidatorIssues || []) };
      case 'get_preview_dom': return { html: String(await Promise.resolve(api.getPreviewDom?.(args.maxChars) || '')) };
      case 'get_preview_screenshot': return await Promise.resolve(api.getPreviewScreenshot?.() || { supported: false, reason: 'Preview capture unavailable' });
      case 'get_email_context_summary': return await getInitialContext();
      case 'switch_locale': return { ok: Boolean(await Promise.resolve(api.switchLocale?.(args.locale))) };
      case 'propose_html_patch': {
        if (mode === 'ask') throw proposalError('MODE_DENIED', 'Ask mode does not allow change proposals');
        const proposal = proposalStore.proposeHtml(args);
        root.__RetKitAiDiff?.showProposal?.(proposal, {
          before: String(await resolve(api.getCurrentHtml || '')),
          after: proposal.html,
          apply: () => approveProposal(proposal.id),
          cancel: () => cancelProposal(proposal.id),
        });
        return { proposalId: proposal.id, status: proposal.status };
      }
      case 'propose_subject_change': {
        if (mode === 'ask') throw proposalError('MODE_DENIED', 'Ask mode does not allow change proposals');
        const proposal = proposalStore.proposeSubject(args);
        root.__RetKitAiDiff?.showProposal?.(proposal, {
          before: String(await resolve(api.getSubject || '')),
          after: proposal.subject,
          apply: () => approveProposal(proposal.id),
          cancel: () => cancelProposal(proposal.id),
        });
        return { proposalId: proposal.id, status: proposal.status };
      }
      case 'find_across_locales':
        if (typeof api.acrossLocales !== 'function') throw proposalError('UNSUPPORTED', 'Across-locales search is unavailable');
        return await api.acrossLocales({ query: args.query, mode: args.mode });
      case 'propose_replace_across_locales': {
        if (mode === 'ask') throw proposalError('MODE_DENIED', 'Ask mode does not allow change proposals');
        if (typeof api.acrossLocales !== 'function') throw proposalError('UNSUPPORTED', 'Across-locales replace is unavailable');
        const plan = await api.acrossLocales({ query: args.search, replacement: String(args.replace ?? ''), mode: args.mode, perLocale: args.perLocale && typeof args.perLocale === 'object' ? args.perLocale : null });
        return { ...plan, status: 'awaiting_user', note: 'RetKit filled ⌘F with this search/replacement and scanned every locale. The user reviews the chips and clicks “Replace … in … locales”; the model cannot write to MoEngage by itself.' };
      }
      case 'apply_approved_patch':
        throw proposalError('USER_APPROVAL_REQUIRED', 'AI cannot approve its own proposal');
      case 'undo_last_ai_change':
        throw proposalError('USER_APPROVAL_REQUIRED', 'Undo is a user action');
      default: throw proposalError('UNKNOWN_TOOL', `Unknown RetKit AI tool: ${tool}`);
    }
  }

  async function onBridgeEvent(event) {
    if (event?.type !== 'tool.call') return;
    const callId = String(event.callId || '');
    try {
      const result = await executeTool(event.tool, event.args || {});
      await bridgeClient?.send?.('tool.result', { callId, ok: true, result });
    } catch (error) {
      await bridgeClient?.send?.('tool.result', { callId, ok: false, error: { code: error?.code || 'TOOL_ERROR', message: error?.message || String(error) } }).catch(() => {});
    }
  }

  function attach(options = {}) {
    workspaceApi = options.workspaceApi || root.__RetKitAiWorkspaceApi || workspaceApi;
    const nextClient = options.bridgeClient || bridgeClient;
    if (nextClient !== bridgeClient) {
      unsubscribe?.();
      bridgeClient = nextClient;
      unsubscribe = bridgeClient?.subscribe?.(onBridgeEvent) || null;
    }
    ensureStore();
    return Boolean(workspaceApi);
  }

  async function approveProposal(id) {
    const result = await ensureStore().apply(id);
    root.__RetKitAiDiff?.markApplied?.(id, () => undoLastAiChange());
    return result;
  }
  function cancelProposal(id) { const ok = ensureStore().cancel(id); root.__RetKitAiDiff?.dismiss?.(id); return ok; }
  async function undoLastAiChange() { const result = await ensureStore().undo(); root.__RetKitAiDiff?.dismissAll?.(); return result; }
  function setMode(value) {
    mode = 'agent';
    try { root.localStorage?.setItem('retkit-ai-mode', mode); } catch {}
    return mode;
  }

  root.__RetKitAiContext = { attach, getInitialContext, executeTool, approveProposal, cancelProposal, undoLastAiChange, setMode, getMode: () => mode, stableHash };
})(typeof globalThis !== 'undefined' ? globalThis : this);
