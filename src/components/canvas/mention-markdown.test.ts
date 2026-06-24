import { describe, it, expect } from "vitest";
import { mentionsToMarkdown } from "./mention-markdown";

const N = "11111111-1111-1111-1111-111111111111";
const C = "33333333-3333-3333-3333-333333333333";

describe("mentionsToMarkdown", () => {
  const labels = new Map([[N, "Review Invoice"]]);
  const sources = new Map([[C, "SOP.pdf"]]);

  it("passes through plain markdown untouched", () => {
    expect(mentionsToMarkdown("**bold** and a list", labels, sources)).toBe("**bold** and a list");
  });
  it("turns a node mention into a poet node link with its label", () => {
    expect(mentionsToMarkdown(`See [[node:${N}]].`, labels, sources)).toBe(
      `See [Review Invoice](poet://node/${N}).`
    );
  });
  it("turns a claim mention into a poet claim link with the doc name", () => {
    expect(mentionsToMarkdown(`per [[claim:${C}]]`, labels, sources)).toBe(
      `per [SOP.pdf](poet://claim/${C})`
    );
  });
  it("falls back to 'step'/'source' when not found", () => {
    expect(mentionsToMarkdown(`[[node:x]] [[claim:y]]`, labels, sources)).toBe(
      `[step](poet://node/x) [source](poet://claim/y)`
    );
  });
  it("renders any stray edge mention as plain endpoint-less text (edges dropped)", () => {
    expect(mentionsToMarkdown(`[[edge:z]] gone`, labels, sources)).toBe("gone");
  });
  it("escapes ] in a label so the link stays valid", () => {
    const l = new Map([[N, "Step [final]"]]);
    expect(mentionsToMarkdown(`[[node:${N}]]`, l, sources)).toBe(
      `[Step [final\\]](poet://node/${N})`
    );
  });
});
