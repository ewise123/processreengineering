# Chat Pause / Cancel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user cancel an in-flight ask-mode chat reply via a Play→Pause icon toggle on the composer button; cancelling drops the pending reply and restores the prompt to the composer.

**Architecture:** Three small pieces — (1) an optional `AbortSignal` on the `api.chatSuggest` fetch wrapper; (2) a new pure helper `chat-cancel.ts` describing the "undo the send" state transition (unit-tested); (3) wiring in `ChatTab` that holds an `AbortController` + a pre-send snapshot in refs, swaps the button between Play (idle) and Pause (in-flight), and on Pause aborts + rewinds the transcript + restores the draft. Reuses the existing `genRef` generation guard so a late-resolving reply is dropped.

**Tech Stack:** Next.js (React, TypeScript), TanStack Query (`useMutation`), `fetch` + `AbortController`, lucide-react icons, Vitest (node env, pure-logic `.ts` only).

**Spec:** `docs/superpowers/specs/2026-06-24-chat-pause-cancel-design.md`

---

## Background the implementer needs

- **All chat code lives in `src/components/canvas/right-panel.tsx`** in the `ChatTab` component (and its `ChatMsg` child). It is a large file; only the regions noted below change.
- **`ChatItem`** (right-panel.tsx:81) is `type ChatItem = ChatTurn & { contextNote?: string; sources?: MentionSource[] };`. `ChatTurn` (src/lib/types.ts:343) is `{ role: "user" | "assistant"; content: string }`.
- **`genRef`** already exists in `ChatTab` (`const genRef = useRef(0);`): each request carries the `gen` it was sent under, and the mutation's `onSuccess` early-returns when `vars.gen !== genRef.current`. `clearChat()` bumps `genRef` and calls `ask.reset()`. We reuse this exact mechanism for Pause.
- **`api.chatSuggest`** (src/lib/api.ts:317) calls a shared `request<T>(path, init)` helper (src/lib/api.ts:53). `request` destructures `{ json, headers, ...rest }` and spreads `...rest` into `fetch`, so any standard `RequestInit` field (including `signal`) passed on `init` reaches `fetch` automatically.
- **Repo testing convention:** Vitest runs in node env over `src/**/*.test.ts` (pure logic only — no jsdom/RTL). `.tsx` components and the thin `api` client wrapper are NOT unit-tested; they are verified by `npx tsc --noEmit` and `npm run build`. Therefore only Task 2 (the pure helper) gets a unit test; Tasks 1 and 3 are verified by typecheck + build + a manual check.

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src/lib/api.ts` | `chatSuggest` accepts an optional `AbortSignal` and forwards it to `fetch` | Modify |
| `src/components/canvas/chat-cancel.ts` | Pure "undo the send" transition: `PendingSend<T>` snapshot + `restoreAfterCancel` | Create |
| `src/components/canvas/chat-cancel.test.ts` | Unit tests for `restoreAfterCancel` | Create |
| `src/components/canvas/right-panel.tsx` | `ChatTab`: AbortController + snapshot refs, `pause()`, Play/Pause button, abort-error suppression, signal threading | Modify |

---

## Task 1: Thread an AbortSignal through `api.chatSuggest`

**Files:**
- Modify: `src/lib/api.ts` (the `chatSuggest` member, around line 317)

- [ ] **Step 1: Add the optional `signal` parameter and forward it**

Replace the current `chatSuggest` definition:

```typescript
  chatSuggest: (
    projectId: UUID,
    modelId: UUID,
    versionId: UUID,
    body: ChatSuggestRequest
  ) =>
    request<ChatSuggestResponse>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/chat-suggest`,
      { method: "POST", json: body }
    ),
```

with:

```typescript
  chatSuggest: (
    projectId: UUID,
    modelId: UUID,
    versionId: UUID,
    body: ChatSuggestRequest,
    signal?: AbortSignal
  ) =>
    request<ChatSuggestResponse>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/chat-suggest`,
      { method: "POST", json: body, signal }
    ),
```

(`request` spreads unknown init fields into `fetch`, so `signal` needs no other change. `signal` is optional, so the existing call site keeps compiling until Task 3 updates it.)

- [ ] **Step 2: Verify the typecheck passes**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(chat): accept an optional AbortSignal in api.chatSuggest"
```

---

## Task 2: Pure `chat-cancel` helper (TDD)

**Files:**
- Create: `src/components/canvas/chat-cancel.ts`
- Test: `src/components/canvas/chat-cancel.test.ts`

The helper is generic over the history item type so it stays decoupled from `ChatItem` and is trivially testable. `ChatTab` will instantiate it as `PendingSend<ChatItem>`.

- [ ] **Step 1: Write the failing test**

Create `src/components/canvas/chat-cancel.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { restoreAfterCancel } from "./chat-cancel";

describe("restoreAfterCancel", () => {
  it("restores the prior history and puts the cancelled text back in the draft", () => {
    const prior = [{ role: "user", content: "earlier" }];
    expect(restoreAfterCancel({ priorHistory: prior, text: "draft me" })).toEqual({
      history: prior,
      draft: "draft me",
    });
  });

  it("restores to an empty transcript when there was no prior history", () => {
    expect(restoreAfterCancel({ priorHistory: [], text: "first message" })).toEqual({
      history: [],
      draft: "first message",
    });
  });

  it("returns the prior history by reference (no defensive copy)", () => {
    const prior = [{ role: "assistant", content: "a" }];
    expect(restoreAfterCancel({ priorHistory: prior, text: "x" }).history).toBe(prior);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/canvas/chat-cancel.test.ts`
Expected: FAIL — cannot resolve `./chat-cancel` / `restoreAfterCancel is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/components/canvas/chat-cancel.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/canvas/chat-cancel.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/chat-cancel.ts src/components/canvas/chat-cancel.test.ts
git commit -m "feat(chat): pure restoreAfterCancel helper for undoing a send"
```

---

## Task 3: Wire Pause into `ChatTab`

**Files:**
- Modify: `src/components/canvas/right-panel.tsx` (lucide import block ~line 18–29; `ChatTab` refs ~line 332; `ask` mutation ~line 345; `submit` ~line 371; the error banner ~line 454; the composer Send button ~line 555)

All five edits are in the `ChatTab` component except the import.

- [ ] **Step 1: Import the Play and Pause icons**

In the lucide-react import block (currently ending `... MessageSquare, RotateCcw, ... X } from "lucide-react";`), add `Pause` and `Play` after `MessageSquare`:

```typescript
  Link2,
  MessageSquare,
  Pause,
  Play,
  RotateCcw,
```

- [ ] **Step 2: Import the cancel helper and its type**

Find the existing import of sibling canvas modules near the top of `right-panel.tsx` (the block importing `mention-markdown`, `chat-context`, `chat-session`, etc.) and add:

```typescript
import { restoreAfterCancel, type PendingSend } from "./chat-cancel";
```

- [ ] **Step 3: Add the AbortController and pending-send refs**

Immediately after the existing `const genRef = useRef(0);` line in `ChatTab`, add:

```typescript
  // The in-flight request's controller, so Pause can abort it.
  const abortRef = useRef<AbortController | null>(null);
  // Snapshot of what Pause must restore (pre-send transcript + the user's text).
  const pendingRef = useRef<PendingSend<ChatItem> | null>(null);
```

- [ ] **Step 4: Thread `signal` through the mutation**

Replace the current `ask` mutation's `mutationFn` input type and call so it carries and forwards a `signal`. Change the `mutationFn` from:

```typescript
    mutationFn: (input: { history: ChatItem[]; userMessage: string; note?: string; contextRefs: ObjectRef[]; gen: number }) =>
      api.chatSuggest(projectId, modelId, versionId, {
        // Send only the backend contract fields (ChatTurn = role + content);
        // client-only metadata like contextNote/sources must not be resent.
        history: input.history.map(({ role, content }) => ({ role, content })),
        user_message: input.userMessage,
        mode: "ask",
        context_refs: input.contextRefs,
      }),
```

to:

```typescript
    mutationFn: (input: { history: ChatItem[]; userMessage: string; note?: string; contextRefs: ObjectRef[]; gen: number; signal: AbortSignal }) =>
      api.chatSuggest(
        projectId,
        modelId,
        versionId,
        {
          // Send only the backend contract fields (ChatTurn = role + content);
          // client-only metadata like contextNote/sources must not be resent.
          history: input.history.map(({ role, content }) => ({ role, content })),
          user_message: input.userMessage,
          mode: "ask",
          context_refs: input.contextRefs,
        },
        input.signal
      ),
```

Leave the existing `onSuccess` (with its `if (vars.gen !== genRef.current) return;` guard) unchanged.

- [ ] **Step 5: Capture the snapshot + signal in `submit`**

Replace the body of `submit` from the `setDraft("");` line through the `ask.mutate(...)` call. Change:

```typescript
    setDraft("");
    // Capture pre-send history snapshot before optimistic update
    const preSendHistory = history;
    setHistory((curr) => [...curr, { role: "user", content: trimmed, contextNote: note }]);
    ask.mutate({ history: preSendHistory, userMessage: trimmed, note, contextRefs, gen: genRef.current });
    onClearSelection(); // #11: tab slides away once the prompt is sent
```

to:

```typescript
    setDraft("");
    // Capture pre-send history snapshot before optimistic update
    const preSendHistory = history;
    // Snapshot what Pause needs to undo this send, and open an abort channel.
    pendingRef.current = { priorHistory: preSendHistory, text: trimmed };
    const controller = new AbortController();
    abortRef.current = controller;
    setHistory((curr) => [...curr, { role: "user", content: trimmed, contextNote: note }]);
    ask.mutate({
      history: preSendHistory,
      userMessage: trimmed,
      note,
      contextRefs,
      gen: genRef.current,
      signal: controller.signal,
    });
    onClearSelection(); // #11: tab slides away once the prompt is sent
```

- [ ] **Step 6: Add the `pause` function**

Directly after the `submit` function definition (before `clearChat`), add:

```typescript
  const pause = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Bump the generation so any reply that still resolves after the abort is
    // dropped by onSuccess, and reset the mutation to clear the pending state.
    genRef.current += 1;
    ask.reset();
    const pending = pendingRef.current;
    if (pending) {
      const restored = restoreAfterCancel(pending);
      setHistory(restored.history);
      setDraft(restored.draft);
    }
    pendingRef.current = null;
  };
```

- [ ] **Step 7: Suppress the abort error in the error banner**

A cancelled `fetch` rejects with a `DOMException` named `"AbortError"`, which TanStack records as the mutation error even after `ask.reset()` (the rejection lands a microtask later). Guard the banner so it never shows an abort. Change:

```typescript
        {ask.isError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
            {(ask.error as Error).message}
          </div>
        )}
```

to:

```typescript
        {ask.isError &&
          !(ask.error instanceof DOMException && ask.error.name === "AbortError") && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
              {(ask.error as Error).message}
            </div>
          )}
```

- [ ] **Step 8: Swap the Send text button for a Play/Pause icon button**

Replace the composer's Send button. Change:

```typescript
            <button
              onClick={() => submit(draft)}
              disabled={!draft.trim() || ask.isPending}
              className="h-8 rounded-md bg-slate-900 px-3 text-[11px] font-semibold text-white hover:bg-slate-800 disabled:bg-slate-300"
            >
              Send
            </button>
```

to:

```typescript
            <button
              onClick={() => (ask.isPending ? pause() : submit(draft))}
              disabled={!ask.isPending && !draft.trim()}
              title={ask.isPending ? "Stop" : "Send"}
              aria-label={ask.isPending ? "Stop generating" : "Send message"}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-300"
            >
              {ask.isPending ? <Pause size={14} /> : <Play size={14} />}
            </button>
```

(While pending the button is enabled and calls `pause()`; when idle it is disabled only if the draft is empty and calls `submit(draft)`. The square `h-8 w-8` matches the example-prompts toggle button next to the textarea.)

- [ ] **Step 9: Verify typecheck and build**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

Run: `npm run build`
Expected: build completes; route `/projects/[id]/maps/[modelId]/versions/[versionId]` listed; no ESLint errors.

- [ ] **Step 10: Manual verification**

Start the app (backend on :8000, `npm run dev` on :3000 — see `chat_suggest_status` memory for the manual start sequence). Open a map version, open the chat:
1. The composer button shows a **Play** (▶) icon and is disabled until you type.
2. Type a prompt and click Play → the user message appears, "Thinking…" shows, and the button becomes a **Pause** (⏸) icon.
3. Click Pause → "Thinking…" disappears, no assistant message is added, the transcript is back to its pre-send state, and your prompt is back in the composer textarea. No red error banner appears.
4. Send again and let it finish → reply renders normally; the button returns to Play.

- [ ] **Step 11: Commit**

```bash
git add src/components/canvas/right-panel.tsx
git commit -m "feat(chat): Play/Pause composer button cancels an in-flight reply"
```

---

## Self-review notes (already reconciled)

- **Spec coverage:** signal transport → Task 1; pure restore transition + tests → Task 2; icon swap (Play idle / Pause in-flight), enabled-while-pending + disabled-only-when-idle-and-empty, abort + restore-to-composer, genRef reuse, AbortError suppression, manual test → Task 3. The spec's documented limitation (backend may finish the call server-side) needs no code. Deferred agent-loop section needs no code.
- **Type consistency:** `PendingSend<T>` / `restoreAfterCancel` (Task 2) are used as `PendingSend<ChatItem>` in Task 3; the mutation input gains `signal: AbortSignal` (Task 3 Step 4) matching the new `api.chatSuggest(..., signal?)` (Task 1). `genRef`, `ChatItem`, `ask.reset()`, `sessionStore` are all pre-existing symbols referenced as-is.
