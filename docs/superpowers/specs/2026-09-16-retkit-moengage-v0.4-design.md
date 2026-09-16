# RetKit × MoEngage v0.4 Design

## Goal

Create a standalone browser userscript project for Arc and Google Chrome that upgrades the MoEngage email HTML editor with a practical fullscreen coding workspace, accurate preview-to-source navigation, safe local history, HTML validation, and bilingual installation/use documentation.

## Scope

v0.4 builds on the proven v0.3.1 userscript and keeps the existing MoEngage/Froala bridge. It adds four product-facing capabilities and packages them as a separate repository named `retkit-moengage`:

1. Precise preview click mapping after resize and inside mixed inline markup such as nested `<b>`, `<span>`, and `<a>`.
2. Ten local snapshots per email with restore safety.
3. Lightweight email-aware HTML validation with jump-to-line behavior.
4. README documentation in Russian and English for Arc, Chrome, Tampermonkey installation, usage, updates, snapshots, validator, search/replace, folding, and troubleshooting.

The existing UI remains intentionally compact. The top toolbar keeps only actions that are routinely useful (`Wrap`, `Apply now`, `Copy HTML`, history/validation affordances, close). Desktop/mobile preview mode remains as icons inside the preview pane rather than text buttons in the main toolbar.

## Compatibility

- Browser: Arc and Google Chrome, Chromium extension model.
- Runtime: Tampermonkey userscript.
- Target application: `https://dashboard-02.moengage.com/*`.
- No backend service, account token, or MoEngage API credential is required.
- Auto-update uses Tampermonkey `@updateURL` and `@downloadURL` pointed at the public `Brokenbass90/retkit-moengage` repository once that repository exists.

## Existing Bridge

The userscript reads the MoEngage rendered preview from `#sidePreview[srcdoc]`, renders a same-origin local iframe for interaction, and accesses the native CodeMirror instance exposed on `.CodeMirror.CodeMirror`.

To apply HTML back to MoEngage, the userscript writes through the native CodeMirror editor, then toggles Froala's `data-cmd="html"` Code View button OFF/ON so Froala accepts the change and MoEngage's React state observes it. This mechanism was manually verified with a temporary hidden marker round trip.

## Precise Preview-to-Source Mapping

### Problem

The current mapper may select a whole parent block when the user clicks visible text surrounding inline tags. It may also jump to an earlier duplicate string after preview resizing or when the same URL/text appears multiple times.

### Design

Each preview click will generate a fresh descriptor from the current preview DOM; no cached coordinates or prior mapping result will be reused.

For text clicks, use `document.caretRangeFromPoint(x, y)` when available, falling back to `caretPositionFromPoint`. This identifies the exact text node under the pointer even if the containing `<p>` also contains `<b>`, `<span>`, or `<a>` children.

The descriptor will include:

- exact text-node value and normalized visible fragment;
- text-node ordinal among the element's descendant text nodes;
- DOM path made from child indices from the email body root to the clicked node;
- nearest stable ancestor descriptors: tag, id, class list, href/src where applicable;
- occurrence index for duplicate direct values such as repeated `href` or `src`.

Mapping priority:

1. Image `src` occurrence.
2. Exact clicked text-node fragment constrained by ancestor opening tag range and text-node ordinal.
3. Link `href` occurrence.
4. Stable id.
5. Unique class + DOM occurrence.
6. Unique visible text fallback.

The source search is always executed against the current working HTML, so splitter resize and preview mode changes do not preserve stale indices.

## Snapshots

### Storage

Store snapshots in browser `localStorage`, with a maximum of 10 snapshots per email identity.

Email identity is derived from stable page context where possible (flow/campaign URL plus subject/title fields). If a stable campaign identifier cannot be read, use a deterministic hash of pathname plus email subject, with a final fallback to pathname.

### Snapshot schema

```json
{
  "id": "timestamp-random",
  "createdAt": 1789560000000,
  "label": "15:12:31",
  "html": "<!DOCTYPE ...>",
  "reason": "manual|before-restore"
}
```

### Behavior

- `Save` creates a manual snapshot.
- `History` opens the latest 10 states newest-first.
- Selecting an entry shows its timestamp and enables `Restore`.
- Before restoring an old snapshot, RetKit automatically stores the current HTML as a `before-restore` snapshot.
- Restore updates the working editor, local preview, and then applies through the MoEngage bridge.
- Old snapshots beyond 10 are removed.

## HTML Validator

### Purpose

Catch high-value email markup mistakes without pretending to be a full HTML parser or altering the code.

### Checks

- unexpected closing tags;
- unclosed non-void tags;
- nested `<a>` tags;
- `<a>` with empty or `#` href (warning);
- `<img>` without `src` (error);
- `<img>` without `alt` (warning);
- unresolved obvious merge/template syntax must not be reported as malformed HTML;
- void tags (`img`, `br`, `meta`, etc.) are never required to close;
- Outlook conditional comments and normal comments are ignored for stack matching;
- contents of `<style>`, `<script>`, `<pre>`, and `<textarea>` are treated as opaque.

### UI

The toolbar displays either `✓ HTML` or `⚠ N issues`. Clicking it opens a compact list grouped by severity. Each issue shows a short message and source line. Clicking an issue scrolls/focuses the working editor at that source location.

## Search, Replace, Folding, Formatting

Existing v0.3.1 behavior remains:

- working copy is beautified for readability on open;
- beautification alone does not modify the MoEngage source until an actual edit is made;
- Wrap is user-toggleable and persisted;
- gutter arrows fold structural tag ranges;
- `Cmd+F` opens Find and Replace fields, with next/previous, Replace, and Replace All;
- Windows `Ctrl+F`/`Ctrl+H` equivalents remain supported.

## UI Layout

- Fullscreen overlay.
- Draggable splitter between source and preview.
- No 50/50, Code, Preview, Desktop, Mobile, or Sync buttons in the main toolbar.
- Preview pane has desktop/mobile icon toggles in its own header.
- Main toolbar contains: version label, Wrap, Save, History, validator status, Apply now, Copy HTML, Close.
- Version is visible in the header (`v0.4.0`) so users can confirm an update actually loaded.

## Documentation and Portfolio Packaging

Repository structure:

```text
retkit-moengage/
  README.md
  README_RU.md
  CHANGELOG.md
  LICENSE
  package.json
  src/retkit-moengage.user.js
  dist/retkit-moengage.user.js
  tests/test-retkit-moengage-userscript.mjs
  docs/screenshots/
  docs/superpowers/specs/
  docs/superpowers/plans/
```

`README.md` is English-first for GitHub/portfolio. `README_RU.md` is the complete Russian guide.

Both guides cover:

- installing Tampermonkey in Arc from Chrome Web Store;
- installing Tampermonkey in Chrome;
- installing the userscript;
- opening a MoEngage email and finding the blue `RK` button in the bottom-right corner;
- source/preview workspace basics;
- click-to-source;
- Wrap, folding, search/replace;
- snapshots and restore;
- validator;
- Apply now and native MoEngage synchronization;
- automatic update behavior;
- troubleshooting when the RK button is absent or MoEngage changes its DOM.

The supplied screenshots are sufficient for v0.4 documentation; no additional screenshots are required for implementation.

## Safety and Data Handling

- No user/customer/email content is sent to external services by RetKit.
- Snapshots remain in the local browser profile only.
- RetKit does not bypass MoEngage permissions or approval logic.
- Restore/apply operates only through the existing page's editor state.

## Out of Scope for v0.4

Reserved for later releases:

- Gmail clipping/HTML size meter;
- asset/link inspector;
- network link checker;
- Jinja/ContentBlock inspector;
- locale/platform simulation presets;
- snapshot diff view;
- table/td outline debug mode.
