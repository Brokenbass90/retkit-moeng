# RetKit v0.5.1

Hotfix for v0.5.0.

## Fixed
- Prevents the MoEngage page from freezing after the RetKit workspace opens.
- Toolbar version and locale labels now update only when their text actually changes, avoiding a MutationObserver feedback loop.

## Features retained
- Native MoEngage locale bridge
- Conservative Arabic RTL Fix
- Native Test Campaign bridge
- RetKit v0.4.2 editor workspace via `@require`
