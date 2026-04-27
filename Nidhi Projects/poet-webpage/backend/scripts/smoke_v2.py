"""End-to-end smoke test for the v2 API using FastAPI's TestClient.

Run from backend/:
    python -m scripts.smoke_v2

Requires DB to be up (docker compose up -d) and seeded (python -m scripts.seed_dev).
"""
import io
import sys

from fastapi.testclient import TestClient

import main  # the legacy FastAPI app, now with v2 router mounted


def main_smoke() -> int:
    client = TestClient(main.app)

    # 1. Create project
    r = client.post("/api/v2/projects", json={"name": "Smoke Project", "client_name": "ACME"})
    assert r.status_code == 201, r.text
    project = r.json()
    print(f"Created project {project['id']}")

    # 2. List projects -> should include the new one
    r = client.get("/api/v2/projects")
    assert r.status_code == 200, r.text
    listing = r.json()
    assert any(p["id"] == project["id"] for p in listing["items"])
    print(f"Listed {listing['total']} project(s)")

    # 3. Upload a tiny text input
    payload = b"This is a smoke-test document.\nIt has two lines."
    r = client.post(
        f"/api/v2/projects/{project['id']}/inputs",
        data={"type": "interview_notes"},
        files={"file": ("smoke.txt", io.BytesIO(payload), "text/plain")},
    )
    assert r.status_code == 201, r.text
    inp = r.json()
    print(f"Uploaded input {inp['id']} ({inp['file_size']} bytes, mime={inp['mime_type']})")

    # 4. Parse it
    r = client.post(f"/api/v2/projects/{project['id']}/inputs/{inp['id']}/parse")
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["status"] == "parsed"
    assert result["section_count"] >= 1
    assert result["chunk_count"] >= 1
    print(
        f"Parsed: {result['section_count']} section(s), {result['chunk_count']} chunk(s)"
    )

    # 5. Confirm input status is now 'parsed'
    r = client.get(f"/api/v2/projects/{project['id']}/inputs")
    assert r.status_code == 200, r.text
    after = r.json()
    matching = [i for i in after["items"] if i["id"] == inp["id"]]
    assert matching and matching[0]["status"] == "parsed"

    # 6. Soft-delete project (cleans up the smoke data)
    r = client.delete(f"/api/v2/projects/{project['id']}")
    assert r.status_code == 204, r.text
    print("Soft-deleted project. Smoke test passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main_smoke())
