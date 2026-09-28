import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "./uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUUID", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses crypto.randomUUID when the browser provides it", () => {
    expect(randomUUID()).toMatch(V4);
  });

  it("still returns a v4 UUID when crypto.randomUUID is missing (plain-HTTP LAN IP)", () => {
    const { getRandomValues } = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: getRandomValues.bind(globalThis.crypto),
    });
    const ids = new Set(Array.from({ length: 50 }, () => randomUUID()));
    for (const id of ids) expect(id).toMatch(V4);
    expect(ids.size).toBe(50);
  });
});
