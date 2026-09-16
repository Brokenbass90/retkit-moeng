# RetKit × MoEngage v0.5.4

## Changes

- Seamless locale switching: RetKit stays mounted while MoEngage remounts the native editor.
- Added a loading veil during locale transitions to remove the underlying-page flash.
- Locale row is separate from the main toolbar; EN is pinned first and the remaining locale codes are ordered Z → A.
- RTL Fix can run when the loaded HTML is Arabic even if MoEngage selected-tab metadata is temporarily stale.
- Added a Subject row synced with the native MoEngage Subject field.
- Send Test panel can select one, several, or all locales and still uses MoEngage native Test Campaign controls.
- Removed top-level Save and Apply now buttons; normal editing remains auto-applied.

## Notes

The Test Campaign bridge still uses the native MoEngage UI rather than a private API.
