from dataclasses import dataclass
from typing import Iterable
from uuid import UUID

from app.models.input import DocumentSection

CHUNK_SIZE = 1000
CHUNK_OVERLAP = 100


@dataclass
class ChunkSpec:
    section_id: UUID
    char_start: int
    char_end: int
    text: str
    tokens: int | None = None


def chunk_sections(sections: Iterable[DocumentSection]) -> list[ChunkSpec]:
    chunks: list[ChunkSpec] = []
    for section in sections:
        text = section.text or ""
        n = len(text)
        if n == 0:
            continue
        if n <= CHUNK_SIZE:
            chunks.append(
                ChunkSpec(
                    section_id=section.id, char_start=0, char_end=n, text=text
                )
            )
            continue
        start = 0
        while start < n:
            end = min(start + CHUNK_SIZE, n)
            chunks.append(
                ChunkSpec(
                    section_id=section.id,
                    char_start=start,
                    char_end=end,
                    text=text[start:end],
                )
            )
            if end >= n:
                break
            start = end - CHUNK_OVERLAP
    return chunks
