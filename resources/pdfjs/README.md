# Vendored pdf.js for Onward

This tree bundles Mozilla pdf.js (Apache-2.0) and a small embedded viewer
(`app/`) adapted for Onward's Electron renderer.

- `build/`, `web/`, `cmaps/`, `standard_fonts/` — pdf.js v3.11.174 distribution
  (copied verbatim from the reference project `Dark_PDF_Reader/vendor/pdfjs/`).
  See `LICENSE` for the pdf.js license terms.
- `app/viewer.{html,js,css}` — Onward's trimmed viewer. Adapted from the
  `Dark_PDF_Reader` reference (ISC); all Chrome-extension glue, the "Save to
  GitHub Issue" flow, and the standalone options/background pages have been
  removed. Theme and i18n are provided by the Onward renderer via
  `postMessage` (`onward:pdf:theme`, `onward:pdf:i18n`).

The renderer loads the viewer with:

    file://.../resources/pdfjs/app/viewer.html?file=<file-url>&name=<display-name>

To refresh pdf.js to a newer version, rerun `scripts/sync-pdfjs-assets.sh`.
