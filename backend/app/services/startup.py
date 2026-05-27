"""One-shot tasks that run on FastAPI startup."""
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.enums import InputStatus
from app.models.input import Input


def sweep_stale_extracting_inputs(db: Session) -> int:
    """Flip any rows left in `extracting` to `failed`.

    Called at app startup. Any row in `extracting` at startup is the result
    of a previous process getting killed mid-extraction (uvicorn --reload,
    OS signal, crash). Its work was partially committed thanks to per-chunk
    commits, but the row is no longer being driven forward — convert it to
    a terminal failure so the next click on Re-extract restarts cleanly.

    Returns the number of rows updated.
    """
    result = db.execute(
        update(Input)
        .where(Input.status == InputStatus.EXTRACTING.value)
        .values(
            status=InputStatus.FAILED.value,
            extraction_error="Interrupted by backend restart",
        )
    )
    db.commit()
    return result.rowcount or 0
