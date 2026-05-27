import mimetypes
import re
from pathlib import Path
from uuid import UUID

import uuid_utils

# backend/app/services/storage.py -> backend/uploads/
BACKEND_ROOT = Path(__file__).resolve().parents[2]
UPLOAD_ROOT = BACKEND_ROOT / "uploads"

_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]")


def _safe_filename(name: str) -> str:
    base = Path(name).name
    cleaned = _FILENAME_RE.sub("_", base)[:200]
    return cleaned or "file"


def save_upload(project_id: UUID, filename: str, body: bytes) -> tuple[Path, str | None]:
    """Save uploaded bytes to uploads/<project_id>/<uuid>_<safe_name>.

    Returns (relative_path_from_backend_root, mime_type).
    """
    project_dir = UPLOAD_ROOT / str(project_id)
    project_dir.mkdir(parents=True, exist_ok=True)
    safe = _safe_filename(filename)
    unique = str(uuid_utils.uuid7())
    full = project_dir / f"{unique}_{safe}"
    full.write_bytes(body)
    rel = full.relative_to(BACKEND_ROOT)
    mime, _ = mimetypes.guess_type(str(full))
    return rel, mime


def resolve_path(rel_path: str) -> Path:
    """Resolve a stored relative path back to its absolute file location."""
    full = (BACKEND_ROOT / rel_path).resolve()
    full.relative_to(BACKEND_ROOT)  # raise if outside backend dir
    return full
