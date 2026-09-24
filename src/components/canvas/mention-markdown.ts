import type { MentionSource, UUID } from "@/lib/types";

const MENTION_RE = /\[\[(node|edge|claim|lane|new):([^\]]+)\]\]\s?/g;

/** Replace [[kind:id]] mentions with their plain display NAME (no link markup),
 * for text that must read as plain prose — e.g. the message composed from a
 * user's answers to the agent's clarifying questions, which is both shown in the
 * chat and sent back to the model. Leaving the raw [[node:uuid]] / [[claim:uuid]]
 * markup in that message renders as garbled text and means nothing to the model. */
export function mentionsToPlainText(
  text: string,
  labelById: Map<UUID, string>,
  sourceNameByClaimId: Map<UUID, string>,
  laneNameById: Map<UUID, string> = new Map(),
  newNameByRef: Map<string, string> = new Map()
): string {
  return text.replace(MENTION_RE, (matched: string, kind: string, id: string) => {
    const trailing = /\s$/.test(matched) ? " " : "";
    if (kind === "node") return (labelById.get(id) ?? "the step") + trailing;
    if (kind === "claim") return (sourceNameByClaimId.get(id) ?? "the source") + trailing;
    if (kind === "lane") return (laneNameById.get(id) ?? "the lane") + trailing;
    if (kind === "new") return (newNameByRef.get(id) ?? "the new step") + trailing;
    if (kind === "edge") return "the connection" + trailing;
    return "";
  });
}

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
 * map each `claim` mention to its source **document** (`input_id`, falling
 * back to `input_name`). Dedupe is scoped to this single call: as `text` is
 * scanned left-to-right, the first `claim` mention of a given document renders
 * as a link, and a later mention of that *same* document *within this same
 * text* is dropped rather than repeating the same chip. The seen-documents set
 * is local to this call — it is never derived from, or shared across, other
 * calls that pass the same `sources` (e.g. the prose bubble vs. a suggestion
 * card's title/rationale), so one render can never cause another render to
 * lose its only citation. Claim ids absent from `sources` are left untouched
 * (fall back to the "source" label below), so passing an empty/omitted list
 * preserves the previous behavior. */
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
  // Claim id → source document key, so a repeat mention of the same document
  // (not merely the same claim id) can be recognized as a dupe within this text.
  const docKeyByClaimId = new Map(sources.map((s) => [s.claim_id, s.input_id || s.input_name]));
  // Fresh per call: which documents this one `text` has already rendered a
  // citation link for. Never seeded from anything outside this call.
  const seenDocKeys = new Set<string>();
  const rendered = text.replace(MENTION_RE, (matched: string, kind: string, id: string) => {
    const trailing = /\s$/.test(matched) ? " " : "";
    if (kind === "node") {
      const label = escapeLabel(labelById.get(id) ?? "step");
      return `[${label}](poet://node/${id})${trailing}`;
    }
    if (kind === "claim") {
      const docKey = docKeyByClaimId.get(id);
      if (docKey !== undefined) {
        // A repeat citation of a document already shown earlier in *this*
        // text — drop the duplicate chip instead of showing the same source
        // name again.
        if (seenDocKeys.has(docKey)) return "";
        seenDocKeys.add(docKey);
      }
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
  // The dedupe above drops duplicate same-document citation chips but leaves the
  // separators that were between them, e.g. "ap-sop.txt, , , and all state …".
  // Collapse any run of consecutive commas back to one (consecutive commas are
  // never legitimate prose), so a collapsed citation list reads cleanly.
  return rendered.replace(/,(\s*,)+\s*/g, ", ");
}
