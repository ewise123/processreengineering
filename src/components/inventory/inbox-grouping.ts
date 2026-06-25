import type { ProcessSuggestion } from "@/lib/types";

export interface SuggestionBatch {
  batchId: string;
  suggestions: ProcessSuggestion[];
  pendingCount: number;
  /** Earliest created_at of the batch's suggestions. Used as the batch's
   * ordering key; safe because all suggestions in one batch are written
   * atomically (a single LLM run), so the min timestamp identifies the batch. */
  createdAt: string;
}

/** Group suggestions by batch_id. Within a batch, suggestions keep
 * created_at order; batches are returned newest-first keyed by their
 * earliest created_at (see SuggestionBatch.createdAt). */
export function groupByBatch(suggestions: ProcessSuggestion[]): SuggestionBatch[] {
  const byBatch = new Map<string, ProcessSuggestion[]>();
  for (const s of suggestions) {
    const arr = byBatch.get(s.batch_id) ?? [];
    arr.push(s);
    byBatch.set(s.batch_id, arr);
  }
  const batches: SuggestionBatch[] = [];
  for (const [batchId, list] of byBatch) {
    const sorted = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));
    batches.push({
      batchId,
      suggestions: sorted,
      pendingCount: sorted.filter((s) => s.status === "pending").length,
      createdAt: sorted[0]?.created_at ?? "",
    });
  }
  batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return batches;
}
