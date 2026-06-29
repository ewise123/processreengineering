import type { UUID } from "@/lib/types";

const MENTION_RE = /\[\[(node|edge|claim|lane):([^\]]+)\]\]\s?/g;

/** Convert backend [[kind:uuid]] mentions into custom poet:// markdown links so
 * the message can render through react-markdown with one custom link renderer.
 * Node → poet://node/<id> (label = step name), claim → poet://claim/<id>
 * (label = source doc name), lane → poet://lane/<id> (label = lane name),
 * edge → poet://edge/<id> (label = "connection"; edges have no name). The rest
 * of the string is left as-is for markdown. */
export function mentionsToMarkdown(
  text: string,
  labelById: Map<UUID, string>,
  sourceNameByClaimId: Map<UUID, string>,
  laneNameById: Map<UUID, string> = new Map()
): string {
  // Escape both brackets so a label containing "[" or "]" can't break out of
  // the markdown link text.
  const escapeLabel = (s: string) => s.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  return text.replace(MENTION_RE, (matched: string, kind: string, id: string) => {
    const trailing = /\s$/.test(matched) ? " " : "";
    if (kind === "node") {
      const label = escapeLabel(labelById.get(id) ?? "step");
      return `[${label}](poet://node/${id})${trailing}`;
    }
    if (kind === "claim") {
      const label = escapeLabel(sourceNameByClaimId.get(id) ?? "source");
      return `[${label}](poet://claim/${id})${trailing}`;
    }
    if (kind === "lane") {
      const label = escapeLabel(laneNameById.get(id) ?? "lane");
      return `[${label}](poet://lane/${id})${trailing}`;
    }
    if (kind === "edge") {
      // Edges have no display name; link a generic "connection" the user can
      // click to focus the edge on the canvas.
      return `[connection](poet://edge/${id})${trailing}`;
    }
    return "";
  });
}
