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
