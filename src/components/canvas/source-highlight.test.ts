import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  findQuoteInText,
  isQuoteFragment,
  normalizeForMatch,
  targetPageFromRef,
} from "./source-highlight";

describe("escapeHtml", () => {
  it("neutralizes script tags and angle brackets", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });
  it("escapes the img onerror XSS payload", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });
  it("escapes ampersands first so entities are not double-decoded", () => {
    expect(escapeHtml("a & <b>")).toBe("a &amp; &lt;b&gt;");
  });
  it("leaves plain text untouched", () => {
    expect(escapeHtml("plain words 123")).toBe("plain words 123");
  });
});

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
  it("rejects coincidental mid-word substrings", () => {
    expect(isQuoteFragment("in", quote)).toBe(false); // within
    expect(isQuoteFragment("com", quote)).toBe(false); // complete
    expect(isQuoteFragment("ess", quote)).toBe(false); // business
    expect(isQuoteFragment("th", quote)).toBe(false); // the
    expect(isQuoteFragment("us", quote)).toBe(false); // must
  });
  it("matches whole words on boundaries", () => {
    expect(isQuoteFragment("two", quote)).toBe(true);
    expect(isQuoteFragment("days", quote)).toBe(true);
    expect(isQuoteFragment("approval", quote)).toBe(true);
  });
});

describe("findQuoteInText", () => {
  const text =
    "Intro line.\nThe approval must complete\nwithin two business days, per policy.";

  it("locates an exact quote and returns original indices", () => {
    const r = findQuoteInText(text, "two business days")!;
    expect(r).not.toBeNull();
    expect(text.slice(r.start, r.end)).toBe("two business days");
  });
  it("is whitespace-tolerant across newlines", () => {
    const r = findQuoteInText(text, "must complete within two")!;
    expect(r).not.toBeNull();
    expect(text.slice(r.start, r.end)).toBe("must complete\nwithin two");
  });
  it("is case-insensitive", () => {
    const r = findQuoteInText(text, "THE APPROVAL")!;
    expect(text.slice(r.start, r.end).toLowerCase()).toBe("the approval");
  });
  it("tolerates curly vs straight quotes", () => {
    expect(findQuoteInText('He said "yes" today', "He said “yes” today")).not.toBeNull();
  });
  it("returns null when not found", () => {
    expect(findQuoteInText(text, "rejected immediately")).toBeNull();
  });
  it("returns null for trivial quotes", () => {
    expect(findQuoteInText(text, "a")).toBeNull();
  });
});
