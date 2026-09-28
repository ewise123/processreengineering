import { describe, expect, it } from "vitest";
import {
  editDistance,
  FRESH_MS,
  freshReason,
  isSpellingFix,
  pickAutoReason,
  SPELLING_REASON,
} from "./auto-reason";

describe("isSpellingFix", () => {
  it("accepts a letter or two changed, swapped or dropped", () => {
    expect(isSpellingFix("Reveiw", "Review")).toBe(true); // swap
    expect(isSpellingFix("Aprove invoice", "Approve invoice")).toBe(true); // missing letter
    expect(isSpellingFix("Recieve PO", "Receive PO")).toBe(true);
    expect(isSpellingFix("review", "Review")).toBe(true); // capital
  });

  it("rejects real renames", () => {
    expect(isSpellingFix("Review", "Approve")).toBe(false);
    expect(isSpellingFix("Check PO", "Check PO line")).toBe(false); // added a word
    expect(isSpellingFix("Pay vendor", "Pay vendors now")).toBe(false);
    expect(isSpellingFix("Review", "Review")).toBe(false); // nothing changed
  });

  it("leaves short names alone, where two letters make a new word", () => {
    expect(isSpellingFix("Pay", "Pry")).toBe(false);
    expect(isSpellingFix("Log", "Lag")).toBe(false);
  });

  it("counts a swap of neighbours as one change", () => {
    expect(editDistance("ab", "ba")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });
});

describe("freshReason", () => {
  it("names what was removed or adjusted", () => {
    expect(freshReason("delete", [{ id: "a", kind: "step" }])).toBe("Removed a step added moments earlier");
    expect(freshReason("delete", [{ id: "a", kind: "step" }, { id: "b", kind: "step" }])).toBe(
      "Removed 2 steps added moments earlier"
    );
    expect(freshReason("edit", [{ id: "e", kind: "connection" }])).toBe(
      "Adjusted a connection added moments earlier"
    );
    expect(freshReason("delete", [{ id: "a", kind: "step" }, { id: "e", kind: "connection" }])).toBe(
      "Removed items added moments earlier"
    );
  });
});

describe("pickAutoReason", () => {
  const now = 1_000_000;
  const createdAt = new Map([
    ["new", now - 30_000],
    ["almost", now - FRESH_MS + 1],
    ["old", now - FRESH_MS],
  ]);
  const base = { working: null, action: "delete" as const, createdAt, now };

  it("skips the box when everything touched is fresh", () => {
    expect(pickAutoReason({ ...base, targets: [{ id: "new", kind: "step" }] })).toBe(
      "Removed a step added moments earlier"
    );
    expect(pickAutoReason({ ...base, targets: [{ id: "almost", kind: "step" }] })).not.toBeNull();
  });

  it("asks once anything is 5 minutes old, not made here, or there's nothing to judge", () => {
    expect(pickAutoReason({ ...base, targets: [{ id: "old", kind: "step" }] })).toBeNull();
    expect(pickAutoReason({ ...base, targets: [{ id: "new", kind: "step" }, { id: "elsewhere", kind: "step" }] })).toBeNull();
    expect(pickAutoReason({ ...base, targets: [] })).toBeNull();
  });

  it("logs a spelling fix on an old step without asking", () => {
    expect(
      pickAutoReason({ ...base, action: "edit", targets: [{ id: "old", kind: "step" }], rename: { before: "Reveiw", after: "Review" } })
    ).toBe(SPELLING_REASON);
    expect(
      pickAutoReason({ ...base, action: "edit", targets: [{ id: "old", kind: "step" }], rename: { before: "Review", after: "Approve" } })
    ).toBeNull();
  });

  it("a working reason wins over everything", () => {
    expect(
      pickAutoReason({ ...base, working: "Approvals clean-up", targets: [{ id: "new", kind: "step" }], rename: { before: "Reveiw", after: "Review" } })
    ).toBe("Approvals clean-up");
    expect(pickAutoReason({ ...base, working: "Approvals clean-up", targets: [] })).toBe("Approvals clean-up");
  });
});
