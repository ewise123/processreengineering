/**
 * Copy for the reason prompt — both the generic default and the delete variants.
 *
 * Deleting a step, connection, or lane requires a reason — the backend rejects a
 * blank one with a 422, exactly as it does for a rename or a lane move. Because
 * cancelling the prompt aborts the delete, the prompt is also the confirm step,
 * so its wording has to say what the delete takes with it.
 *
 * Every string the prompt can show lives here so the promise that the reason is
 * recorded is made in one voice: a user who deletes a step and then renames one
 * should not meet two differently-worded versions of the same guarantee.
 *
 * Pure and separate from `bpmn-canvas.tsx` so it can be tested without rendering
 * the canvas.
 */

export interface DeleteCounts {
  nodes: number;
  edges: number;
}

const RECORDED = "Add a short reason — it's saved to the change log.";

/** Body copy for a non-destructive edit; the dialog's default when no
 * `description` is supplied. Longer than {@link RECORDED} because an ordinary
 * edit has nothing to warn about, so the space goes to the why. */
export const REASON_PROMPT_DESCRIPTION =
  "Add a short reason for this change. It is saved to the change log so the edit history stays explainable.";

/** Title for the reason modal, e.g. "Delete 3 steps" / "Delete 5 items". */
export function deleteActionLabel({ nodes, edges }: DeleteCounts): string {
  // A mixed selection collapses to a total rather than enumerating both counts;
  // the modal is a prompt, not an inventory (that's issue #54's job).
  if (nodes > 0 && edges > 0) return `Delete ${nodes + edges} items`;
  if (edges > 0) return edges === 1 ? "Delete connection" : `Delete ${edges} connections`;
  // Callers never prompt on an empty selection — the delete handlers return
  // early — so an all-zero count falls through to the singular rather than
  // getting a branch of its own.
  return nodes > 1 ? `Delete ${nodes} steps` : "Delete step";
}

/** Body copy for the reason modal. Says what else the delete removes. */
export function deleteActionDescription({ nodes, edges }: DeleteCounts): string {
  if (nodes === 0 && edges > 0) {
    const subject = edges === 1 ? "the connection" : "the connections";
    return `This removes ${subject}. ${RECORDED}`;
  }
  // Any selection containing a step also takes that step's edges with it.
  return `This removes the selection and any connections to it. ${RECORDED}`;
}

export const DELETE_LANE_LABEL = "Delete lane";
export const DELETE_LANE_DESCRIPTION =
  `This removes the lane; its steps move to the first remaining lane. ${RECORDED}`;
