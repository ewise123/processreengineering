import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text as sa_text

from app.factory import create_app
from app.db.session import get_db
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.input import Chunk, DocumentSection, Input
from app.models.process import (
    NodeClaimLink,
    ProcessLane,
    ProcessModel,
    ProcessNode,
    ProcessVersion,
)
from app.models.project import Project


def test_claim_source_and_detection_reason_columns_exist(test_engine):
    with test_engine.connect() as conn:
        claim_cols = {
            r[0]
            for r in conn.execute(
                sa_text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name='claims' AND column_name='source'"
                )
            ).fetchall()
        }
        conflict_cols = {
            r[0]
            for r in conn.execute(
                sa_text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name='claim_conflicts' "
                    "AND column_name='detection_reason'"
                )
            ).fetchall()
        }
    assert claim_cols == {"source"}
    assert conflict_cols == {"detection_reason"}


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _seed_project(db) -> Project:
    org = Organization(name="t")
    db.add(org)
    db.flush()
    db.add(User(email="dev@local", name="dev", org_id=org.id))
    db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj)
    db.commit()
    return proj


def test_create_manual_claim(client, db):
    proj = _seed_project(db)
    resp = client.post(
        f"/api/v2/projects/{proj.id}/claims",
        json={"kind": "task", "subject": "Approve the invoice"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["kind"] == "task"
    assert body["subject"] == "Approve the invoice"
    assert body["source"] == "manual"
    assert body["normalized"] == {}
    db.expire_all()
    claim = db.get(Claim, body["id"])
    assert claim is not None and claim.source == "manual"


def test_create_claim_rejects_bad_kind(client, db):
    proj = _seed_project(db)
    resp = client.post(
        f"/api/v2/projects/{proj.id}/claims",
        json={"kind": "not_a_kind", "subject": "x"},
    )
    assert resp.status_code == 422, resp.text


def _seed_claim(db, proj, *, kind="task", subject="s", source="manual") -> Claim:
    claim = Claim(
        project_id=proj.id, kind=kind, subject=subject, normalized={},
        confidence=None, source=source,
    )
    db.add(claim)
    db.commit()
    return claim


def test_patch_claim_edits_fields(client, db):
    proj = _seed_project(db)
    claim = _seed_claim(db, proj, kind="task", subject="old")
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/claims/{claim.id}",
        json={"kind": "decision", "subject": "new"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["kind"] == "decision"
    assert resp.json()["subject"] == "new"
    db.expire_all()
    fresh = db.get(Claim, claim.id)
    assert fresh.kind == "decision" and fresh.subject == "new"


def test_patch_claim_cross_project_404(client, db):
    proj = _seed_project(db)
    claim = _seed_claim(db, proj)
    other = Project(name="other", org_id=proj.org_id, status="active")
    db.add(other)
    db.commit()
    resp = client.patch(
        f"/api/v2/projects/{other.id}/claims/{claim.id}",
        json={"subject": "x"},
    )
    assert resp.status_code == 404, resp.text


def _seed_node_citing_claim(db, proj, claim) -> tuple[ProcessModel, ProcessNode]:
    model = ProcessModel(project_id=proj.id, name="AP Map", level="L2")
    db.add(model)
    db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1, status="draft")
    db.add(version)
    db.flush()
    lane = ProcessLane(version_id=version.id, name="Lane", order_index=0, height_px=150)
    db.add(lane)
    db.flush()
    node = ProcessNode(
        version_id=version.id, lane_id=lane.id, type="task", name="Do it",
        position={}, properties={},
    )
    db.add(node)
    db.flush()
    db.add(NodeClaimLink(node_id=node.id, claim_id=claim.id))
    db.commit()
    return model, node


def test_claim_impact_lists_affected_maps(client, db):
    proj = _seed_project(db)
    claim = _seed_claim(db, proj)
    model, _node = _seed_node_citing_claim(db, proj, claim)
    resp = client.get(
        f"/api/v2/projects/{proj.id}/claims/{claim.id}/impact"
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["claim_id"] == str(claim.id)
    assert body["node_link_count"] == 1
    assert body["maps"] == [{"model_id": str(model.id), "name": "AP Map"}]


def test_delete_claim_cascades_links(client, db):
    proj = _seed_project(db)
    claim = _seed_claim(db, proj)
    _model, node = _seed_node_citing_claim(db, proj, claim)
    resp = client.delete(f"/api/v2/projects/{proj.id}/claims/{claim.id}")
    assert resp.status_code == 204, resp.text
    db.expire_all()
    assert db.get(Claim, claim.id) is None
    remaining = (
        db.query(NodeClaimLink).filter(NodeClaimLink.node_id == node.id).count()
    )
    assert remaining == 0  # FK cascade dropped the link


from app.api.v2.claims import extract_input_claims, run_conflict_detection
from app.models.claim import ClaimCitation, ClaimConflict


def _seed_input_with_chunk(db, proj) -> tuple[Input, Chunk]:
    user = db.query(User).filter(User.email == "dev@local").first()
    inp = Input(
        project_id=proj.id, type="interview_transcript", name="i.txt",
        file_path="i.txt", file_size=10, mime_type="text/plain",
        status="parsed", uploaded_by=user.id,
    )
    db.add(inp)
    db.flush()
    sec = DocumentSection(input_id=inp.id, kind="page", order_index=0, ref={}, text="x")
    db.add(sec)
    db.flush()
    ch = Chunk(section_id=sec.id, char_start=0, char_end=5, text="a", tokens=1)
    db.add(ch)
    db.commit()
    return inp, ch


def test_extraction_wipe_keeps_manual_claims(client, db, monkeypatch):
    """A manual claim that happens to be cited on a chunk of the re-extracted
    input must survive; only extracted claims for that input are wiped."""
    import app.api.v2.claims as claims_mod

    proj = _seed_project(db)
    inp, ch = _seed_input_with_chunk(db, proj)

    extracted = _seed_claim(db, proj, subject="extracted one", source="extracted")
    manual = _seed_claim(db, proj, subject="manual one", source="manual")
    db.add(ClaimCitation(claim_id=extracted.id, chunk_id=ch.id, quote="a"))
    db.add(ClaimCitation(claim_id=manual.id, chunk_id=ch.id, quote="a"))
    db.commit()

    # Stub the LLM extractor so re-extraction adds nothing new.
    monkeypatch.setattr(claims_mod, "extract_claims_from_text", lambda text: [])

    resp = client.post(
        f"/api/v2/projects/{proj.id}/inputs/{inp.id}/extract-claims"
    )
    assert resp.status_code == 200, resp.text
    db.expire_all()
    assert db.get(Claim, extracted.id) is None  # extracted wiped
    assert db.get(Claim, manual.id) is not None  # manual preserved


def test_conflict_detection_writes_detection_reason_not_notes(client, db, monkeypatch):
    import app.api.v2.claims as claims_mod
    from app.services.conflict_detection import DetectedConflict

    proj = _seed_project(db)
    a = _seed_claim(db, proj, kind="threshold", subject="limit is 500")
    b = _seed_claim(db, proj, kind="threshold", subject="limit is 1000")
    monkeypatch.setattr(
        claims_mod,
        "detect_conflicts",
        lambda summaries: [
            DetectedConflict(
                claim_a_index=0,
                claim_b_index=1,
                kind="threshold_mismatch",
                reason="500 vs 1000",
            )
        ],
    )
    resp = client.post(f"/api/v2/projects/{proj.id}/detect-conflicts")
    assert resp.status_code == 200, resp.text
    db.expire_all()
    conflict = db.query(ClaimConflict).one()
    assert conflict.detection_reason == "500 vs 1000"
    assert conflict.resolution_notes is None  # user notes column stays free
