import { describe, it, expect } from "vitest";
import { dedupeSourcesByDocument, mentionsToMarkdown } from "./mention-markdown";
import type { MentionSource } from "@/lib/types";

const N = "11111111-1111-1111-1111-111111111111";
const C = "33333333-3333-3333-3333-333333333333";
const C2 = "33333333-3333-3333-3333-333333333334";
const C3 = "33333333-3333-3333-3333-333333333335";
const D = "22222222-2222-2222-2222-222222222222";
const D2 = "22222222-2222-2222-2222-222222222223";
const L = "44444444-4444-4444-4444-444444444444";

const source = (overrides: Partial<MentionSource> = {}): MentionSource => ({
  claim_id: C,
  input_id: D,
  input_name: "interview.txt",
  section_ref: null,
  quote: null,
  ...overrides,
});

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
  it("renders a new-object mention as a poet://new link with its planned name", () => {
    const newNames = new Map([["tmp:1", "Approve invoice"]]);
    expect(mentionsToMarkdown(`then [[new:tmp:1]]`, labels, sources, lanes, newNames)).toBe(
      `then [Approve invoice](poet://new/tmp:1)`
    );
    // Falls back to a generic label when the tmp ref isn't in the map.
    expect(mentionsToMarkdown(`[[new:tmp:9]]`, labels, sources, lanes)).toBe(
      `[new step](poet://new/tmp:9)`
    );
  });
  it("escapes both [ and ] in a label so the link stays valid", () => {
    const l = new Map([[N, "Step [final]"]]);
    expect(mentionsToMarkdown(`[[node:${N}]]`, l, sources)).toBe(
      `[Step \\[final\\]](poet://node/${N})`
    );
  });

  describe("claim mention dedupe (repeated same-source citations, scoped per call)", () => {
    const sourceNames = new Map([
      [C, "interview.txt"],
      [C2, "interview.txt"],
      [C3, "onboarding.pdf"],
    ]);

    it("drops repeat claim mentions of an already-shown document within the same text", () => {
      const cited = [source({ claim_id: C, input_id: D }), source({ claim_id: C2, input_id: D })];
      expect(
        mentionsToMarkdown(
          `First [[claim:${C}]] and again [[claim:${C2}]].`,
          labels,
          sourceNames,
          undefined,
          undefined,
          cited
        )
      ).toBe(`First [interview.txt](poet://claim/${C}) and again .`);
    });

    it("keeps one chip per distinct document, dropping only true repeats", () => {
      const cited = [
        source({ claim_id: C, input_id: D }),
        source({ claim_id: C3, input_id: D2, input_name: "onboarding.pdf" }),
        source({ claim_id: C2, input_id: D }),
      ];
      expect(
        mentionsToMarkdown(
          `[[claim:${C}]] then [[claim:${C3}]] then [[claim:${C2}]]`,
          labels,
          sourceNames,
          undefined,
          undefined,
          cited
        )
      ).toBe(
        `[interview.txt](poet://claim/${C}) then [onboarding.pdf](poet://claim/${C3}) then `
      );
    });

    it("collapses the comma run left when a same-source citation list is deduped", () => {
      const cited = [source({ claim_id: C, input_id: D }), source({ claim_id: C2, input_id: D })];
      const out = mentionsToMarkdown(
        `[[claim:${C}]], [[claim:${C2}]], [[claim:${C}]], and all state that X.`,
        labels,
        sourceNames,
        undefined,
        undefined,
        cited
      );
      // No ", ," artifact from the dropped duplicates, and one clean chip remains.
      expect(out).not.toMatch(/,\s*,/);
      expect(out).toBe(`[interview.txt](poet://claim/${C}), and all state that X.`);
    });

    it("leaves claim mentions untouched when no sources list is passed (back-compat)", () => {
      expect(mentionsToMarkdown(`[[claim:${C}]] [[claim:${C2}]]`, labels, sourceNames)).toBe(
        `[interview.txt](poet://claim/${C}) [interview.txt](poet://claim/${C2})`
      );
    });

    it("REGRESSION: a second call with the SAME sources array still renders its own first mention (dedupe does not leak across calls)", () => {
      // Simulates two separate renders sharing one message's full sources list:
      // e.g. one suggestion card citing claim A, another card citing claim B —
      // both claims from the same document X. Each card is its own call.
      const cited = [source({ claim_id: C, input_id: D }), source({ claim_id: C2, input_id: D })];

      const firstCall = mentionsToMarkdown(
        `Card one cites [[claim:${C}]].`,
        labels,
        sourceNames,
        undefined,
        undefined,
        cited
      );
      expect(firstCall).toBe(`Card one cites [interview.txt](poet://claim/${C}).`);

      // Second call, same `sources` array, different text citing claim B (same
      // doc X). Under the old whole-message-derived dedupe this would have
      // been dropped because doc X was already "seen" globally; the fix scopes
      // the seen-set to this call only, so it must still render.
      const secondCall = mentionsToMarkdown(
        `Card two cites [[claim:${C2}]].`,
        labels,
        sourceNames,
        undefined,
        undefined,
        cited
      );
      expect(secondCall).toBe(`Card two cites [interview.txt](poet://claim/${C2}).`);
    });

    it("renders both mentions when they cite distinct documents in one text", () => {
      const cited = [
        source({ claim_id: C, input_id: D, input_name: "interview.txt" }),
        source({ claim_id: C3, input_id: D2, input_name: "onboarding.pdf" }),
      ];
      expect(
        mentionsToMarkdown(
          `[[claim:${C}]] and [[claim:${C3}]]`,
          labels,
          sourceNames,
          undefined,
          undefined,
          cited
        )
      ).toBe(`[interview.txt](poet://claim/${C}) and [onboarding.pdf](poet://claim/${C3})`);
    });
  });
});

describe("dedupeSourcesByDocument", () => {
  it("keeps only the first citation per distinct document (by input_id)", () => {
    const sources = [
      source({ claim_id: C, input_id: D }),
      source({ claim_id: C2, input_id: D }),
    ];
    expect(dedupeSourcesByDocument(sources)).toEqual([source({ claim_id: C, input_id: D })]);
  });

  it("keeps one entry per distinct document, preserving first-seen order", () => {
    const sources = [
      source({ claim_id: C, input_id: D, input_name: "interview.txt" }),
      source({ claim_id: C3, input_id: D2, input_name: "onboarding.pdf" }),
      source({ claim_id: C2, input_id: D, input_name: "interview.txt" }),
    ];
    expect(dedupeSourcesByDocument(sources)).toEqual([
      source({ claim_id: C, input_id: D, input_name: "interview.txt" }),
      source({ claim_id: C3, input_id: D2, input_name: "onboarding.pdf" }),
    ]);
  });

  it("falls back to input_name when input_id is missing", () => {
    const sources = [
      source({ claim_id: C, input_id: "", input_name: "interview.txt" }),
      source({ claim_id: C2, input_id: "", input_name: "interview.txt" }),
    ];
    expect(dedupeSourcesByDocument(sources)).toEqual([
      source({ claim_id: C, input_id: "", input_name: "interview.txt" }),
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(dedupeSourcesByDocument([])).toEqual([]);
  });
});
