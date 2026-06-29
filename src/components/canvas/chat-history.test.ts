import { describe, it, expect } from "vitest";
import { toRequestHistory, EMPTY_TURN_PLACEHOLDER, MAX_HISTORY_TURNS } from "./chat-history";

describe("toRequestHistory", () => {
  it("keeps only role + content (drops client-only fields)", () => {
    const items = [
      { role: "user" as const, content: "hi", contextNote: "Node A", sources: [] },
    ];
    expect(toRequestHistory(items as never)).toEqual([{ role: "user", content: "hi" }]);
  });

  it("coerces empty assistant content to the placeholder (the 422 cause)", () => {
    expect(toRequestHistory([{ role: "assistant", content: "" }])).toEqual([
      { role: "assistant", content: EMPTY_TURN_PLACEHOLDER },
    ]);
  });

  it("coerces whitespace-only content too", () => {
    expect(toRequestHistory([{ role: "assistant", content: "  \n\t" }])).toEqual([
      { role: "assistant", content: EMPTY_TURN_PLACEHOLDER },
    ]);
  });

  it("preserves non-empty content unchanged", () => {
    const items = [
      { role: "user" as const, content: "a question" },
      { role: "assistant" as const, content: "an answer" },
    ];
    expect(toRequestHistory(items)).toEqual(items);
  });

  it("keeps only the most recent MAX_HISTORY_TURNS turns (the server caps history)", () => {
    const items = Array.from({ length: MAX_HISTORY_TURNS + 2 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `m${i}`,
    }));
    const out = toRequestHistory(items);
    expect(out).toHaveLength(MAX_HISTORY_TURNS);
    expect(out[0].content).toBe("m2"); // first two (oldest) dropped
    expect(out[out.length - 1].content).toBe(`m${MAX_HISTORY_TURNS + 1}`); // newest kept
  });

  it("handles a mixed thread, fixing only the empty turn", () => {
    const items = [
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "" },
      { role: "user" as const, content: "second" },
    ];
    expect(toRequestHistory(items)).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: EMPTY_TURN_PLACEHOLDER },
      { role: "user", content: "second" },
    ]);
  });
});
