import type { UUID } from "@/lib/types";

const MENTION_RE = /\[\[(node|edge|claim|lane):([^\]]+)\]\]\s?/g;

/** Convert backend [[kind:uuid]] mentions into custom poet:// markdown links so
 * the message can render through react-markdown with one custom link renderer.
 * Node → poet://node/<id> (label = step name), claim → poet://claim/<id>
 * (label = source doc name). Edges/lanes are dropped to plain text (edges are
 * not chat objects). The rest of the string is left as-is for markdown. */
export function mentionsToMarkdown(
  text: string,
  labelById: Map<UUID, string>,
  sourceNameByClaimId: Map<UUID, string>
): string {
  return text.replace(MENTION_RE, (matched: string, kind: string, id: string) => {
    const trailing = /\s$/.test(matched) ? " " : "";
    if (kind === "node") {
      const label = (labelById.get(id) ?? "step").replace(/\]/g, "\\]");
      return `[${label}](poet://node/${id})${trailing}`;
    }
    if (kind === "claim") {
      const label = (sourceNameByClaimId.get(id) ?? "source").replace(/\]/g, "\\]");
      return `[${label}](poet://claim/${id})${trailing}`;
    }
    // edge / lane: not a chat object — drop the token entirely (including any
    // trailing space that was part of the mention separator).
    return "";
  });
}
