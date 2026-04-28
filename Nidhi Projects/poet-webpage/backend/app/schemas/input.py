from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class InputRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    project_id: UUID
    type: str
    name: str
    file_path: str | None
    file_size: int | None
    mime_type: str | None
    status: str
    created_at: datetime
    updated_at: datetime
    claim_count: int = 0


class InputParseResult(BaseModel):
    input_id: UUID
    section_count: int
    chunk_count: int
    status: str
