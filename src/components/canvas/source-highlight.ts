// src/components/canvas/source-highlight.ts

/** Normalize text for tolerant matching: ascii-ize quotes/dashes, collapse
 *  whitespace, lowercase. Applied to BOTH the quote and the text-layer item. */
export function normalizeForMatch(s: string): string {
  return s
    // U+201C left double, U+201D right double, U+201E low-9, U+201F reversed
    .replace(/[“”„‟]/g, '"')
    // U+2018 left single, U+2019 right single, U+201A low-9, U+201B reversed
    .replace(/[‘’‚‛]/g, "'")
    // U+2013 en-dash, U+2014 em-dash
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Page hint from a citation's section_ref. Native PDFs carry {page} or {slide}
 *  that maps to a 1-based page; sheet/heading refs have no page → null. */
export function targetPageFromRef(
  ref: Record<string, unknown> | null | undefined,
): number | null {
  if (!ref) return null;
  const v = ref.page ?? ref.slide;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const WORD_CHAR = /[a-z0-9]/;

/** True when a text-layer item is part of the quote, matched on WORD
 *  BOUNDARIES. Used per-item in react-pdf's customTextRenderer to decide
 *  whether to wrap it in <mark>. Requires a non-trivial fragment (>1 char) and
 *  rejects coincidental mid-word substrings (e.g. "in" inside "within") so the
 *  viewer never highlights — or scrolls to — a false positive. */
export function isQuoteFragment(itemText: string, quote: string): boolean {
  const frag = normalizeForMatch(itemText);
  if (frag.length < 2) return false;
  const q = normalizeForMatch(quote);
  let from = 0;
  for (;;) {
    const i = q.indexOf(frag, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : q[i - 1];
    const after = i + frag.length >= q.length ? "" : q[i + frag.length];
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = i + 1;
  }
}

/** Locate a citation quote inside a document's full text, tolerant of
 *  whitespace runs and curly-vs-straight quote/dash differences. Returns the
 *  [start, end) range in the ORIGINAL text (so the exact original run is
 *  highlighted), or null if not found. Used by the text fast-path viewer, where
 *  the whole document text is contiguous (unlike the PDF per-item path). */
export function findQuoteInText(
  text: string,
  quote: string,
): { start: number; end: number } | null {
  const q = quote.trim();
  if (q.length < 2) return null;
  const pattern = q
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // escape regex metachars FIRST
    .replace(/["“”„‟]/g, '["“”„‟]') // any double-quote variant
    .replace(/['‘’‚‛]/g, "['‘’‚‛]") // any single-quote variant
    .replace(/[-–—]/g, "[-–—]") // any dash variant
    .replace(/\s+/g, "\\s+"); // whitespace-tolerant
  const m = new RegExp(pattern, "i").exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}
