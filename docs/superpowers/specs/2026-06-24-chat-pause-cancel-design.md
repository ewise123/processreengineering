# Chat Pause / Cancel — Design

> Scope note: this is the revised **Phase 2.1b**. The original 2.1b (SSE streaming +
> activity notes) is **deferred** — see "Deferred: agent tool loop" below. This phase
> ships only the ability to cancel an in-flight reply.

## Goal

Let the user cancel a chat request that is in flight. While a reply is pending, the
composer's **Send** control becomes a **Pause** control; clicking it aborts the request,
drops the pending reply, and returns the composer to its pre-send state so the prompt can
be edited and resent.

## Background: what exists today

The ask-mode chat (`ChatTab` in `src/components/canvas/right-panel.tsx`) sends one request
through `api.chatSuggest` (a `fetch` wrapper) and renders the whole reply on success.
Relevant current behavior:

- `submit(text)` optimistically appends the user message to `history`, then calls
  `ask.mutate({ history: preSendHistory, userMessage, note, contextRefs, gen })`.
- `onSuccess` rebuilds `history` from `preSendHistory + userMessage + assistantMessage`,
  persists it to `sessionStore`, and only then is the turn durable.
- A generation ref (`genRef`) already exists: each request carries the `gen` it was sent
  under, and `onSuccess` drops a reply whose `gen` is stale (added so clearing the chat
  can't be undone by a late reply).
- The Send button is a text button, `disabled` while `ask.isPending`. There is no icon
  and no way to cancel.

## Decision

- **Cancel only — no streaming.** No SSE endpoint, no activity notes. The model call stays
  a single request/response.
- **Icon swap.** The composer button shows a **Play** icon (▶, lucide `Play`) when idle and
  a **Pause** icon (⏸, lucide `Pause`) while a request is in flight. No separate "Stop" label
  or tooltip change beyond the icon (and an accessible `aria-label`).
- **Cancel restores the prompt to the composer.** On Pause, the transcript returns to
  exactly its pre-send state (the optimistic user message is removed) and the aborted text
  is put back into the draft box. Nothing is persisted for the aborted turn. This is clean
  "undo the send" semantics and avoids leaving an unpersisted message that would vanish on
  reload.

## Architecture

Three small, well-bounded pieces:

1. **Abort transport (`src/lib/api.ts`).** `api.chatSuggest(...)` gains an optional
   `signal?: AbortSignal` argument, passed straight to `fetch`. No other behavior change.

2. **Cancel state helper (`src/components/canvas/chat-cancel.ts`, new, pure).** A tiny pure
   module describing the pre-send snapshot needed to undo a send and the restore transition.
   Pure so it is unit-testable under the repo's node-env vitest convention. Shape:

   ```ts
   export interface PendingSend {
     /** history exactly as it was before the optimistic user message was appended */
     priorHistory: ChatItem[];
     /** the user's text, so Pause can restore it to the composer */
     text: string;
   }

   /** What the UI should become after a Pause: the transcript to show and the draft to
    * restore. Kept pure so the transition is testable without React. */
   export function restoreAfterCancel(pending: PendingSend): {
     history: ChatItem[];
     draft: string;
   } {
     return { history: pending.priorHistory, draft: pending.text };
   }
   ```

3. **Composer wiring (`ChatTab` in `right-panel.tsx`).**
   - Hold the in-flight `AbortController` and the `PendingSend` snapshot in refs.
   - `submit` creates a fresh `AbortController`, records the `PendingSend`, and passes
     `controller.signal` to `ask.mutate` (threaded into `api.chatSuggest`).
   - The button: when `ask.isPending`, render the **Pause** icon (⏸) and an `onClick` that
     calls `pause()`; otherwise render the **Play** icon (▶) and `onClick={() => submit(draft)}`.
     Disabled logic: **disabled only when idle and the draft is empty**
     (`!ask.isPending && !draft.trim()`). While pending it is always enabled so it can be
     clicked to cancel.
   - `pause()` → `controller.abort()`, bump `genRef` (so any reply that still resolves is
     dropped), `ask.reset()` (clears `isPending`/error), then apply `restoreAfterCancel`
     to set `history` and `draft`.

## Data flow

```text
idle:     [Play icon ▶]  --click-->  submit(): snapshot PendingSend, new AbortController,
                                     optimistic user msg, mutate(signal)
pending:  [Pause icon ⏸] --click-->  pause(): abort + genRef++ + reset + restoreAfterCancel
                                     -> transcript back to priorHistory, draft = text
```

## Error handling

- An aborted `fetch` rejects with an `AbortError` (`DOMException`, `name === "AbortError"`).
  This must **not** surface as a chat error. Because `pause()` calls `ask.reset()`
  synchronously, the mutation's error state is cleared; additionally the mutation's
  `onError` should ignore an `AbortError` (no-op) so a race can't flash the error banner.
- Real (non-abort) errors continue to show in the existing `ask.isError` banner.

## Known limitation (accepted)

Aborting the `fetch` cancels the **client** wait and drops the reply, but the request is not
streamed, so the FastAPI handler may still run the Anthropic call to completion server-side
(those tokens are spent). True server-side cancellation requires streaming + disconnect
detection, which is deferred with the rest of streaming. The UX goal — the user regains
control immediately and never gets a stale reply — is fully met.

## Testing

- **`chat-cancel.test.ts` (vitest, node):** `restoreAfterCancel` returns the prior history
  and the original text as the draft; an empty prior history restores to `[]`.
- **Typecheck + build:** `npx tsc --noEmit`, `npm run build` cover the `api.ts` signature
  change and the `ChatTab` wiring (`.tsx` is not unit-tested per repo convention).
- **Manual:** send a prompt, click Pause mid-flight → "Thinking…" disappears, the prompt is
  back in the composer, no assistant message is added, and a subsequent send works normally.

## Out of scope (this phase)

- Token-by-token or activity-note streaming, SSE endpoint, `EventSource`/reader plumbing.
- Server-side cancellation of the Anthropic call.

## Deferred: agent tool loop (future phase, recorded here so it isn't lost)

The genuinely production-grade "activity" pattern is to give the chat real tools
(`search_claims`, `get_step_detail`, `lookup_citation`, and later `propose_*` write tools),
run an agentic loop, and surface each actual tool call as an activity note — the way
Claude/ChatGPT narrate real work. Benefits beyond the obvious observability and
capability-gating: retrieval-on-demand instead of context-stuffing (scales past the context
window), verifiable provenance (a hard record of which sources were consulted), and a single
architecture that unifies ask-mode and suggest-mode (the same loop that reads can propose
edits, each gated and never auto-applied). This is the right home for ask + suggest to
converge and should be its own dedicated phase.
