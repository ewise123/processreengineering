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
