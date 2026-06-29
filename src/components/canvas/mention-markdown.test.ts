import { describe, it, expect } from "vitest";
import { mentionsToMarkdown } from "./mention-markdown";

const N = "11111111-1111-1111-1111-111111111111";
const C = "33333333-3333-3333-3333-333333333333";
const L = "44444444-4444-4444-4444-444444444444";

describe("mentionsToMarkdown", () => {
  const labels = new Map([[N, "Review Invoice"]]);
  const sources = new Map([[C, "SOP.pdf"]]);
  const lanes = new Map([[L, "Procurement Manager"]]);

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
  it("renders an edge mention as a clickable 'connection' link (no name)", () => {
    expect(mentionsToMarkdown(`[[edge:z]] here`, labels, sources)).toBe(
      `[connection](poet://edge/z) here`
    );
  });
  it("renders a lane mention with its name, falling back to 'lane'", () => {
    expect(mentionsToMarkdown(`to [[lane:${L}]]`, labels, sources, lanes)).toBe(
      `to [Procurement Manager](poet://lane/${L})`
    );
    expect(mentionsToMarkdown(`to [[lane:other]]`, labels, sources, lanes)).toBe(
      `to [lane](poet://lane/other)`
    );
  });
  it("escapes both [ and ] in a label so the link stays valid", () => {
    const l = new Map([[N, "Step [final]"]]);
    expect(mentionsToMarkdown(`[[node:${N}]]`, l, sources)).toBe(
      `[Step \\[final\\]](poet://node/${N})`
    );
  });
});
