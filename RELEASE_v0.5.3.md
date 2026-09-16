# RetKit v0.5.3

Bug-fix release focused on click-to-source accuracy and MoEngage locale stability.

## Fixed

- Short repeated values such as step number `1` map to the clicked element instead of the first raw `1` found in CSS/HTML.
- Locale UI moved to a dedicated row below the main RetKit toolbar.
- English stays first; remaining locales are sorted A → Z.
- Active locale prefers the actual rendered/editor `<html lang>` value over stale native React tab metadata.
- Removed the bridge-wide document `MutationObserver` that repeatedly rescanned the MoEngage React tree and could freeze the page.
- Native Test Campaign lookup is no longer repeated for every locale candidate ancestor during locale discovery.

## Packaging

`dist/retkit-moengage.user.js` is now standalone and includes both the editor core and the v0.5 bridge. No external `@require` is needed for local installation.
