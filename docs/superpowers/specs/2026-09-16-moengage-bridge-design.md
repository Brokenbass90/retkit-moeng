# RetKit v0.5.0 MoEngage Bridge Design

## Goal

Extend the stable RetKit v0.4.2 workspace with a thin MoEngage integration layer for native locale awareness/switching, conservative Arabic RTL transformation, and Test Campaign sending without replacing MoEngage's own delivery path.

## Architecture

v0.5.0 remains a Tampermonkey userscript. To avoid destabilising the working v0.4.2 editor, the v0.5.0 distribution loads the existing v0.4.2 script through `@require`, then installs a bridge layer after the base workspace boots. The bridge only uses browser DOM APIs and the existing exposed `__RetKitMoEngageCore` helpers.

The bridge has four isolated responsibilities:

1. **Workspace integration**: remove obsolete `Save` and `Apply now` buttons, update the displayed version, and add `Locales`, `RTL Fix`, and `Send test` controls.
2. **Locale adapter**: detect the active locale from the rendered email `<html lang>` and discover/click native MoEngage locale controls without changing production user data.
3. **RTL transformer**: only touch Arabic `<p>` blocks and their nearest enclosing `<td>`; add/normalise `dir="rtl"` and convert `text-align:left` to `text-align:right`. No global left/right replacement.
4. **Test Campaign adapter**: use MoEngage's existing Test Campaign controls. RetKit stores only the tester email and UI preferences locally; it does not send email directly or call a private MoEngage API.

## UI

The top toolbar keeps `Wrap`, `History`, HTML validation, `Copy HTML`, and `Close`. `Save` and `Apply now` are hidden by the bridge because the base script already auto-applies editor changes.

New controls:
- `Locales ▾`: shows the active locale and discovered native locales. Clicking a locale delegates to the actual MoEngage locale control.
- `RTL Fix`: generates a change plan, asks for confirmation, then updates the RetKit editor. It is marked active when the current locale is Arabic but remains manually callable.
- `Send test`: opens a compact RetKit popover with recipient email, `Current locale` / `All locales`, and personalization toggle. Sending delegates to MoEngage Test Campaign.

## Locale switching

The active locale is derived first from the rendered email's `<html lang>` value because that is tied to the content currently shown by MoEngage. The DOM adapter then looks for locale controls outside the `Test Campaign` section, preferring native selects/comboboxes and locale-labelled tabs. If RetKit cannot find a native editor locale switcher, it must report that rather than simulating a locale locally.

## RTL transformation

The transformer parses tag ranges using a lightweight stack. It identifies `<p>` elements whose rendered text contains Arabic Unicode ranges, then marks those paragraphs and only their nearest ancestor `<td>`. For each targeted opening tag:
- add `dir="rtl"` if absent;
- replace existing `dir="ltr"` with `dir="rtl"`;
- within `style`, replace `text-align: left` with `text-align: right`;
- preserve `center`, `justify`, images, links, layout tables, and unrelated elements.

The confirmation reports paragraph and cell counts before changing the editor.

## Test Campaign

RetKit finds the section containing `Test Campaign`, `Locales and Variations`, and the email textarea. It fills the native fields, selects current or all locales using the native selector, aligns the native personalization switch, then invokes the native `Test` button after a confirmation. Failure to find any required native control stops the operation with a visible status message.

## State and privacy

Per-browser settings remain in `localStorage`. The new bridge stores only:
- tester email;
- test locale mode;
- personalization preference.

No API keys, email HTML, MoEngage credentials, or user records are sent to RetKit infrastructure.

## Compatibility

- Arc and Chrome via Tampermonkey.
- MoEngage host remains `dashboard-02.moengage.com`.
- The stable v0.4.2 base workspace is loaded as a dependency.
- If MoEngage changes its DOM, adapters fail visibly instead of silently faking success.

## Out of scope

AI assistant, MCP/Claude/Codex bridge, Matrix QA, automatic email-client screenshots, and direct MoEngage API calls are deferred.
