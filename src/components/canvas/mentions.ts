import type { UUID } from "@/lib/types";

export type MentionKind = "node" | "edge" | "claim" | "lane";

export type MentionSegment =
  | { type: "text"; value: string }
  | { type: "ref"; kind: MentionKind; id: UUID };

const MENTION_RE = /\[\[(node|edge|claim|lane):([^\]]+)\]\]/g;

/** Split assistant prose into text and mention segments. Mentions are the
 * stable [[kind:uuid]] form the backend rewrites short refs into. Anything
 * that does not match a known kind is left as literal text. */
export function parseMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index ?? 0;
    if (start > last) {
      segments.push({ type: "text", value: text.slice(last, start) });
    }
    segments.push({ type: "ref", kind: m[1] as MentionKind, id: m[2] });
    last = start + m[0].length;
  }
  if (last < text.length) {
    segments.push({ type: "text", value: text.slice(last) });
  }
  return segments;
}
