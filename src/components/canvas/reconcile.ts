/** Pure mapping of persisted SP-7c reconcile suggestions to display rows for
 * the suggestion inbox. The inbox stays op-agnostic; this turns each op's
 * resolved payload into a human-readable title + detail line. */
import type { ReconcileSuggestion } from "@/lib/types";

export interface ReconcileRow {
  title: string;
  detail: string;
}

function asIds(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

export function reconcileRow(s: ReconcileSuggestion): ReconcileRow {
  const p = s.payload ?? {};
  switch (s.op) {
    case "add_step": {
      const name = typeof p.name === "string" && p.name.trim() ? p.name : "(unnamed)";
      const cited = asIds(p.cited_claim_ids).length;
      return {
        title: `Add step: ${name}`,
        detail: `${cited} cited claim${cited === 1 ? "" : "s"}`,
      };
    }
    case "recite_node": {
      const add = asIds(p.add_claim_ids).length;
      const remove = asIds(p.remove_claim_ids).length;
      return { title: "Update citations", detail: `+${add} / -${remove} claim links` };
    }
    case "flag_stale_node": {
      const n = asIds(p.vanished_claim_ids).length;
      return {
        title: "Flag evidence stale",
        detail: `${n} cited claim${n === 1 ? "" : "s"} left this process`,
      };
    }
    case "relabel_node": {
      const name = typeof p.proposed_name === "string" ? p.proposed_name : "(unnamed)";
      return { title: `Relabel: ${name}`, detail: "Rename the step to match its claims" };
    }
    default:
      return { title: "Reconcile change", detail: "" };
  }
}
