import shutil
import subprocess
import uuid
from pathlib import Path

from sqlalchemy.orm import Session

from app.models.input import Input
from app.services.storage import resolve_path  # re-exported so tests can monkeypatch

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
