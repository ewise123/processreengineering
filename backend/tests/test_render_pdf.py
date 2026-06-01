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
        ("a.docx", None), ("a.pptx", None), ("a.xlsx", None), ("a.xlsm", None),
        ("a.txt", "text/plain"), ("a.md", "text/markdown"),
    ]:
        assert is_native_pdf(_inp(nm, mime)) is False
        assert needs_conversion(_inp(nm, mime)) is True


def test_unsupported_format_is_neither():
    inp = _inp("a.zip", "application/zip")
    assert is_native_pdf(inp) is False
    assert needs_conversion(inp) is False


# ---------------------------------------------------------------------------
# Task 2: convert + cache orchestration
# ---------------------------------------------------------------------------

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
    assert inp.source_info["rendered_pdf"]["src_mtime"] == src.stat().st_mtime


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


def test_missing_source_file_raises(db, tmp_path, monkeypatch):
    missing = tmp_path / "nope.docx"
    inp = _seed_input(db, name="nope.docx", mime=None)
    monkeypatch.setattr(render_pdf, "resolve_path", lambda rel: missing)
    with pytest.raises(FileNotFoundError):
        render_pdf.rendered_pdf_path(inp, db)


def test_convert_without_soffice_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(render_pdf, "_soffice_bin", lambda: None)
    assert render_pdf.libreoffice_available() is False
    with pytest.raises(render_pdf.UnsupportedRenderFormat):
        render_pdf.convert_to_pdf(tmp_path / "x.docx", tmp_path)


# ---------------------------------------------------------------------------
# Task 4: PDF-serving endpoint
# ---------------------------------------------------------------------------

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
