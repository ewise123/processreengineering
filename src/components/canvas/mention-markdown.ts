import type { MentionSource, UUID } from "@/lib/types";

const MENTION_RE = /\[\[(node|edge|claim|lane|new):([^\]]+)\]\]\s?/g;

/** Dedupe a message's cited sources so repeated citations of the same source
 * **document** collapse to a single representative entry, keeping the first
 * occurrence (in array order). Keyed by `input_id`, falling back to
 * `input_name` if an id is ever missing.
 *
 * `mention_sources` is deduped by `claim_id` upstream (in the backend), but
 * several claims commonly come from the same document — rendering every one
 * of them as its own citation reads as "interview.txt / interview.txt /
 * interview.txt …" duplication. Exact per-quote linkage for the collapsed
 * duplicates is a separate, deferred effort (provenance v2). */
export function dedupeSourcesByDocument(sources: MentionSource[]): MentionSource[] {
  const seen = new Set<string>();
  const out: MentionSource[] = [];
  for (const s of sources) {
    const key = s.input_id || s.input_name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Convert backend [[kind:uuid]] mentions into custom poet:// markdown links so
 * the message can render through react-markdown with one custom link renderer.
 * Node → poet://node/<id> (label = step name), claim → poet://claim/<id>
 * (label = source doc name), lane → poet://lane/<id> (label = lane name),
 * edge → poet://edge/<id> (label = "connection"; edges have no name),
 * new → poet://new/<tmpRef> (label = an in-bundle object's planned name; not yet
 * created, so non-clickable). The rest of the string is left as-is for markdown.
 *
 * `sources` (optional) is this message's full cited-sources list, used only to
 * dedupe repeat `claim` mentions of the same document — the first mention of a
 * given document renders as a link; later mentions of an already-shown
 * document are dropped rather than repeating the same chip. Claim ids absent
 * from `sources` are left untouched (fall back to the "source" label below),
 * so passing an empty/omitted list preserves the previous behavior. */
export function mentionsToMarkdown(
  text: string,
  labelById: Map<UUID, string>,
  sourceNameByClaimId: Map<UUID, string>,
  laneNameById: Map<UUID, string> = new Map(),
  newNameByRef: Map<string, string> = new Map(),
  sources: MentionSource[] = []
): string {
  // Escape both brackets so a label containing "[" or "]" can't break out of
  // the markdown link text.
  const escapeLabel = (s: string) => s.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  // Claim ids known to belong to a document (any claim from that document),
  // vs. the subset that should actually render (one per document, first seen).
  const knownClaimIds = new Set(sources.map((s) => s.claim_id));
  const keptClaimIds = new Set(dedupeSourcesByDocument(sources).map((s) => s.claim_id));
  return text.replace(MENTION_RE, (matched: string, kind: string, id: string) => {
    const trailing = /\s$/.test(matched) ? " " : "";
    if (kind === "node") {
      const label = escapeLabel(labelById.get(id) ?? "step");
      return `[${label}](poet://node/${id})${trailing}`;
    }
    if (kind === "claim") {
      // A repeat citation of a document already shown earlier in this
      // message — drop the duplicate chip instead of showing the same
      // source name again.
      if (knownClaimIds.has(id) && !keptClaimIds.has(id)) return "";
      const label = escapeLabel(sourceNameByClaimId.get(id) ?? "source");
      return `[${label}](poet://claim/${id})${trailing}`;
    }
    if (kind === "lane") {
      const label = escapeLabel(laneNameById.get(id) ?? "lane");
      return `[${label}](poet://lane/${id})${trailing}`;
    }
    if (kind === "new") {
      const label = escapeLabel(newNameByRef.get(id) ?? "new step");
      return `[${label}](poet://new/${id})${trailing}`;
    }
    if (kind === "edge") {
      // Edges have no display name; link a generic "connection" the user can
      // click to focus the edge on the canvas.
      return `[connection](poet://edge/${id})${trailing}`;
    }
    return "";
  });
}
