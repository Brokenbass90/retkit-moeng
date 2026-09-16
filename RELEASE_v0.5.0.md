# RetKit × MoEngage v0.5.0 test build

This build layers new MoEngage-specific controls on top of the stable v0.4.2 RetKit workspace.

## New

- Removes the obsolete **Save** and **Apply now** toolbar buttons.
- Shows the active locale from the rendered email `<html lang>` value.
- Adds **Locales ▾** and delegates locale switching to native MoEngage controls when they can be discovered.
- Adds **RTL Fix**:
  - targets only Arabic `<p>` blocks;
  - targets only their nearest parent `<td>`;
  - adds or normalises `dir="rtl"`;
  - changes only `text-align:left` to `text-align:right`;
  - preserves centered/other alignment and unrelated layout blocks;
  - asks for confirmation before editing.
- Adds **Send test**:
  - remembers the tester email locally in the browser;
  - current locale / all locales mode;
  - personalization toggle;
  - uses MoEngage's own Test Campaign controls and Test button;
  - no private API calls.

## Installation for testing

1. Open Tampermonkey dashboard.
2. Disable the old RetKit script while testing v0.5.0 to avoid loading the v0.4.2 base twice.
3. Create/import a new userscript from `dist/retkit-moengage.user.js`.
4. Open MoEngage, reload the page, open an email, then press **RK**.

The v0.5.0 file loads the stable v0.4.2 editor core from the public GitHub repository using Tampermonkey `@require` and then adds the bridge layer.

## Live validation checklist

The pure RTL/locale parsing logic is covered by Node tests. These items require the real MoEngage DOM and should be checked in the dashboard:

1. `Save` and `Apply now` are absent from the RetKit toolbar.
2. `Locales · XX ▾` shows the currently rendered locale.
3. Switching a locale changes the real MoEngage variation, not only the RetKit preview.
4. `RTL Fix` updates only Arabic paragraphs and their closest cells.
5. `Send test` finds the native Test Campaign section, fills the email, sets locale mode/personalization, and triggers the native Test button.

If MoEngage changes the DOM or uses a workspace-specific control variant, RetKit reports an error instead of pretending the action succeeded.
