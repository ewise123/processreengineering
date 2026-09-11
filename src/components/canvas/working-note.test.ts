import { describe, expect, it } from "vitest";

import { resolveReasonPrompt } from "./working-note";

describe("resolveReasonPrompt", () => {
  describe("with no working note set", () => {
    it("prompts with an empty field for an ordinary edit", () => {
      expect(resolveReasonPrompt({ note: "", destructive: false })).toEqual({
        mode: "prompt",
        seed: "",
      });
    });

    it("prompts with an empty field for a delete", () => {
      expect(resolveReasonPrompt({ note: "", destructive: true })).toEqual({
        mode: "prompt",
        seed: "",
      });
    });

    it("treats a whitespace-only note as no note", () => {
      expect(resolveReasonPrompt({ note: "   \n ", destructive: false })).toEqual({
        mode: "prompt",
        seed: "",
      });
    });
  });

  describe("with a working note set", () => {
    const note = "Redraw O2C after Maria Chen interview 9/11";

    it("records an ordinary edit silently, using the note as the reason", () => {
      expect(resolveReasonPrompt({ note, destructive: false })).toEqual({
        mode: "auto",
        reason: note,
      });
    });

    it("still prompts for a delete, seeded with the note", () => {
      // Delete is the one edit that removes evidence, and the prompt doubles as
      // the confirm step — so the note makes it Enter-to-confirm, never silent.
      expect(resolveReasonPrompt({ note, destructive: true })).toEqual({
        mode: "prompt",
        seed: note,
      });
    });

    it("trims the note before it reaches the change log", () => {
      expect(resolveReasonPrompt({ note: `  ${note}  `, destructive: false })).toEqual({
        mode: "auto",
        reason: note,
      });
    });
  });
});
