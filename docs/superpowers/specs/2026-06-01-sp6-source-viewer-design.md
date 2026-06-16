# SP-6: Provenance → Source Viewer — Design

**Status:** Approved (design)
**Date:** 2026-06-01
**Depends on:** existing provenance/citation pipeline (Inputs → DocumentSection → Chunk → ClaimCitation), the right panel, and the Properties-panel `CitationCard`s.

## Goal

Let a user click a provenance citation on a step and land on the exact quote inside the
original source document, rendered in its original format, in a document viewer that overlays
the canvas at double width. The viewer accepts every format a user can upload.

## Locked decisions

These were settled during brainstorming and are not open for re-litigation in the plan:

1. **Fidelity = full original fidelity, every format.** The viewer renders the document in its
   original look, not a stripped-down extracted-text view. (Extracted text remains only as a
   graceful fallback when rendering fails — see Error handling.)
2. **Click source = the Properties-panel `CitationCard`s.** "Cell" = the selected node/step;
   "provenance boxes" = the citation cards under the panel's Provenance section. There is no
   separate matrix/grid view to wire.
3. **Render mechanism = convert-to-PDF server-side + one pdf.js viewer.** Native PDFs pass
   through unchanged; `docx`/`pptx`/`xlsx`/`txt`/`md` are converted to PDF by headless
   LibreOffice and cached. The frontend has a single pdf.js-based viewer. Confidential
   documents never leave our infrastructure (no hosted/third-party viewer).
4. **Layout = overlay.** The viewer floats over the right side of the canvas at doubled width;
   the canvas keeps its size underneath, partly covered. Closing the viewer reveals the full
   canvas. Clicking a citation auto-opens the overlay and jumps to the quote.

## Non-goals

- No new "lines" or coordinate metadata extracted during parsing. Highlighting is a text-layer
  search for the quote string, not a stored char→pixel mapping.
- No editing of source documents in the viewer. Read-only.
- No change to the upload/parse/extract pipeline beyond lazily producing a cached render PDF.

## Architecture & data flow

```
CitationCard click (input_id, section_ref, quote)
        │
        ▼
RightPanel orchestrator → opens DocumentViewer overlay
   (doubled width, floats over canvas; sets viewerTarget + expanded)
        │
        ▼
GET /api/v2/projects/{pid}/inputs/{input_id}/pdf  ──►  bytes (application/pdf)
        │                                              ▲
   pdf.js (react-pdf) renders pages                    │
        │                            ┌──────────────────┴──────────────────┐
   normalize + search text layer     │ native PDF  → serve original file    │
   for `quote` → <mark> + auto-scroll │ docx/pptx/  → LibreOffice            │
                                      │ xlsx/txt/md   --convert-to pdf       │
                                      │              (cached on             │
                                      │               Input.source_info)    │
                                      └──────────────────────────────────────┘
```

**No DB migration.** Two things ride existing structures:

- The cached-render pointer is stored in `Input.source_info` (JSONB, already `default=dict`).
- Highlighting needs only fields `CitationDetail` already returns: `input_id`, `section_ref`,
  `quote`. `char_start`/`char_end` are **not** needed and stay unexposed.

## Component / file structure

**Backend (new):**

- `backend/app/services/render_pdf.py` — pure render/caching logic. Decides pass-through vs
  convert; invokes LibreOffice; reads/writes the cache pointer; returns an absolute path to a
  PDF on disk. No FastAPI knowledge.
- New route in `backend/app/api/v2/inputs.py` — `GET .../inputs/{input_id}/pdf` thin wrapper:
  resolve input (project-scoped, 404), call the service, stream the file.

**Frontend (new):**

- `src/components/canvas/document-viewer.tsx` — the viewer UI (pdf.js via `react-pdf`,
  highlight, page nav, chrome). Receives `{ projectId, inputId, sectionRef, quote }` and a
  close callback; owns nothing but its own render/scroll state.
- `src/components/canvas/source-highlight.ts` + `.test.ts` — pure helpers:
  `normalizeForMatch(s)` (whitespace/quote normalization) and `targetPageFromRef(sectionRef)`
  (native-PDF page hint). Unit-tested in node-env Vitest per repo convention.

**Frontend (modified):**

- `src/lib/api.ts` — `inputPdfUrl(projectId, inputId)` returning the endpoint URL (react-pdf
  fetches by URL; no `request()` JSON wrapper).
- `src/lib/types.ts` — a small `ViewerTarget` type `{ inputId, sectionRef, quote } | null`.
- `src/components/canvas/properties-panel.tsx` — `CitationCard` becomes a button; new
  `onOpenSource(target)` prop threaded from the panel.
- `src/components/canvas/right-panel.tsx` — owns `viewerTarget` + `expanded` state; renders the
  `DocumentViewer` overlay; `SourcesTab` rows become clickable; the tab's top-right expand
  button opens the viewer in doubled width.

## Backend — conversion + serving

**Endpoint:** `GET /api/v2/projects/{project_id}/inputs/{input_id}/pdf`

- Project-scoped auth identical to the other input routes; 404 if the input is missing or not
  in the project.
- Streams `application/pdf` (FastAPI `FileResponse`).
- 415 if the format cannot be converted (frontend then shows the extracted-text fallback).

**Render service (`render_pdf.py`):**

- **Native PDF** (`mime_type == application/pdf` or `.pdf`) → return the original `file_path`
  unchanged.
- **Convertible** (`docx`/`pptx`/`xlsx`/`txt`/`md`) → run
  `soffice --headless --convert-to pdf --outdir <dir> <file>`, each invocation with a unique
  `-env:UserInstallation=file:///tmp/lo_<uuid>` so concurrent conversions don't collide on
  LibreOffice's single-profile lock.
- **Cache:** write the result as `<original_stem>.rendered.pdf` beside the original; record its
  relative path and the source file's mtime in `Input.source_info["rendered_pdf"]`. On
  subsequent requests, reuse the cache; re-convert only if the file is missing or the source
  mtime changed.
- **Lazy:** conversion happens on the first viewer request for that document, not at upload.
  Uploads stay fast; only documents people actually open pay the conversion cost.
- **Unconvertible/unknown** → raise a 415-mapped error.
- **Startup check:** on app startup, probe for `soffice`/`libreoffice` on PATH and log a clear
  warning if absent (the feature degrades to the extracted-text fallback rather than crashing).

**Concurrency / latency:** conversion is seconds-scale and synchronous within the request on
first open; the frontend shows a "Preparing document…" state. The unique-profile flag allows
parallel conversions of different documents.

## Frontend — the viewer

- `react-pdf` (wraps pdf.js). Its `customTextRenderer` is the highlight hook: it receives each
  text item and returns markup, letting us wrap occurrences of the normalized quote in
  `<mark>`. The pdf.js worker is configured for Turbopack (a known integration wrinkle; the
  plan pins the worker source explicitly).
- **Highlight:** `normalizeForMatch` collapses whitespace and normalizes curly/straight quotes
  on both the quote and the text-layer content before matching; matched runs get a `<mark>`;
  the first match is scrolled into view.
- **Page targeting:**
  - Native PDF → jump to `targetPageFromRef(section_ref)` (e.g. `{page: 3}` → page 3), then
    highlight on that page.
  - Converted file → original page/slide/sheet numbers may not survive conversion, so search
    the whole document and scroll to the first match (the accepted "approximate for converted
    formats" behavior).
- **Chrome:** header with the document name, page navigation, a **width toggle (single ↔
  double) in the top-right** = the "expand" button from the spec, and a close button.
- **Performance:** render pages lazily/virtualized so large PDFs don't block.

## Interaction wiring

- `CitationCard` → clickable button. On click it calls `onOpenSource({ inputId, sectionRef,
  quote })`. State lifts to the RightPanel orchestrator, which sets `viewerTarget`, switches to
  the viewer, expands to double width over the canvas, and the viewer jumps + highlights.
- **Sources tab:** each `DocumentRow` becomes clickable → opens the viewer for that document
  (no highlight, page 1). The tab's top-right expand button opens the viewer in doubled width.
- **Close:** returns the panel to normal width and the canvas to full visibility.

## Error handling & edge cases

- **Conversion fails / LibreOffice missing** → endpoint returns 415/500; the viewer shows the
  extracted-text fallback (we already have `DocumentSection.text`) with the quote highlighted
  there. The feature never hard-fails.
- **Quote not found in the text layer** (whitespace/hyphenation drift after conversion) → open
  to the cited page (or page 1) with a small "couldn't pin the exact location — showing the
  cited page" notice. No silent failure.
- **Large PDFs** → lazy/virtualized page rendering.
- **First-open latency** → "Preparing document…" state while the backend converts.
- **Stale cache** (source re-uploaded) → mtime check triggers re-conversion.

## Testing

**Backend (pytest):**

- Render service: pass-through chosen for native PDF; convert chosen for Office/text formats;
  cache hit vs miss vs stale (mtime) behavior; cache pointer written to `source_info`.
- Endpoint: streams `application/pdf`; 415 on unconvertible; 404 / project-scoping for missing
  or cross-project inputs.
- LibreOffice is stubbed in unit tests (assert the command shape + caching logic). One opt-in
  integration test, skipped unless `soffice` is present, converts a real fixture.

**Frontend:**

- Unit-test the pure helpers in node-env Vitest (no `.test.tsx`, per repo convention):
  `normalizeForMatch` (whitespace + quote-style normalization, match found/not-found) and
  `targetPageFromRef` (page/slide/sheet ref → page hint, and the no-ref case).
- Viewer rendering, overlay layout, and highlight scroll verified by `tsc` + live smoke,
  consistent with how canvas components are handled in this repo.

## Honest risks

- **LibreOffice is a new backend dependency.** Office-file fidelity is only as good as
  LibreOffice's renderer — very good, occasionally imperfect on exotic layouts.
- **Quote highlighting on converted files is best-effort** text search, not a guaranteed
  char-offset match. The extracted-text fallback and the "showing the cited page" notice cover
  the misses.

## Addendum (post-implementation): text fast-path

During live smoke-testing we found that the dev backend has no LibreOffice, so every non-PDF
source — including `.txt` transcripts, the most common input — fell back to just the quote.
Decision (user-approved): add a **text fast-path** alongside the PDF viewer. `.txt`/`.md` (and
`text/*`) sources are served verbatim via `GET /inputs/{id}/text` and rendered as text with a
reliable whitespace/quote-tolerant substring highlight — no LibreOffice, no PDF round-trip. The
viewer probes `/text` first and falls back to the PDF path (LibreOffice-converted) for
`docx`/`pptx`/`xlsx`/native PDF. This is a deliberate refinement of the "single PDF viewer"
decision: for plain text, text *is* the original format, so converting it to PDF adds cost and
fragility without fidelity. LibreOffice remains required only for true Office binaries.
