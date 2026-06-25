"""Schemas for SP-7c map reconcile.

The reconcile endpoint persists one ``process_suggestions`` row per op (shared
``batch_id``, ``kind='map_reconcile'``, ``version_id`` set) and returns the
pending batch. Op payloads carry **resolved UUIDs** (the endpoint has already
mapped the model's short refs to real ids and dropped fabrications).
"""
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, Field


class ReconcileOp(StrEnum):
    ADD_STEP = "add_step"
    RECITE_NODE = "recite_node"
    FLAG_STALE_NODE = "flag_stale_node"
    RELABEL_NODE = "relabel_node"


class ReconcileRequest(BaseModel):
    """No body fields today; reserved so the route can accept an empty POST."""


class ReconcileSuggestionRead(BaseModel):
    id: UUID
    batch_id: UUID
    op: ReconcileOp
    payload: dict
    rationale: str = ""
    confidence: float | None = None
    status: str = "pending"


class ReconcileBatchRead(BaseModel):
    """The reconcile result. ``empty`` is True when the delta was empty and no
    LLM call was made (the batch has no suggestions)."""

    batch_id: UUID | None
    version_id: UUID
    empty: bool
    suggestions: list[ReconcileSuggestionRead] = Field(default_factory=list)
