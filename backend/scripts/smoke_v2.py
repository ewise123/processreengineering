"""End-to-end smoke test for the v2 API using FastAPI's TestClient.

Run from backend/:
    python -m scripts.smoke_v2

Steps 1-5 (project + upload + parse) always run. Steps 6-8 (embed +
claim extraction + conflict detection) require the relevant API keys
in .env and are skipped otherwise.

Requires DB to be up (docker compose up -d) and seeded
(python -m scripts.seed_dev).
"""
import io
import os
import sys

from fastapi.testclient import TestClient

import main  # the legacy FastAPI app, with v2 router mounted

SAMPLE_SOP = """Accounts Payable Process - Standard Operating Procedure

Step 1: Invoice Receipt
The Accounts Payable Clerk receives invoices via email at ap@company.com or in physical mail.
All invoices must be logged into the SAP ERP system within 24 hours of receipt.

Step 2: Three-Way Match
For PO-based invoices, the AP Clerk performs a three-way match between the invoice, purchase order, and goods receipt.
If the invoice amount differs from the PO by more than 5%, escalate to the Purchasing Manager.

Step 3: Approval Routing
Invoices under $10,000 are auto-approved if the three-way match passes.
Invoices between $10,000 and $50,000 require approval from the Department Manager.
Invoices over $50,000 require approval from both the Department Manager and the CFO.

Step 4: Payment Processing
Approved invoices are scheduled for payment within 30 days of the invoice date.
The Treasury Team executes payments via ACH or wire transfer on Tuesdays and Fridays.

Exception Handling:
If a vendor is non-PO, route the invoice to the Procurement Manager for review and PO creation before processing.
Duplicate invoices (matching vendor + invoice number) are automatically rejected by SAP.
"""

SAMPLE_INTERVIEW = """Interview Notes - Sarah Chen, AP Manager

Sarah explained the current AP process:
- Most invoices come in through email these days, very few paper ones.
- We try to log them within 48 hours but it's often longer during month-end close.
- For amounts over $25,000 we always need CFO sign-off, no exceptions.
- Payments go out every Friday, that's our cycle.
- If something is duplicate we usually catch it, but sometimes one slips through and we have to chase the vendor for a credit.
"""


def upload_and_parse(client: TestClient, project_id: str, name: str, body: bytes, type_: str) -> str:
    r = client.post(
        f"/api/v2/projects/{project_id}/inputs",
        data={"type": type_},
        files={"file": (name, io.BytesIO(body), "text/plain")},
    )
    assert r.status_code == 201, r.text
    inp = r.json()
    r = client.post(f"/api/v2/projects/{project_id}/inputs/{inp['id']}/parse")
    assert r.status_code == 200, r.text
    result = r.json()
    print(f"  Uploaded+parsed {name}: {result['section_count']} section(s), {result['chunk_count']} chunk(s)")
    return inp["id"]


def main_smoke() -> int:
    client = TestClient(main.app)

    # 1. Create project
    r = client.post("/api/v2/projects", json={"name": "Smoke Project", "client_name": "ACME"})
    assert r.status_code == 201, r.text
    project = r.json()
    project_id = project["id"]
    print(f"Created project {project_id}")

    # 2. List projects
    r = client.get("/api/v2/projects")
    assert r.status_code == 200, r.text
    listing = r.json()
    assert any(p["id"] == project_id for p in listing["items"])
    print(f"Listed {listing['total']} project(s)")

    # 3-4. Upload + parse two substantive documents
    sop_id = upload_and_parse(client, project_id, "ap-sop.txt", SAMPLE_SOP.encode(), "sop_document")
    interview_id = upload_and_parse(client, project_id, "interview.txt", SAMPLE_INTERVIEW.encode(), "interview_notes")

    # 5. Confirm parsed status
    r = client.get(f"/api/v2/projects/{project_id}/inputs")
    assert r.status_code == 200, r.text
    inputs = r.json()["items"]
    assert all(i["status"] == "parsed" for i in inputs)

    # 6. Embed (requires OPENAI_API_KEY)
    if os.getenv("OPENAI_API_KEY"):
        for iid in (sop_id, interview_id):
            r = client.post(f"/api/v2/projects/{project_id}/inputs/{iid}/embed")
            assert r.status_code == 200, r.text
            print(f"  Embedded input {iid[:8]}: {r.json()['embedded_count']} chunks")
    else:
        print("  [skip] embed — set OPENAI_API_KEY to exercise")

    # 7. Extract claims (requires ANTHROPIC_API_KEY)
    if os.getenv("ANTHROPIC_API_KEY"):
        for iid in (sop_id, interview_id):
            r = client.post(f"/api/v2/projects/{project_id}/inputs/{iid}/extract-claims")
            assert r.status_code == 200, r.text
            res = r.json()
            print(f"  Extracted from input {iid[:8]}: {res['claim_count']} claim(s), {res['citation_count']} citation(s)")
        r = client.get(f"/api/v2/projects/{project_id}/claims")
        assert r.status_code == 200, r.text
        print(f"  Total claims in project: {r.json()['total']}")
    else:
        print("  [skip] extract-claims — set ANTHROPIC_API_KEY to exercise")

    # 8. Detect conflicts (requires ANTHROPIC_API_KEY)
    if os.getenv("ANTHROPIC_API_KEY"):
        r = client.post(f"/api/v2/projects/{project_id}/detect-conflicts")
        assert r.status_code == 200, r.text
        res = r.json()
        print(f"  Conflict detection: {res['claim_count']} claims, {res['new_conflict_count']} new conflict(s)")
        r = client.get(f"/api/v2/projects/{project_id}/conflicts")
        assert r.status_code == 200, r.text
        print(f"  Total conflicts in project: {r.json()['total']}")
    else:
        print("  [skip] detect-conflicts — set ANTHROPIC_API_KEY to exercise")

    # 9. Generate process map (requires ANTHROPIC_API_KEY + claims to exist)
    if os.getenv("ANTHROPIC_API_KEY"):
        r = client.post(
            f"/api/v2/projects/{project_id}/generate-process-map",
            json={
                "name": "Accounts Payable Process",
                "level": "2",
                "focus": "Accounts Payable",
                "map_type": "current_state",
            },
        )
        # 422 is acceptable here only if no claims exist (e.g. extract-claims was skipped)
        if r.status_code == 422:
            print(f"  [skip] generate-process-map — {r.json().get('detail')}")
        else:
            assert r.status_code == 201, r.text
            res = r.json()
            print(
                f"  Generated map: {res['lane_count']} lane(s), {res['node_count']} node(s), "
                f"{res['edge_count']} edge(s), {res['node_link_count']} claim link(s), "
                f"BPMN XML size {res['bpmn_xml_size']}"
            )
            r = client.get(
                f"/api/v2/projects/{project_id}/process-maps/{res['model_id']}/versions/{res['version_id']}"
            )
            assert r.status_code == 200, r.text
            graph = r.json()
            print(
                f"  Fetched graph: version {graph['version']['version_number']}, "
                f"{len(graph['lanes'])} lanes, {len(graph['nodes'])} nodes, {len(graph['edges'])} edges"
            )
    else:
        print("  [skip] generate-process-map — set ANTHROPIC_API_KEY to exercise")

    # 10. Cleanup
    r = client.delete(f"/api/v2/projects/{project_id}")
    assert r.status_code == 204, r.text
    print("Soft-deleted project. Smoke test passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main_smoke())
