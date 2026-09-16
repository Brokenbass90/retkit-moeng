# RetKit for MoEngage v0.5.2

Fix release based on live MoEngage UI testing.

## Changed

- Native locale tabs are discovered from the real MoEngage locale bar instead of generic two-letter buttons.
- RetKit's own `RK` launcher is explicitly excluded from locale detection.
- MoEngage `Default` is presented as `EN`.
- Locale tabs are rendered inline in the RetKit toolbar.
- Locale order is `EN` first, then remaining locales in descending alphabetical order.
- `EN` can target either a native `EN` tab or MoEngage's `Default` tab.
- Locale changes rebind the RetKit workspace after MoEngage remounts its editor.
- RTL Fix only runs when the active locale is `AR` and remains conservative: Arabic `p` tags and their nearest `td` containers only.
- Test Campaign discovery now uses its actual labels and a common container rather than relying only on the heading.
- Test Campaign controls accept custom combobox/button structures used by MoEngage.
- Test send waits for React state to settle before checking the native Test button.
- MutationObserver updates are throttled to avoid UI loops/performance issues.

## Verification

- JavaScript syntax check
- v0.5.0 regression tests
- v0.5.1 regression tests
- v0.5.2 locale/RTL regression tests
- source/dist byte comparison
