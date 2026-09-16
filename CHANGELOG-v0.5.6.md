# RetKit × MoEngage v0.5.6

- RTL Fix now flips explicit `align="left"` to `align="right"` and keeps `text-align:left` → `text-align:right` handling.
- Subject lookup now ignores checkbox/radio/switch controls, preventing accidental `on` values.
- Native MoEngage MDS dropdown handling was hardened for `Send via` and `Locales and Variations`.
- Test-send now waits for dropdown portal options and verifies that `Send via` actually changed.
- `Personalise with a random user` now prefers MoEngage's real `Personalized preview` checkbox when present.
- Recipient email updates now emit blur after input/change events to help MoEngage enable its native Test button.
