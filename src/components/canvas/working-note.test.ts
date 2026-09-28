import { describe, expect, it } from "vitest";

import { makeWorkingNoteStore, resolveReasonPrompt } from "./working-note";

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

describe("makeWorkingNoteStore", () => {
  function fakeStorage(seed: Record<string, string> = {}) {
    const data = { ...seed };
    return {
      data,
      getItem: (k: string) => (k in data ? data[k] : null),
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
      removeItem: (k: string) => {
        delete data[k];
      },
    };
  }

  const V1 = "01a09136-0000-0000-0000-000000000001";
  const V2 = "01a09136-0000-0000-0000-000000000002";

  it("returns an empty note when nothing has been stored", () => {
    expect(makeWorkingNoteStore(fakeStorage()).load(V1)).toBe("");
  });

  it("round-trips a note", () => {
    const store = makeWorkingNoteStore(fakeStorage());
    store.save(V1, "Redraw O2C after the Maria Chen interview");
    expect(store.load(V1)).toBe("Redraw O2C after the Maria Chen interview");
  });

  it("keeps each map version's note separate", () => {
    // Two maps open in one session must not stamp each other's reasons.
    const store = makeWorkingNoteStore(fakeStorage());
    store.save(V1, "Redrawing order-to-cash");
    expect(store.load(V2)).toBe("");
  });

  it("forgets the note when it is cleared", () => {
    const storage = fakeStorage();
    const store = makeWorkingNoteStore(storage);
    store.save(V1, "Redrawing order-to-cash");
    store.save(V1, "");
    expect(store.load(V1)).toBe("");
    expect(Object.keys(storage.data)).toHaveLength(0);
  });

  it("survives storage being unavailable rather than crashing the canvas", () => {
    // Private browsing and blocked site data make these throw. Losing the note
    // is a nuisance; taking the canvas down with it is not acceptable.
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const store = makeWorkingNoteStore(throwing);
    expect(store.load(V1)).toBe("");
    expect(() => store.save(V1, "anything")).not.toThrow();
  });
});
