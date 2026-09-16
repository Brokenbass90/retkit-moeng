# RetKit × MoEngage v0.4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone v0.4.0 Tampermonkey userscript for Arc/Chrome with accurate preview-to-source mapping, ten-state local history, HTML validation, bilingual docs, and repository-ready packaging.

**Architecture:** Keep the proven single-userscript browser integration and extract only pure logic into exported test hooks inside the userscript for Node tests. Extend current preview descriptor/mapping code instead of replacing the MoEngage/Froala bridge. Persist snapshots in localStorage and render history/validation as lightweight overlay popovers.

**Tech Stack:** JavaScript userscript, CodeMirror 5 exposed by MoEngage, Froala Code View bridge, browser DOM/localStorage, Node.js built-in test/assert modules.

**Spec:** `docs/superpowers/specs/2026-09-16-retkit-moengage-v0.4-design.md`

## Global Constraints

- Arc and Google Chrome compatibility through Tampermonkey.
- Target only `https://dashboard-02.moengage.com/*`.
- No external runtime dependencies or remote data transmission.
- Keep at most 10 snapshots per email identity.
- Do not report void tags as unclosed.
- Ignore comments, Outlook conditional comments, and opaque style/script/pre/textarea bodies in tag-stack validation.
- Main toolbar must remain compact and must not restore removed 50/50, Code, Preview, Desktop, Mobile, or Sync controls.
- Version visible in the RetKit header must be `v0.4.0`.

---

### Task 1: Add precise click descriptor and duplicate-aware mapping

**Files:**
- Modify: `src/retkit-moengage.user.js`
- Test: `tests/test-retkit-moengage-userscript.mjs`

**Interfaces:**
- Produces: `findOccurrenceIndex(source, needle, occurrence) -> number`
- Produces: `findTextNodeRangeInElement(source, descriptor) -> {start,end}|null`
- Extends: `findRangeFromDescriptor(source, descriptor)`

- [ ] **Step 1: Add failing mapping tests**

Add tests for repeated links/images and mixed inline text where a `<p>` contains ordinary text plus multiple `<b>` children. Assert that the requested text-node ordinal maps only the clicked fragment.

- [ ] **Step 2: Run tests and confirm failure**

Run: `node tests/test-retkit-moengage-userscript.mjs`
Expected: FAIL on new occurrence/text-node mapping assertions.

- [ ] **Step 3: Implement occurrence-aware and text-node-aware mapping**

Add `findOccurrenceIndex`, ancestor-constrained source ranges, text-node ordinal handling, and current-DOM descriptor fields. Use caret APIs from click coordinates where available.

- [ ] **Step 4: Run tests**

Run: `node tests/test-retkit-moengage-userscript.mjs`
Expected: PASS.

### Task 2: Add snapshot history and safe restore

**Files:**
- Modify: `src/retkit-moengage.user.js`
- Test: `tests/test-retkit-moengage-userscript.mjs`

**Interfaces:**
- Produces: `snapshotStorageKey(identity) -> string`
- Produces: `normalizeSnapshots(list, limit=10) -> array`
- Produces: `saveSnapshot(storage, identity, html, reason, now) -> array`

- [ ] **Step 1: Add failing snapshot tests**

Test newest-first order, hard limit of ten, identity separation, and automatic current-state preservation before restore.

- [ ] **Step 2: Run tests and confirm failure**

Run: `node tests/test-retkit-moengage-userscript.mjs`
Expected: FAIL because snapshot helpers do not exist.

- [ ] **Step 3: Implement snapshot storage helpers and UI**

Add Save and History toolbar controls, history popover, Restore action, and pre-restore snapshot creation. Restore updates working editor and calls the existing apply bridge.

- [ ] **Step 4: Run tests**

Run: `node tests/test-retkit-moengage-userscript.mjs`
Expected: PASS.

### Task 3: Add email-aware HTML validator

**Files:**
- Modify: `src/retkit-moengage.user.js`
- Test: `tests/test-retkit-moengage-userscript.mjs`

**Interfaces:**
- Produces: `validateEmailHtml(source) -> Array<{severity,code,message,index,line}>`

- [ ] **Step 1: Add failing validator tests**

Cover unclosed tags, unexpected closing tags, void tags, nested anchors, href `#`, missing img src, missing img alt, comments, conditional comments, and style blocks containing angle brackets.

- [ ] **Step 2: Run tests and confirm failure**

Run: `node tests/test-retkit-moengage-userscript.mjs`
Expected: FAIL because validator is absent.

- [ ] **Step 3: Implement validator and issue navigation UI**

Tokenize protected markup, maintain a source-indexed tag stack, emit errors/warnings, show toolbar status, render issue popover, and jump to source index when clicked.

- [ ] **Step 4: Run tests**

Run: `node tests/test-retkit-moengage-userscript.mjs`
Expected: PASS.

### Task 4: Finalize compact UI, versioning, and standalone metadata

**Files:**
- Modify: `src/retkit-moengage.user.js`
- Create: `dist/retkit-moengage.user.js`
- Create: `package.json`
- Test: `tests/test-retkit-moengage-userscript.mjs`

**Interfaces:**
- Metadata update/download URLs point to `Brokenbass90/retkit-moengage/main/dist/retkit-moengage.user.js`.

- [ ] **Step 1: Add metadata/UI regression assertions**

Assert version 0.4.0, expected repo URLs, absence of legacy text controls, and presence of version/Save/History/validator labels.

- [ ] **Step 2: Run tests and confirm expected failures**

Run: `node tests/test-retkit-moengage-userscript.mjs`
Expected: FAIL until metadata/UI changes are complete.

- [ ] **Step 3: Update metadata and toolbar, then copy src to dist**

Keep preview desktop/mobile icons in preview pane. Add visible `v0.4.0` label. Copy the verified userscript byte-for-byte to `dist/retkit-moengage.user.js`.

- [ ] **Step 4: Run tests and syntax validation**

Run: `node --check src/retkit-moengage.user.js && node tests/test-retkit-moengage-userscript.mjs && cmp src/retkit-moengage.user.js dist/retkit-moengage.user.js`
Expected: all commands exit 0.

### Task 5: Add bilingual documentation and portfolio files

**Files:**
- Create: `README.md`
- Create: `README_RU.md`
- Create: `CHANGELOG.md`
- Create: `LICENSE`
- Use: `docs/screenshots/moengage-rk-button.png`
- Use: `docs/screenshots/moengage-native-editor.png`
- Use: `docs/screenshots/retkit-workspace.png`

**Interfaces:**
- README install URL references `dist/retkit-moengage.user.js`.

- [ ] **Step 1: Write English README**

Document Arc/Chrome + Tampermonkey installation from scratch, userscript installation, MoEngage workflow, blue RK launcher, click-to-source, resize, Wrap/folding, search/replace, snapshots, validation, apply bridge, updates, and troubleshooting.

- [ ] **Step 2: Write Russian README**

Provide the same coverage in natural Russian, with exact UI actions and the same screenshots.

- [ ] **Step 3: Add changelog and MIT license**

Record v0.4.0 features and previous 0.3.x lineage.

- [ ] **Step 4: Verify documentation references**

Run a shell check that every local README image/link target exists and no `future-retention` update URL remains in source/dist.

### Task 6: Repository-ready verification and local release artifact

**Files:**
- Create: `.gitignore`
- Create: release ZIP outside project folder

**Interfaces:**
- Produces release archive `/mnt/data/retkit-moengage-v0.4.0.zip`.

- [ ] **Step 1: Initialize a local git repository and make the initial commit**

Run `git init -b main`, configure local commit identity if needed, add all project files, and commit `feat: release RetKit for MoEngage v0.4.0`.

- [ ] **Step 2: Run final verification**

Run `node --check`, test suite, `git status --short`, and ensure source/dist equality.

- [ ] **Step 3: Build ZIP**

Archive the repository contents excluding `.git` to `/mnt/data/retkit-moengage-v0.4.0.zip`.

- [ ] **Step 4: Record repository creation handoff**

Because the available GitHub connector cannot create a brand-new repository, prepare the local repository and exact one-step handoff: user creates empty public `Brokenbass90/retkit-moengage`; after it exists, files can be uploaded/committed through the connected GitHub tooling or pushed locally.
