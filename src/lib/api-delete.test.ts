import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "./api";

const PROJECT = "11111111-1111-1111-1111-111111111111";
const TARGET = "22222222-2222-2222-2222-222222222222";

describe("delete requests carry the reason in a JSON body", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the reason when deleting a node", async () => {
    await api.deleteNode(PROJECT, TARGET, { reason: "Duplicate step" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`/nodes/${TARGET}`);
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ reason: "Duplicate step" });
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("sends the reason when deleting an edge", async () => {
    await api.deleteEdge(PROJECT, TARGET, { reason: "Path retired" });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ reason: "Path retired" });
  });

  it("sends the lane reason in the body, not as a query param", async () => {
    await api.deleteLane(PROJECT, TARGET, { reason: "Merged", ai_applied: true });
    const [url, init] = fetchMock.mock.calls[0];
    // The retired ?ai_applied=true query param must be gone.
    expect(url).not.toContain("ai_applied");
    expect(JSON.parse(init.body as string)).toEqual({ reason: "Merged", ai_applied: true });
  });
});
