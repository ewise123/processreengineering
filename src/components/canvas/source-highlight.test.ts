import { describe, expect, it } from "vitest";

import {
  isQuoteFragment,
  normalizeForMatch,
  targetPageFromRef,
} from "./source-highlight";

describe("normalizeForMatch", () => {
  it("collapses whitespace and lowercases", () => {
    expect(normalizeForMatch("  The   Quick\nBrown ")).toBe("the quick brown");
  });
  it("normalizes curly quotes and dashes to ascii", () => {
    // “ = left double quote, ” = right double quote, — = em-dash
    expect(normalizeForMatch("“words” — more")).toBe('"words" - more');
  });
});

describe("targetPageFromRef", () => {
  it("reads page", () => {
    expect(targetPageFromRef({ page: 3 })).toBe(3);
  });
  it("reads slide as a page index", () => {
    expect(targetPageFromRef({ slide: 5 })).toBe(5);
  });
  it("returns null when no positional ref", () => {
    expect(targetPageFromRef({ sheet: "Sheet1" })).toBeNull();
    expect(targetPageFromRef({})).toBeNull();
    expect(targetPageFromRef(null)).toBeNull();
  });
});

describe("isQuoteFragment", () => {
  const quote = "the approval must complete within two business days";
  it("matches a multi-word run from the quote", () => {
    expect(isQuoteFragment("approval must complete", quote)).toBe(true);
  });
  it("matches case- and whitespace-insensitively", () => {
    expect(isQuoteFragment("  Two   Business ", quote)).toBe(true);
  });
  it("rejects text not in the quote", () => {
    expect(isQuoteFragment("rejected immediately", quote)).toBe(false);
  });
  it("rejects trivial/empty fragments to avoid over-highlighting", () => {
    expect(isQuoteFragment(" ", quote)).toBe(false);
    expect(isQuoteFragment("a", quote)).toBe(false);
  });
});
