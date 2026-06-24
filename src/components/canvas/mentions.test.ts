import { describe, it, expect } from "vitest";
import { parseMentions } from "./mentions";

const N = "11111111-1111-1111-1111-111111111111";
const E = "22222222-2222-2222-2222-222222222222";

describe("parseMentions", () => {
  it("returns a single text segment when there are no mentions", () => {
    expect(parseMentions("just prose")).toEqual([{ type: "text", value: "just prose" }]);
  });

  it("splits text around a node mention", () => {
    expect(parseMentions(`See [[node:${N}]] now`)).toEqual([
      { type: "text", value: "See " },
      { type: "ref", kind: "node", id: N },
      { type: "text", value: " now" },
    ]);
  });

  it("handles edge and claim kinds and back-to-back mentions", () => {
    const out = parseMentions(`[[edge:${E}]][[claim:${N}]]`);
    expect(out).toEqual([
      { type: "ref", kind: "edge", id: E },
      { type: "ref", kind: "claim", id: N },
    ]);
  });

  it("leaves unknown kinds as literal text", () => {
    expect(parseMentions("[[bogus:x]] tail")).toEqual([
      { type: "text", value: "[[bogus:x]] tail" },
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseMentions("")).toEqual([]);
  });
});
