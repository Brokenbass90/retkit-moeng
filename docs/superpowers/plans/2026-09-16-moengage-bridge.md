# RetKit v0.5.0 MoEngage Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native locale control, conservative Arabic RTL fixing, and Test Campaign sending to RetKit while preserving the stable v0.4.2 editor core.

**Architecture:** Ship a v0.5.0 wrapper userscript that `@require`s the stable v0.4.2 base from the repository and installs a DOM bridge. Pure HTML/locale logic is exported to `__RetKitMoEngageBridgeCore` for dependency-free Node tests; browser adapters execute only when `document` and the supported MoEngage host exist.

**Tech Stack:** JavaScript userscript, Tampermonkey, browser DOM APIs, CodeMirror exposed by RetKit/MoEngage, Node.js `assert` tests.

**Spec:** `docs/superpowers/specs/2026-09-16-moengage-bridge-design.md`

## Global Constraints

- Keep the v0.4.2 base editor unchanged.
- Do not store API keys or MoEngage credentials.
- Do not implement direct/private MoEngage API calls.
- RTL changes may target only Arabic `<p>` elements and their nearest ancestor `<td>`.
- Locale switching must manipulate native MoEngage UI or fail visibly; no fake local locale switch.
- Test sending must use the native Test Campaign UI.
- Remove `Save` and `Apply now` from the RetKit toolbar.

---

### Task 1: Bridge core and RTL transformation

**Files:**
- Create: `src/retkit-moengage-v0.5.user.js`
- Test: `tests/test-v050.mjs`

**Interfaces:**
- Produces: `localeFromHtml(html)`, `isArabicLocale(locale)`, `transformRtlHtml(html)`, `normaliseLocale(locale)` via `globalThis.__RetKitMoEngageBridgeCore`.

- [ ] Write failing tests for locale extraction and RTL targeting.
- [ ] Run tests and confirm failure because the v0.5 source is absent.
- [ ] Implement minimal pure functions and metadata.
- [ ] Re-run tests and confirm they pass.

### Task 2: Workspace and locale bridge

**Files:**
- Modify: `src/retkit-moengage-v0.5.user.js`
- Test: `tests/test-v050.mjs`

**Interfaces:**
- Produces browser functions for pruning legacy buttons, detecting active locale from native preview, discovering native locale controls, and switching by visible locale code.

- [ ] Add failing source-contract tests for toolbar pruning and native-locale-only switching.
- [ ] Run tests and confirm failure.
- [ ] Implement toolbar bridge and locale popover.
- [ ] Re-run tests.

### Task 3: Test Campaign bridge

**Files:**
- Modify: `src/retkit-moengage-v0.5.user.js`
- Test: `tests/test-v050.mjs`

**Interfaces:**
- Produces a `Send test` popover that stores tester preferences locally and delegates submission to native Test Campaign controls.

- [ ] Add failing tests for test configuration normalisation and required native labels.
- [ ] Run tests and confirm failure.
- [ ] Implement test popover and native form adapter.
- [ ] Re-run tests.

### Task 4: Distribution and release docs

**Files:**
- Create: `dist/retkit-moengage.user.js`
- Create: `RELEASE_v0.5.0.md`

- [ ] Copy verified source to distribution.
- [ ] Verify `src` and `dist` are byte-identical.
- [ ] Run `node --check` and all tests.
- [ ] Package a ZIP for manual installation/testing before updating the public repository.
