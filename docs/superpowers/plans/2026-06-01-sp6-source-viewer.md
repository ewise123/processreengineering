# SP-6: Provenance → Source Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user click a provenance citation on a step and land on the exact quote inside the source document, rendered in its original format, in a doubled-width viewer overlaying the canvas.

**Architecture:** A backend render service converts any non-PDF upload to PDF via headless LibreOffice (native PDFs pass through), caches the result on `Input.source_info`, and a new endpoint streams the PDF. The frontend renders it with one `react-pdf` viewer, highlights the quote by searching the text layer, and floats as a doubled-width overlay opened from the Properties-panel citation cards or the Sources tab. Viewer state lives at the page level (the common parent of the Properties panel, Sources tab, and canvas overlay).

**Tech Stack:** FastAPI + SQLAlchemy (backend), headless LibreOffice (`soffice`), Next.js 16 / React 19 / TypeScript, `react-pdf` (pdf.js), Vitest (node-env, pure-logic), pytest.

**Spec:** `docs/superpowers/specs/2026-06-01-sp6-source-viewer-design.md`

---

## Notes for the implementer (read once)

- **Python interpreter:** the venv python is `backend/.venv/bin/python`. Bare `python` is not on PATH. Run pytest as `backend/.venv/bin/python -m pytest ...` from the `backend/` directory.
- **Backend test DB:** tests use a separate `poet_test` DB; the `db` fixture TRUNCATEs between tests. Seed via Org → User → Project → Input (see the `_seed_*` helpers already in `tests/test_extract_input_claims.py` for the exact pattern).
- **Backend test style:** call route functions directly with keyword args (`project=…, db=…`), not via an HTTP client. See existing tests.
- **Frontend gates:** `npx tsc --noEmit` (must be clean) and `npx vitest run` (node-env; only `src/**/*.test.ts`, never `.test.tsx`). UI components are verified by `tsc` + live smoke, not component tests — this is the established repo convention.
- **`Input.source_info`** is JSONB with `default=dict` (already exists — no migration). We stash the cached-render pointer there.
- **`CitationDetail`** (frontend `src/lib/types.ts`) already carries `input_id`, `input_name`, `section_ref`, `quote` — everything highlighting needs. No new citation fields.
- **Commits:** local only. Never push. Never use `rm`/`git rm`. Never switch branches. End every commit message with the `Co-Authored-By` trailer shown in the steps.

---

## File structure

**Backend — create:**
- `backend/app/services/render_pdf.py` — pure render/caching logic: classify format, convert via LibreOffice, manage the `source_info` cache pointer, return an absolute PDF path. No FastAPI imports.
- `backend/tests/test_render_pdf.py` — unit tests for the service + the new endpoint (LibreOffice stubbed).

**Backend — modify:**
- `backend/app/api/v2/inputs.py` — add `GET /{input_id}/pdf` route (thin wrapper).
- `backend/app/factory.py` — add a LibreOffice-availability probe to `lifespan` (logs a warning if absent).

**Frontend — create:**
- `src/components/canvas/pdf-worker.ts` — one-time pdf.js worker + CSS configuration for `react-pdf` under Turbopack.
- `src/components/canvas/source-highlight.ts` — pure helpers: `normalizeForMatch`, `targetPageFromRef`, `isQuoteFragment`.
- `src/components/canvas/source-highlight.test.ts` — Vitest unit tests for those helpers.
- `src/components/canvas/document-viewer.tsx` — the viewer UI (react-pdf, highlight, page nav, chrome, fallback).

**Frontend — modify:**
- `src/lib/types.ts` — add `ViewerTarget`.
- `src/lib/api.ts` — add `inputPdfUrl(projectId, inputId)`.
- `src/components/canvas/properties-panel.tsx` — `CitationCard` → button; thread `onOpenSource`.
- `src/components/canvas/right-panel.tsx` — Sources rows clickable + tab expand button; thread `onOpenSource`.
- `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` — own `viewerTarget`/`viewerExpanded`; render the `DocumentViewer` overlay; pass `onOpenSource` down.

---

## Task 1: Render service — format classification

**Files:**
- Create: `backend/app/services/render_pdf.py`
- Test: `backend/tests/test_render_pdf.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_render_pdf.py
import pytest

from app.models.input import Input
from app.services.render_pdf import (
    UnsupportedRenderFormat,
    is_native_pdf,
    needs_conversion,
)


def _inp(name: str, mime: str | None) -> Input:
    return Input(
        project_id=None, type="sop_document", name=name,
        file_path=f"uploads/x/{name}", mime_type=mime, status="parsed",
    )


def test_native_pdf_by_mime():
    assert is_native_pdf(_inp("a.pdf", "application/pdf")) is True
    assert needs_conversion(_inp("a.pdf", "application/pdf")) is False


def test_native_pdf_by_suffix_when_mime_missing():
    assert is_native_pdf(_inp("a.pdf", None)) is True


def test_office_and_text_need_conversion():
    for nm, mime in [
        ("a.docx", None), ("a.pptx", None), ("a.xlsx", None),
        ("a.txt", "text/plain"), ("a.md", "text/markdown"),
    ]:
        assert is_native_pdf(_inp(nm, mime)) is False
        assert needs_conversion(_inp(nm, mime)) is True


def test_unsupported_format_is_neither():
    inp = _inp("a.zip", "application/zip")
    assert is_native_pdf(inp) is False
    assert needs_conversion(inp) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_render_pdf.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.render_pdf'`.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/services/render_pdf.py
from pathlib import Path

from app.models.input import Input

# Formats LibreOffice can convert to PDF (besides native PDF pass-through).
CONVERTIBLE_SUFFIXES = {".docx", ".pptx", ".xlsx", ".xlsm", ".txt", ".md"}


class UnsupportedRenderFormat(Exception):
    """Raised when an input cannot be rendered as a PDF."""


def is_native_pdf(inp: Input) -> bool:
    if inp.mime_type == "application/pdf":
        return True
    return Path(inp.name or "").suffix.lower() == ".pdf"


def needs_conversion(inp: Input) -> bool:
    if is_native_pdf(inp):
        return False
    suffix = Path(inp.name or "").suffix.lower()
    if suffix in CONVERTIBLE_SUFFIXES:
        return True
    return bool(inp.mime_type and inp.mime_type.startswith("text/"))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_render_pdf.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/render_pdf.py backend/tests/test_render_pdf.py
git commit -m "feat(sp6): render-pdf format classification

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Render service — convert + cache orchestration

**Files:**
- Modify: `backend/app/services/render_pdf.py`
- Test: `backend/tests/test_render_pdf.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_render_pdf.py`:

```python
from uuid import uuid4

from app.models.identity import Organization, User
from app.models.project import Project
from app.services import render_pdf


def _seed_input(db, *, name: str, mime: str | None) -> Input:
    org = Organization(name="t-org")
    db.add(org)
    db.flush()
    user = User(email=f"u-{uuid4()}@t.local", name="t", org_id=org.id)
    db.add(user)
    db.flush()
    proj = Project(name="t-proj", org_id=org.id, status="active")
    db.add(proj)
    db.flush()
    inp = Input(
        project_id=proj.id, type="sop_document", name=name,
        file_path=f"uploads/{proj.id}/{name}", mime_type=mime, status="parsed",
        uploaded_by=user.id, source_info={},
    )
    db.add(inp)
    db.flush()
    return inp


def test_native_pdf_returns_original_without_conversion(db, tmp_path, monkeypatch):
    src = tmp_path / "real.pdf"
    src.write_bytes(b"%PDF-1.4 fake")
    inp = _seed_input(db, name="real.pdf", mime="application/pdf")
    monkeypatch.setattr(render_pdf, "resolve_path", lambda rel: src)
    called = {"convert": False}
    monkeypatch.setattr(
        render_pdf, "convert_to_pdf",
        lambda *a, **k: called.__setitem__("convert", True) or src,
    )

    out = render_pdf.rendered_pdf_path(inp, db)

    assert out == src
    assert called["convert"] is False


def test_convertible_miss_converts_and_caches(db, tmp_path, monkeypatch):
    src = tmp_path / "doc.docx"
    src.write_bytes(b"docx-bytes")
    rendered = tmp_path / "doc.pdf"
    rendered.write_bytes(b"%PDF rendered")
    inp = _seed_input(db, name="doc.docx", mime=None)
    monkeypatch.setattr(render_pdf, "resolve_path", lambda rel: src)
    calls = {"n": 0}

    def fake_convert(source, out_dir):
        calls["n"] += 1
        return rendered

    monkeypatch.setattr(render_pdf, "convert_to_pdf", fake_convert)

    out = render_pdf.rendered_pdf_path(inp, db)

    assert out == rendered
    assert calls["n"] == 1
    assert inp.source_info["rendered_pdf"]["path"] == str(rendered)


def test_convertible_cache_hit_skips_conversion(db, tmp_path, monkeypatch):
    src = tmp_path / "doc.docx"
    src.write_bytes(b"docx-bytes")
    rendered = tmp_path / "doc.pdf"
    rendered.write_bytes(b"%PDF rendered")
    inp = _seed_input(db, name="doc.docx", mime=None)
    inp.source_info = {
        "rendered_pdf": {"path": str(rendered), "src_mtime": src.stat().st_mtime}
    }
    db.flush()
    monkeypatch.setattr(render_pdf, "resolve_path", lambda rel: src)

    def boom(*a, **k):
        raise AssertionError("should not convert on cache hit")

    monkeypatch.setattr(render_pdf, "convert_to_pdf", boom)

    out = render_pdf.rendered_pdf_path(inp, db)
    assert out == rendered


def test_stale_cache_triggers_reconversion(db, tmp_path, monkeypatch):
    src = tmp_path / "doc.docx"
    src.write_bytes(b"docx-bytes")
    rendered = tmp_path / "doc.pdf"
    rendered.write_bytes(b"%PDF rendered")
    inp = _seed_input(db, name="doc.docx", mime=None)
    inp.source_info = {
        "rendered_pdf": {"path": str(rendered), "src_mtime": src.stat().st_mtime - 999}
    }
    db.flush()
    monkeypatch.setattr(render_pdf, "resolve_path", lambda rel: src)
    calls = {"n": 0}
    monkeypatch.setattr(
        render_pdf, "convert_to_pdf",
        lambda *a, **k: calls.__setitem__("n", calls["n"] + 1) or rendered,
    )

    render_pdf.rendered_pdf_path(inp, db)
    assert calls["n"] == 1


def test_unsupported_format_raises(db, tmp_path, monkeypatch):
    src = tmp_path / "a.zip"
    src.write_bytes(b"zip")
    inp = _seed_input(db, name="a.zip", mime="application/zip")
    monkeypatch.setattr(render_pdf, "resolve_path", lambda rel: src)
    with pytest.raises(render_pdf.UnsupportedRenderFormat):
        render_pdf.rendered_pdf_path(inp, db)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_render_pdf.py -q`
Expected: FAIL with `AttributeError: module 'app.services.render_pdf' has no attribute 'resolve_path'` / `convert_to_pdf` / `rendered_pdf_path`.

- [ ] **Step 3: Write minimal implementation**

Add these imports and functions to `backend/app/services/render_pdf.py`:

```python
import shutil
import subprocess
import uuid
from sqlalchemy.orm import Session

from app.services.storage import resolve_path  # re-exported so tests can monkeypatch


def _soffice_bin() -> str | None:
    return shutil.which("soffice") or shutil.which("libreoffice")


def libreoffice_available() -> bool:
    return _soffice_bin() is not None


def convert_to_pdf(source: Path, out_dir: Path) -> Path:
    """Convert `source` to PDF in `out_dir` via headless LibreOffice. Returns the PDF path."""
    soffice = _soffice_bin()
    if soffice is None:
        raise UnsupportedRenderFormat("LibreOffice (soffice) is not installed")
    profile = f"file:///tmp/lo_{uuid.uuid4().hex}"
    cmd = [
        soffice, "--headless", f"-env:UserInstallation={profile}",
        "--convert-to", "pdf", "--outdir", str(out_dir), str(source),
    ]
    subprocess.run(cmd, check=True, capture_output=True, timeout=120)
    out = out_dir / f"{source.stem}.pdf"
    if not out.is_file():
        raise UnsupportedRenderFormat(f"Conversion produced no PDF for {source.name}")
    return out


def rendered_pdf_path(inp: Input, db: Session) -> Path:
    """Return an absolute path to a renderable PDF for this input.

    Native PDFs pass through. Other supported formats are converted via
    LibreOffice and cached (pointer in Input.source_info). Re-converts when the
    cache is missing or the source file's mtime changed.
    """
    src = resolve_path(inp.file_path)
    if not src.is_file():
        raise FileNotFoundError(str(src))
    if is_native_pdf(inp):
        return src
    if not needs_conversion(inp):
        raise UnsupportedRenderFormat(f"Cannot render {inp.name}")

    mtime = src.stat().st_mtime
    cached = (inp.source_info or {}).get("rendered_pdf")
    if cached:
        cached_path = Path(cached["path"])
        if cached_path.is_file() and cached.get("src_mtime") == mtime:
            return cached_path

    rendered = convert_to_pdf(src, src.parent)
    info = dict(inp.source_info or {})
    info["rendered_pdf"] = {"path": str(rendered), "src_mtime": mtime}
    inp.source_info = info
    db.commit()
    return rendered
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_render_pdf.py -q`
Expected: PASS (all render-service tests green).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/render_pdf.py backend/tests/test_render_pdf.py
git commit -m "feat(sp6): render-pdf convert + cache orchestration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: LibreOffice startup probe

**Files:**
- Modify: `backend/app/factory.py:11-18`

- [ ] **Step 1: Add the probe to the lifespan**

Edit the `lifespan` function in `backend/app/factory.py` so it reads:

```python
from app.services.render_pdf import libreoffice_available


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Startup: clean up any rows stuck in 'extracting' from a prior crash.
    with SessionLocal() as db:
        swept = sweep_stale_extracting_inputs(db)
        if swept:
            print(f"[startup] swept {swept} stale extracting input(s) to failed")
    if not libreoffice_available():
        print(
            "[startup] WARNING: LibreOffice (soffice) not found on PATH — "
            "non-PDF source documents cannot be rendered; the viewer will fall "
            "back to the cited quote."
        )
    yield
```

(Keep the existing `from app.services.startup import sweep_stale_extracting_inputs` import; add the new import alongside it.)

- [ ] **Step 2: Verify the app still imports**

Run: `cd backend && .venv/bin/python -c "from app.factory import create_app; create_app(); print('ok')"`
Expected: prints `ok` (and the WARNING line only if soffice is absent).

- [ ] **Step 3: Commit**

```bash
git add backend/app/factory.py
git commit -m "feat(sp6): warn at startup when LibreOffice is unavailable

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: PDF-serving endpoint

**Files:**
- Modify: `backend/app/api/v2/inputs.py` (imports near top; new route at end)
- Test: `backend/tests/test_render_pdf.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_render_pdf.py`:

```python
from fastapi import HTTPException
from fastapi.responses import FileResponse

from app.api.v2.inputs import get_input_pdf


def test_endpoint_returns_file_response_for_pdf(db, tmp_path, monkeypatch):
    src = tmp_path / "real.pdf"
    src.write_bytes(b"%PDF-1.4 fake")
    inp = _seed_input(db, name="real.pdf", mime="application/pdf")
    proj = db.get(Project, inp.project_id)
    monkeypatch.setattr(render_pdf, "resolve_path", lambda rel: src)

    resp = get_input_pdf(project=proj, input_id=inp.id, db=db)

    assert isinstance(resp, FileResponse)
    assert resp.media_type == "application/pdf"
    assert str(resp.path) == str(src)


def test_endpoint_404_for_cross_project_input(db, tmp_path, monkeypatch):
    inp = _seed_input(db, name="real.pdf", mime="application/pdf")
    other = Project(name="other", org_id=db.get(Project, inp.project_id).org_id, status="active")
    db.add(other)
    db.flush()
    with pytest.raises(HTTPException) as ei:
        get_input_pdf(project=other, input_id=inp.id, db=db)
    assert ei.value.status_code == 404


def test_endpoint_415_for_unsupported(db, tmp_path, monkeypatch):
    src = tmp_path / "a.zip"
    src.write_bytes(b"zip")
    inp = _seed_input(db, name="a.zip", mime="application/zip")
    proj = db.get(Project, inp.project_id)
    monkeypatch.setattr(render_pdf, "resolve_path", lambda rel: src)
    with pytest.raises(HTTPException) as ei:
        get_input_pdf(project=proj, input_id=inp.id, db=db)
    assert ei.value.status_code == 415
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_render_pdf.py -q`
Expected: FAIL with `ImportError: cannot import name 'get_input_pdf'`.

- [ ] **Step 3: Write minimal implementation**

Add to the imports at the top of `backend/app/api/v2/inputs.py`:

```python
from fastapi.responses import FileResponse

from app.services.render_pdf import (
    UnsupportedRenderFormat,
    rendered_pdf_path,
)
```

Add this route at the end of `backend/app/api/v2/inputs.py`:

```python
@router.get("/{input_id}/pdf")
def get_input_pdf(
    project: Annotated[Project, Depends(get_project_or_404)],
    input_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> FileResponse:
    inp = db.get(Input, input_id)
    if inp is None or inp.project_id != project.id:
        raise HTTPException(status_code=404, detail="Input not found")
    if not inp.file_path:
        raise HTTPException(status_code=422, detail="Input has no file_path")
    try:
        pdf_path = rendered_pdf_path(inp, db)
    except UnsupportedRenderFormat as e:
        raise HTTPException(status_code=415, detail=str(e))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Source file not found on disk")
    return FileResponse(
        path=str(pdf_path),
        media_type="application/pdf",
        filename=f"{inp.name}.pdf" if not inp.name.lower().endswith(".pdf") else inp.name,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_render_pdf.py -q`
Expected: PASS (all render tests green).

- [ ] **Step 5: Run the full backend suite (no regressions)**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: PASS (all prior tests still green).

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/v2/inputs.py backend/tests/test_render_pdf.py
git commit -m "feat(sp6): GET inputs/{id}/pdf serves rendered PDF

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Frontend dependency + pdf.js worker config

**Files:**
- Create: `src/components/canvas/pdf-worker.ts`
- Modify: `package.json` (via `npm install`)

- [ ] **Step 1: Install react-pdf**

Run: `npm install react-pdf`
Expected: `react-pdf` (and its `pdfjs-dist` peer) added to `package.json` dependencies.

- [ ] **Step 2: Create the worker/CSS config module**

```ts
// src/components/canvas/pdf-worker.ts
// One-time pdf.js worker + text/annotation layer CSS setup for react-pdf.
// Importing this module (for its side effects) configures the worker so it
// works under Next.js Turbopack. Import it once from the viewer component.
import { pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();
```

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: clean (no errors). If react-pdf ships its own types this passes; if a `Cannot find module 'react-pdf'` error appears, confirm Step 1 completed.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/components/canvas/pdf-worker.ts
git commit -m "feat(sp6): add react-pdf + pdf.js worker config

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Source-highlight pure helpers

**Files:**
- Create: `src/components/canvas/source-highlight.ts`
- Test: `src/components/canvas/source-highlight.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/components/canvas/source-highlight.test.ts
import { describe, expect, it } from "vitest";

import {
  isQuoteFragment,
  normalizeForMatch,
  targetPageFromRef,
} from "./source-highlight";

describe("normalizeForMatch", () => {
  it("collapses whitespace and lowercases", () => {
    expect(normalizeForMatch("  The   Quick\nBrown ")).toBe("the quick brown");
  });
  it("normalizes curly quotes and dashes to ascii", () => {
    expect(normalizeForMatch("“words” — more")).toBe('"words" - more');
  });
});

describe("targetPageFromRef", () => {
  it("reads page", () => {
    expect(targetPageFromRef({ page: 3 })).toBe(3);
  });
  it("reads slide as a page index", () => {
    expect(targetPageFromRef({ slide: 5 })).toBe(5);
  });
  it("returns null when no positional ref", () => {
    expect(targetPageFromRef({ sheet: "Sheet1" })).toBeNull();
    expect(targetPageFromRef({})).toBeNull();
    expect(targetPageFromRef(null)).toBeNull();
  });
});

describe("isQuoteFragment", () => {
  const quote = "the approval must complete within two business days";
  it("matches a multi-word run from the quote", () => {
    expect(isQuoteFragment("approval must complete", quote)).toBe(true);
  });
  it("matches case- and whitespace-insensitively", () => {
    expect(isQuoteFragment("  Two   Business ", quote)).toBe(true);
  });
  it("rejects text not in the quote", () => {
    expect(isQuoteFragment("rejected immediately", quote)).toBe(false);
  });
  it("rejects trivial/empty fragments to avoid over-highlighting", () => {
    expect(isQuoteFragment(" ", quote)).toBe(false);
    expect(isQuoteFragment("a", quote)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/canvas/source-highlight.test.ts`
Expected: FAIL — cannot resolve `./source-highlight`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/components/canvas/source-highlight.ts

/** Normalize text for tolerant matching: ascii-ize quotes/dashes, collapse
 *  whitespace, lowercase. Applied to BOTH the quote and the text-layer item. */
export function normalizeForMatch(s: string): string {
  return s
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Page hint from a citation's section_ref. Native PDFs carry {page} or {slide}
 *  that maps to a 1-based page; sheet/heading refs have no page → null. */
export function targetPageFromRef(
  ref: Record<string, unknown> | null | undefined,
): number | null {
  if (!ref) return null;
  const v = ref.page ?? ref.slide;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** True when a text-layer item is part of the quote. Used per-item in
 *  react-pdf's customTextRenderer to decide whether to wrap it in <mark>.
 *  Requires a non-trivial fragment (>1 char) to avoid highlighting stray
 *  letters/spaces. */
export function isQuoteFragment(itemText: string, quote: string): boolean {
  const frag = normalizeForMatch(itemText);
  if (frag.length < 2) return false;
  return normalizeForMatch(quote).includes(frag);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/canvas/source-highlight.test.ts`
Expected: PASS (all describes green).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/source-highlight.ts src/components/canvas/source-highlight.test.ts
git commit -m "feat(sp6): quote-highlight + page-target helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: API client + ViewerTarget type

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the ViewerTarget type**

Append to `src/lib/types.ts`:

```ts
/** What the document viewer should open to. `sectionRef`/`quote` drive the
 *  jump-and-highlight; both null when opening a document without a citation
 *  (e.g. from the Sources tab). */
export interface ViewerTarget {
  inputId: UUID;
  inputName: string;
  sectionRef: Record<string, unknown> | null;
  quote: string | null;
}
```

- [ ] **Step 2: Add the URL builder to the api client**

In `src/lib/api.ts`, add this entry inside the `api` object, next to the other Inputs methods (after `listInputs`):

```ts
  /** Absolute URL of the rendered-PDF stream for a source document.
   *  react-pdf fetches by URL, so this returns a string (not a JSON request). */
  inputPdfUrl: (projectId: UUID, inputId: UUID) =>
    `${API_BASE}/api/v2/projects/${projectId}/inputs/${inputId}/pdf`,
```

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts
git commit -m "feat(sp6): ViewerTarget type + inputPdfUrl builder

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: DocumentViewer component

**Files:**
- Create: `src/components/canvas/document-viewer.tsx`

This is a UI component — verified by `tsc` (Step 2) and live smoke, per repo convention (no `.test.tsx`).

- [ ] **Step 1: Write the component**

```tsx
// src/components/canvas/document-viewer.tsx
"use client";

import { Maximize2, Minimize2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Document, Page } from "react-pdf";

import "./pdf-worker";
import { api } from "@/lib/api";
import type { UUID, ViewerTarget } from "@/lib/types";
import {
  isQuoteFragment,
  targetPageFromRef,
} from "@/components/canvas/source-highlight";

export function DocumentViewer({
  projectId,
  target,
  expanded,
  onToggleExpanded,
  onClose,
}: {
  projectId: UUID;
  target: ViewerTarget;
  expanded: boolean;
  onToggleExpanded: () => void;
  onClose: () => void;
}) {
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState(true); // whether we found/scrolled a match
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileUrl = api.inputPdfUrl(projectId, target.inputId);

  // Highlight quote fragments in each rendered text item.
  const textRenderer = target.quote
    ? ({ str }: { str: string }) =>
        isQuoteFragment(str, target.quote as string)
          ? `<mark class="bg-amber-200 text-inherit" data-sp6-hit="1">${str}</mark>`
          : str
    : undefined;

  // After pages render, scroll the first highlighted run into view. If none,
  // fall back to the cited page (or top) and flag the approximate state.
  useEffect(() => {
    if (!numPages) return;
    const id = window.setTimeout(() => {
      const root = scrollRef.current;
      if (!root) return;
      const hit = root.querySelector('[data-sp6-hit="1"]');
      if (hit) {
        hit.scrollIntoView({ block: "center" });
        setPinned(true);
        return;
      }
      setPinned(target.quote === null); // only "unpinned" if we expected a match
      const page = targetPageFromRef(target.sectionRef);
      if (page && page > 1) {
        root
          .querySelector(`[data-page-number="${page}"]`)
          ?.scrollIntoView({ block: "start" });
      }
    }, 300);
    return () => window.clearTimeout(id);
  }, [numPages, target]);

  return (
    <div
      className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white"
      style={{
        width: expanded ? 720 : 360,
        boxShadow:
          "0 8px 28px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -1px rgba(15, 23, 42, 0.08)",
        transition: "width 150ms ease",
      }}
    >
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-slate-200 px-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-slate-700">
          {target.inputName}
        </span>
        <button
          type="button"
          onClick={onToggleExpanded}
          title={expanded ? "Collapse width" : "Expand width"}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-50 hover:text-slate-900"
        >
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close viewer"
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-50 hover:text-slate-900"
        >
          <X size={14} />
        </button>
      </div>

      {!pinned && target.quote && (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[10px] text-amber-700">
          Couldn&apos;t pin the exact location — showing the document. Quote:
          <span className="italic"> &ldquo;{target.quote}&rdquo;</span>
        </div>
      )}

      {/* Body */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-slate-100 p-2">
        {error ? (
          <div className="space-y-2 p-3">
            <p className="text-[11px] text-rose-600">
              Couldn&apos;t render this document in its original format.
            </p>
            {target.quote && (
              <p className="rounded-md border border-slate-200 bg-white p-2 text-[11px] italic text-slate-600">
                &ldquo;{target.quote}&rdquo;
              </p>
            )}
          </div>
        ) : (
          <Document
            file={fileUrl}
            onLoadSuccess={({ numPages }) => setNumPages(numPages)}
            onLoadError={(e) => setError(e.message)}
            loading={
              <div className="p-4 text-[11px] italic text-slate-400">
                Preparing document…
              </div>
            }
          >
            {Array.from({ length: numPages }, (_, i) => (
              <Page
                key={i}
                pageNumber={i + 1}
                width={expanded ? 690 : 330}
                customTextRenderer={textRenderer}
                renderAnnotationLayer={false}
                className="mb-2 bg-white shadow-sm"
              />
            ))}
          </Document>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: clean. (If `customTextRenderer`'s parameter type complains, the react-pdf type is `CustomTextRenderer`; annotate the param as `{ str: string }` as shown — react-pdf passes more fields but we only read `str`.)

- [ ] **Step 3: Commit**

```bash
git add src/components/canvas/document-viewer.tsx
git commit -m "feat(sp6): DocumentViewer — react-pdf render + quote highlight

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Wire CitationCard → onOpenSource

**Files:**
- Modify: `src/components/canvas/properties-panel.tsx` (CitationCard ~477-514; the panel's prop list and the `CitationCard` render site ~349-392)

- [ ] **Step 1: Add `onOpenSource` to the PropertiesPanel prop type**

In `src/components/canvas/properties-panel.tsx`, add an import for the type and a prop. Add to the imports:

```tsx
import type { ViewerTarget } from "@/lib/types";
```

Add to the `PropertiesPanel` props type (alongside the existing callback props like `onAddStep`):

```tsx
  /** Open a source document in the viewer, jumping to a citation's quote. */
  onOpenSource: (target: ViewerTarget) => void;
```

And destructure `onOpenSource` in the component's parameter list.

- [ ] **Step 2: Thread it to CitationCard and make the card clickable**

Change the `CitationCard` render site (inside the Provenance section) to pass the handler:

```tsx
                  <CitationCard
                    key={cit.citation_id}
                    kind={claim.kind}
                    citation={cit}
                    onOpenSource={onOpenSource}
                  />
```

Update the `CitationCard` definition signature and wrap its body in a button:

```tsx
function CitationCard({
  kind,
  citation,
  onOpenSource,
}: {
  kind: string;
  citation: CitationDetail;
  onOpenSource: (target: ViewerTarget) => void;
}) {
  const ref = citation.section_ref;
  const refLabel = formatSectionRef(citation.section_kind, ref);
  return (
    <li>
      <button
        type="button"
        onClick={() =>
          onOpenSource({
            inputId: citation.input_id,
            inputName: citation.input_name,
            sectionRef: citation.section_ref,
            quote: citation.quote,
          })
        }
        title="View this quote in the source document"
        className="w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-left hover:border-violet-300 hover:bg-violet-50"
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-700"
            style={{ background: KIND_TINT[kind] ?? "#e2e8f0" }}
          >
            {kind.replace(/_/g, " ")}
          </span>
          <span className="ml-1 truncate text-[10px] font-semibold text-slate-700">
            {citation.input_name}
          </span>
          {citation.confidence != null && (
            <span className="ml-1 text-[9px] tabular-nums text-slate-400">
              {Math.round(citation.confidence * 100)}%
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[10.5px] italic leading-snug text-slate-500">
          &ldquo;{citation.quote}&rdquo;
        </div>
        {refLabel && (
          <div className="mt-0.5 text-[9px] uppercase tracking-wider text-slate-400">
            {refLabel}
          </div>
        )}
      </button>
    </li>
  );
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: one error at the `<PropertiesPanel>` call site in the page (missing `onOpenSource` prop). This is expected and closed in Task 10. Confirm there are no OTHER errors in `properties-panel.tsx` itself.

- [ ] **Step 4: Commit**

```bash
git add src/components/canvas/properties-panel.tsx
git commit -m "feat(sp6): citation cards open the source viewer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Page integration — viewer overlay + state

**Files:**
- Modify: `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx`

- [ ] **Step 1: Add imports + state**

Add imports near the other canvas-component imports (top of the file):

```tsx
import { DocumentViewer } from "@/components/canvas/document-viewer";
import type { ViewerTarget } from "@/lib/types";
```

Add state alongside the other `useState` declarations in the page component:

```tsx
  const [viewerTarget, setViewerTarget] = useState<ViewerTarget | null>(null);
  const [viewerExpanded, setViewerExpanded] = useState(true);
```

- [ ] **Step 2: Pass `onOpenSource` to PropertiesPanel**

On the `<PropertiesPanel ... />` element (around line 349), add:

```tsx
            onOpenSource={(target) => {
              setViewerTarget(target);
              setViewerExpanded(true);
            }}
```

- [ ] **Step 3: Render the viewer overlay**

Immediately after the closing of the RightPanel wrapper `</div>` block (after the block that starts at ~line 403 `{data && (`), add the overlay. It floats over the canvas, to the LEFT of the always-visible right panel:

```tsx
      {/* Source document viewer — floats over the canvas at single/double
          width; opened from citation cards or the Sources tab. */}
      {viewerTarget && (
        <div
          style={{
            position: "absolute",
            right: rightCollapsed ? 64 : 384,
            top: 60,
            bottom: 60,
            zIndex: 30,
            display: "flex",
          }}
        >
          <DocumentViewer
            projectId={params.id}
            target={viewerTarget}
            expanded={viewerExpanded}
            onToggleExpanded={() => setViewerExpanded((v) => !v)}
            onClose={() => setViewerTarget(null)}
          />
        </div>
      )}
```

- [ ] **Step 4: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: the PropertiesPanel error from Task 9 is now resolved. A new error remains at the `<RightPanel>` call site (missing `onOpenSource`), closed in Task 11. Confirm no other errors.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx"
git commit -m "feat(sp6): page owns viewer state + renders the overlay

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Sources tab wiring

**Files:**
- Modify: `src/components/canvas/right-panel.tsx` (prop type ~73-101; SourcesTab ~973-1018; the page's `<RightPanel>` call site)

- [ ] **Step 1: Thread `onOpenSource` through RightPanel**

Add to the `RightPanel` props type and destructuring (alongside `onNavigateVersion`):

```tsx
  /** Open a source document in the viewer (no citation = page 1, no highlight). */
  onOpenSource: (target: ViewerTarget) => void;
```

Add the type import at the top of `right-panel.tsx`:

```tsx
import type {
  ChatTurn,
  InputRow,
  NodeIssue,
  ReviewState,
  UUID,
  ViewerTarget,
} from "@/lib/types";
```

(Merge `ViewerTarget` into the existing `@/lib/types` import block rather than adding a second import.)

- [ ] **Step 2: Pass it down to SourcesTab**

Find where `SourcesTab` is rendered (the `tab === "sources"` branch) and pass the prop:

```tsx
        {tab === "sources" && (
          <SourcesTab projectId={projectId} onOpenSource={onOpenSource} />
        )}
```

- [ ] **Step 3: Make Sources rows clickable + add the tab expand button**

Replace `SourcesTab` and `DocumentRow` (~973-1018) with:

```tsx
// ─── Sources tab ────────────────────────────────────────────
function SourcesTab({
  projectId,
  onOpenSource,
}: {
  projectId: UUID;
  onOpenSource: (target: ViewerTarget) => void;
}) {
  const inputsQuery = useQuery({
    queryKey: ["inputs", projectId],
    queryFn: () => api.listInputs(projectId, { limit: 200 }),
  });
  const items = inputsQuery.data?.items ?? [];
  return (
    <div className="h-full overflow-y-auto px-3 py-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
        Source documents · {items.length}
      </div>
      {inputsQuery.isLoading && (
        <div className="text-[11px] italic text-slate-400">Loading…</div>
      )}
      <div className="space-y-1">
        {items.map((d) => (
          <DocumentRow key={d.id} input={d} onOpenSource={onOpenSource} />
        ))}
      </div>
      {!inputsQuery.isLoading && items.length === 0 && (
        <div className="py-8 text-center text-[11px] text-slate-400">
          No documents uploaded yet.
        </div>
      )}
      <div className="mt-4 text-center text-[10.5px] italic text-slate-400">
        Click a document to open it in the viewer. Per-node citations live in the
        Properties panel when a node is selected.
      </div>
    </div>
  );
}

function DocumentRow({
  input,
  onOpenSource,
}: {
  input: InputRow;
  onOpenSource: (target: ViewerTarget) => void;
}) {
  return (
    <button
      type="button"
      onClick={() =>
        onOpenSource({
          inputId: input.id,
          inputName: input.name,
          sectionRef: null,
          quote: null,
        })
      }
      title="Open in viewer"
      className="flex w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-left hover:border-violet-300 hover:bg-violet-50"
    >
      <FileText size={14} className="text-slate-500" />
      <span className="flex-1 truncate text-[11px] text-slate-700">
        {input.name}
      </span>
      {typeof input.claim_count === "number" && (
        <span className="text-[9.5px] tabular-nums text-slate-400">
          {input.claim_count} claim{input.claim_count === 1 ? "" : "s"}
        </span>
      )}
    </button>
  );
}
```

- [ ] **Step 4: Pass `onOpenSource` from the page**

On the `<RightPanel ... />` element in the page (around line 415), add:

```tsx
            onOpenSource={(target) => {
              setViewerTarget(target);
              setViewerExpanded(true);
            }}
```

- [ ] **Step 5: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: clean (all SP-6 wiring errors resolved).

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas/right-panel.tsx "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx"
git commit -m "feat(sp6): Sources tab opens documents in the viewer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Final verification

**Files:** none (gates only)

- [ ] **Step 1: Backend suite**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: all pass (render tests + no regressions).

- [ ] **Step 2: Frontend type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Frontend unit tests**

Run: `npx vitest run`
Expected: all pass (existing + the new `source-highlight` tests).

- [ ] **Step 4: Lint (advisory)**

Run: `npm run lint`
Expected: no NEW errors in SP-6 files (the repo ships with pre-existing lint errors in untouched files; do not introduce new ones).

- [ ] **Step 5: Live smoke (manual, document in the outcome)**

With the backend running and LibreOffice installed: upload a `.docx` and a `.pdf`, select a node with citations, click a citation card → the viewer opens at double width over the canvas, renders the original document, highlights the quote, and scrolls to it. Toggle width, close, and open a doc from the Sources tab. Note the result (pass / any gaps) in the plan's outcome section. If `ANTHROPIC_API_KEY`/citations aren't available locally, smoke the Sources-tab open path and PDF rendering directly.

---

## Self-review (author)

**Spec coverage:**
- Full original fidelity, all formats → Tasks 1-2 (convert-to-PDF) + Task 8 (one viewer). ✅
- Click source = Properties-panel citation cards → Task 9. ✅
- Convert-to-PDF + pdf.js, in-house → Tasks 2, 5, 8. ✅
- Overlay layout, doubled width, auto-open on click → Tasks 8, 10. ✅
- No migration; cache pointer in `source_info` → Task 2. ✅
- Lazy conversion on first open → Task 2 (`rendered_pdf_path` converts on demand). ✅
- Startup probe → Task 3. ✅
- Sources-tab expand/open → Task 11. ✅
- Error handling (415 → fallback; quote-not-found → cited-page notice; loading state) → Tasks 4, 8. ✅
- Testing (render service, endpoint, helpers; UI via tsc+smoke) → Tasks 1,2,4,6,12. ✅

**Deviations from the spec wording (intentional, called out):**
1. **Viewer state lives at the page level**, not "the RightPanel orchestrator." The page is the actual common parent of the Properties panel (click source), the Sources tab, and the canvas overlay. Same behavior; correct ownership.
2. **Render-failure fallback shows the cited quote** (prominently, with a notice) rather than the full `DocumentSection.text`. No endpoint serves section text today, and the quote — already in `CitationDetail` — is the provenance the user came to see. Adding a section-text endpoint would be scope the feature doesn't need (YAGNI). The feature still never hard-fails.

**Placeholder scan:** none. Every code step shows complete code.

**Type consistency:** `ViewerTarget { inputId, inputName, sectionRef, quote }` defined in Task 7 and consumed identically in Tasks 8/9/11. `onOpenSource: (target: ViewerTarget) => void` is the same signature in properties-panel, right-panel, and the page. `rendered_pdf_path`, `convert_to_pdf`, `is_native_pdf`, `needs_conversion`, `libreoffice_available`, `UnsupportedRenderFormat` are named consistently across Tasks 1-4. `api.inputPdfUrl` matches the route `GET /{input_id}/pdf` in Task 4.

---

## Execution outcome (2026-06-01)

Executed via subagent-driven development (fresh implementer per task + spec/quality review, plus a final holistic opus review across the whole branch).

**Gates (final):** backend `pytest` **110 passed**; `tsc --noEmit` **clean**; `vitest` **47 passed**; `eslint` **no new errors** (the lone `_id` warning at `page.tsx:128` is pre-existing). Live AI-citation smoke is still pending a real `ANTHROPIC_API_KEY` (the propose path needs one to mint citations); the `/pdf` endpoint, conversion/caching, Sources-tab open path, and all pure UI logic are covered by the suites.

**Deviations from the plan (all intentional, reconciled):**
- Viewer state lives at the **page level**, not the RightPanel — the page is the true common parent of the citation source, the Sources tab, and the canvas overlay (already flagged in the plan self-review).
- Render-failure fallback shows the **cited quote** with a notice rather than full `DocumentSection.text` (no section-text endpoint exists; YAGNI).

**Review findings fixed before shipping:**
- *Critical (stale canvas/overlay state):* `DocumentViewer` kept internal `error`/`numPages`/`pinned` across document switches — a prior failed load would block the next document and flash a false "couldn't pin" banner. Fixed with `key={viewerTarget.inputId}` on the overlay (forces remount → resets state; same-document re-targeting still re-scrolls via the existing `[numPages, target]` effect).
- *Important (provenance truthfulness):* `isQuoteFragment` did raw substring matching, so coincidental mid-word fragments ("in" in "within", "com" in "complete") were highlighted and could scroll to a wrong-page false positive while reporting `pinned=true`. Fixed to match on **word boundaries**, with regression tests.
- *Backend hardening:* LibreOffice conversion failures/timeouts now map to **415** (caught `subprocess.SubprocessError` → `UnsupportedRenderFormat`) instead of a bare 500; cached-PDF pointers are trusted only when the rendered file lives **beside its source** (defense-in-depth).
- *Lint:* escaped two pre-existing unescaped apostrophes in `right-panel.tsx`.

**Live-smoke fixes (found by the user running the dev server, after the holistic review):**
- *Critical (SSR 500):* the versions page is a `"use client"` component, but Next still server-renders it; statically importing `DocumentViewer` pulled `react-pdf`/`pdfjs` (browser-only globals at module eval) onto the server path and 500'd the route. Fixed by loading the viewer via `next/dynamic` with `{ ssr: false }`.
- *Feature gap (every non-PDF 415'd):* LibreOffice isn't installed in the dev WSL backend, so all non-PDF sources — including `.txt` transcripts, the common case — fell back to just the quote. Per the user's decision, added a **text fast-path**: `GET /inputs/{id}/text` (415 for non-text) + `api.getInputText` + a text render-mode in `DocumentViewer` that probes `/text` first and renders `.txt`/`.md` in a `<pre>` with reliable whitespace/quote-tolerant substring highlighting (`findQuoteInText`), no LibreOffice needed. LibreOffice remains the path for `docx`/`pptx`/`xlsx` (install it to render those). This is an intentional, reviewed deviation from the spec's "one PDF viewer" — text is its own original format and a PDF round-trip for it is wasteful and fragile.
- Post-fix gates: **pytest 114**, **tsc clean**, **vitest 53**, **lint clean** (touched files; pre-existing `_id` warning only). Focused review of both fixes: READY, no Critical/Important issues.

**Known follow-ups (deferred, non-blocking — holistic reviewer concurred):**
- The viewer renders **all pages** rather than virtualizing; large PDFs (up to the 50 MB cap) mount many canvases and can make the 300 ms scroll-to-hit timeout racy (degrades to the honest "couldn't pin" notice). Window the page list post-merge.
- Concurrent first-open of the same input can briefly serve a half-written PDF (self-heals next request); an atomic temp-file + rename would close the window.
- `textRenderer` is recreated per render (cosmetic churn in react-pdf's TextLayer); a `useCallback` keyed on `target.quote` would settle it.
- Manual live smoke with `ANTHROPIC_API_KEY` set: citation click → original-format render + highlight + scroll; width toggle; close; Sources-tab open.
