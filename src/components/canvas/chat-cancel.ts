/** The snapshot captured when a chat message is sent, holding exactly what Pause
 * needs to undo that send: the transcript as it was *before* the optimistic user
 * message was appended, and the user's text so it can be put back in the composer.
 * Generic over the history item type to stay decoupled from ChatItem. */
export interface PendingSend<T> {
  priorHistory: T[];
  text: string;
}

/** The UI state to apply after a Pause: the transcript to show (rewound to its
 * pre-send state) and the draft to restore. Pure so the transition is testable
 * without React. */
export function restoreAfterCancel<T>(pending: PendingSend<T>): {
  history: T[];
  draft: string;
} {
  return { history: pending.priorHistory, draft: pending.text };
}
