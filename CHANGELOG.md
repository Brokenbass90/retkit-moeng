# Changelog

## 0.4.2 - 2026-09-16

- Mixed-copy click mapping: clicking normal text inside a paragraph that contains inline markup selects the whole paragraph content including `<b>`/other inline tags.
- Clicking directly on bold text still selects only the bold copy.
- `History` now shows a dropdown marker (`History ▾`) so saved snapshots are easier to discover.

## 0.4.1 - 2026-09-16

- Fixed preview-to-source mapping after responsive reflow/resizing.
- Text-node hit testing now uses live DOM ranges and global text occurrence before brittle tag ordinals.

## 0.4.0 - 2026-09-16

- Moved RetKit for MoEngage into a standalone repository-ready project.
- Added exact text-node mapping for mixed inline copy.
- Added occurrence-aware mapping for repeated image URLs and links.
- Added up to 10 local snapshots per email with safe restore.
- Added email-aware HTML validation and issue-to-source navigation.
- Added visible version label in the workspace header.
- Added complete English and Russian installation/usage documentation.
- Updated Tampermonkey update/download URLs for the standalone repository.

## 0.3.1

- Added native MoEngage/Froala apply bridge improvements.
- Added compact toolbar and preview mode icons.
- Added Find + Replace and Replace All.
- Added structural block folding.

## 0.3.0

- Added fullscreen RetKit workspace and live preview-to-source workflow.
