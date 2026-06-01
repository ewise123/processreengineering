"""Tests for SP-5b decompose-to-next-level: helpers, service, endpoints."""
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v2 import process_maps as pm_api
from app.enums import ClaimLinkKind
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.process import (
    NodeClaimLink, ProcessEdge, ProcessLane, ProcessModel, ProcessNode, ProcessVersion,
)
from app.models.project import Project
from app.services import map_ai_edit


def test_next_level_increments_and_caps():
    assert pm_api._next_level("L1") == "L2"
    assert pm_api._next_level("L2") == "L3"
    assert pm_api._next_level("L3") == "L4"
    assert pm_api._next_level("L4") is None          # capped
    assert pm_api._next_level("3") == "L4"            # accepts bare digit
    assert pm_api._next_level("garbage") is None      # unparseable
