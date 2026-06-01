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

/** True when a text-layer item is part of the quote. Used per-item in
 *  react-pdf's customTextRenderer to decide whether to wrap it in <mark>.
 *  Requires a non-trivial fragment (>1 char) to avoid highlighting stray
 *  letters/spaces. */
export function isQuoteFragment(itemText: string, quote: string): boolean {
  const frag = normalizeForMatch(itemText);
  if (frag.length < 2) return false;
  return normalizeForMatch(quote).includes(frag);
}
