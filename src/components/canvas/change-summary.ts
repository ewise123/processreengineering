/**
 * One plain line saying what a change-log entry did, e.g.
 * `Renamed "File" → "File invoice"`. Pure: built from the event's before and
 * after, with `names` resolving step and lane ids that are still on the map.
 */
import type { ChangeEvent } from "@/lib/types";

type Bag = Record<string, unknown> | null;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const quoted = (v: unknown) => (str(v) ? `“${v}”` : "none");

export function describeChange(event: ChangeEvent, names: ReadonlyMap<string, string>): string {
  const before: Bag = event.before;
  const after: Bag = event.after;
  const name = (id: unknown) => (typeof id === "string" && names.get(id)) || "a step";
  const thing = event.target_type === "lane" ? "lane" : event.target_type === "edge" ? "arrow" : "step";
  const current = names.get(event.target_id);
  const pair = (b: Bag) => `${name(b?.source_node_id)} → ${name(b?.target_node_id)}`;

  switch (event.kind) {
    case "create":
      return `Added ${thing} ${quoted(after?.name ?? current)}`;
    case "connect":
      return `Connected ${pair(after)}`;
    case "reconnect":
      return `Moved arrow to ${pair(after)} (was ${pair(before)})`;
    case "delete":
      if (event.target_type === "edge") return `Deleted arrow ${pair(before)}`;
      return `Deleted ${thing} ${quoted(before?.name)}`;
    case "set_condition":
      return `Condition ${quoted(before?.condition_text)} → ${quoted(after?.condition_text)}`;
    case "explain": {
      // The row keeps a copy of the change it explains.
      const kind = before && typeof before.kind === "string" ? before.kind : null;
      if (!kind) return "Reason given later";
      const original = describeChange(
        { ...event, kind, before: (before?.before as Bag) ?? null, after: (before?.after as Bag) ?? null },
        names
      );
      return `Reason given later for: ${original}`;
    }
  }

  const parts: string[] = [];
  if (before && after && ("name" in after || "label" in after)) {
    const b = before.name ?? before.label;
    const a = after.name ?? after.label;
    parts.push(
      event.target_type === "edge" ? `Label ${quoted(b)} → ${quoted(a)}` : `Renamed ${quoted(b)} → ${quoted(a)}`
    );
  }
  if (after && "lane_id" in after) parts.push(`moved to lane ${quoted(names.get(String(after.lane_id)))}`);
  if (after && "type" in after && before && "type" in before) {
    parts.push(`type ${String(before.type).replace(/_/g, " ")} → ${String(after.type).replace(/_/g, " ")}`);
  }
  if (after && "description" in after) parts.push("edited the description");
  if (parts.length === 0) return `${event.kind.replace(/_/g, " ")} ${quoted(current)}`.trim();
  const line = parts.join(", ");
  const lead = line.charAt(0).toUpperCase() + line.slice(1);
  // Say which step, unless the rename already names it.
  return parts[0].startsWith("Renamed") || !current ? lead : `${quoted(current)}: ${line}`;
}
