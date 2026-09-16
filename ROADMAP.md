# Roadmap

Ideas intentionally kept out of v0.4 so the core workflow stays small and reliable.

## v0.5 candidates

### Email size meter

Show HTML byte size and warn when a template approaches Gmail clipping territory. The tool should report source bytes separately from image weight because remote images do not count toward the HTML clipping threshold.

### Asset inspector

Collect every `<img>` and CSS background asset into one panel with URL, alt text, duplicate count, and click-to-source navigation.

### Link inspector / checker

List all `href` values, highlight `#`, empty links, localhost/dev URLs, repeated tracking links, and optionally perform explicit user-triggered HTTP checks.

### Jinja / ContentBlock inspector

Show all `{{ContentBlock[...]}}`, `UserAttribute[...]`, `{% if %}`, `{% elif %}`, and `{% else %}` references used by a template. Useful for locale-heavy MoEngage emails.

### Locale / platform preview presets

Let the developer provide local sample values such as `locale=AR`, `platform=iOS`, or `platform=Android` so simple Jinja branches can be previewed without changing production user data.

### Snapshot diff

Before Restore, show a compact line-level diff between the current HTML and the selected snapshot.

### Email layout outline mode

Temporarily outline tables, rows, cells, and divs in preview to make legacy email layout debugging faster.

### Preflight checklist

One compact pre-send panel combining HTML validation, size, broken/placeholder links, missing alt text, suspicious tracking parameters, and unresolved test URLs.
