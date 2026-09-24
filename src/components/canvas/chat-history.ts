import type { ChatTurn } from "@/lib/types";

/**
 * Stand-in for an assistant turn that carried no prose. Suggest-mode replies
 * can come back with an empty `message` (only suggestion cards), and the
 * backend's `ChatTurn` requires `content` length >= 1 — so an empty assistant
 * turn resent in `history` would be rejected with a 422.
 */
export const EMPTY_TURN_PLACEHOLDER = "(suggested changes)";

/** The backend caps `history` at this many turns; a longer thread 422s. */
export const MAX_HISTORY_TURNS = 40;

/**
 * Map stored chat items down to the backend `ChatTurn` contract (role + content
 * only — client-only fields like sources/suggestions/contextNote must not be
 * resent), keep only the most recent {@link MAX_HISTORY_TURNS} turns, and coerce
 * empty/whitespace content to a non-empty placeholder.
 *
 * This guards three cases: a suggest-mode reply with empty prose; any
 * empty-content turn already persisted in an older session; and a long-running
 * thread that has grown past the server's history cap — all of which would
 * otherwise 422 on the next send.
 */
export function toRequestHistory(
  items: ReadonlyArray<{ role: ChatTurn["role"]; content: string }>
): ChatTurn[] {
  // Keep the most recent turns — recent context matters most, and the server
  // rejects more than MAX_HISTORY_TURNS.
  return items.slice(-MAX_HISTORY_TURNS).map(({ role, content }) => ({
    role,
    content: content.trim() ? content : EMPTY_TURN_PLACEHOLDER,
  }));
}
