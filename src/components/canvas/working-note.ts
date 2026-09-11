/**
 * The working note: one sentence describing the sitting ("Redraw O2C after the
 * Maria Chen interview"), stamped as the reason on every edit made while it is
 * set.
 *
 * Why a note rather than a prompt per edit: a consultant redrawing a map after
 * an interview makes dozens of semantic edits in a sitting, and a modal on each
 * one produces "fix", "update", "x" — filler that looks like provenance and
 * isn't. The note asks once for the thing only the human knows (what this work
 * session *is*), and the change log keeps recording actor, before/after and
 * timestamp on every edit regardless. See issue #87.
 *
 * Deliberately *not* drafting a reason from the before/after values: the change
 * event already stores both sides, so "Moved from Sales to Fulfilment" only
 * restates the diff. A log full of confirmed restatements is worse than a log
 * that admits it was a drafting session.
 *
 * Pure so it can be tested without rendering the canvas.
 */

export interface ReasonContext {
  /** The current working note; blank or whitespace means "not set". */
  note: string;
  /** True when the pending action destroys something (a delete). */
  destructive: boolean;
}

export type ReasonResolution =
  /** Record straight away with `reason`; no dialog is shown. */
  | { mode: "auto"; reason: string }
  /** Open the dialog with `seed` already in the field. */
  | { mode: "prompt"; seed: string };

/**
 * Decide whether an edit can take its reason from the working note or has to
 * ask. Deletes always ask: the prompt doubles as the confirm step, so skipping
 * it would delete on a single keystroke. A set note still helps there — it
 * seeds the field, making the confirm one keypress instead of a sentence.
 */
export function resolveReasonPrompt({ note, destructive }: ReasonContext): ReasonResolution {
  const trimmed = note.trim();
  if (trimmed === "") return { mode: "prompt", seed: "" };
  if (destructive) return { mode: "prompt", seed: trimmed };
  return { mode: "auto", reason: trimmed };
}

/** The subset of the Web Storage API we use; injected so the store is
 * testable in the node test env and SSR-safe. Mirrors `chat-session.ts`. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const keyFor = (versionId: string) => `poet-working-note:${versionId}`;

export interface WorkingNoteStore {
  load(versionId: string): string;
  save(versionId: string, note: string): void;
}

/**
 * Keeps the working note alive across a refresh and across navigating away
 * from the canvas and back, which is the difference between "set it once this
 * sitting" and "set it again every time I glance at a source document".
 *
 * Keyed by version: two maps open in one session must not stamp each other's
 * reasons. Tab-scoped (sessionStorage) rather than permanent — a note left set
 * from last Monday silently explaining today's edits would be worse than being
 * asked again.
 *
 * Every call is guarded: private browsing and blocked site data make storage
 * throw. Losing the note is a nuisance; taking the canvas down with it is not.
 */
export function makeWorkingNoteStore(storage: StorageLike): WorkingNoteStore {
  return {
    load(versionId) {
      try {
        return storage.getItem(keyFor(versionId)) ?? "";
      } catch {
        return "";
      }
    },
    save(versionId, note) {
      try {
        if (note.trim() === "") storage.removeItem(keyFor(versionId));
        else storage.setItem(keyFor(versionId), note);
      } catch {
        // Storage unavailable — the note stays in memory for this page view.
      }
    },
  };
}

/** The sessionStorage-backed store, or a no-op during SSR / when storage is
 * unavailable. */
export function browserWorkingNoteStore(): WorkingNoteStore {
  if (typeof window === "undefined" || !window.sessionStorage) {
    return makeWorkingNoteStore({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
  }
  return makeWorkingNoteStore(window.sessionStorage);
}
