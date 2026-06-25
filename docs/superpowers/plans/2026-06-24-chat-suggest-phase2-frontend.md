# Chat-Suggest Phase 2: Chat Panel + Ask Mode + Mentions + Teleport — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild POET's Chat tab on the new `chat-suggest` endpoint in **Ask mode** — a grounded conversational chat whose answers carry clickable object mentions that teleport + flash the node/edge on the canvas, with selection-chip context and ephemeral per-version session persistence.

**Architecture:** Backend rewrites short refs (`[[N3]]`) in the assistant's prose into stable `[[node:<uuid>]]` mentions using the Phase 1 reverse-ref maps, so the frontend parses UUIDs and resolves labels locally. New pure, unit-tested TS modules (`mentions.ts`, `chat-context.ts`, `chat-session.ts`, edge-focus geometry) carry all logic; the `ChatTab` `.tsx` is thin wiring that composes them. Teleport extends the canvas's existing `focusNodeInViewport`/`selectNode` to edges plus a transient highlight.

**Tech Stack:** Next.js + React + TanStack Query, Tailwind, Vitest (node env, pure-logic `.ts` tests only — no jsdom). Backend: FastAPI + the `anthropic` SDK.

---

## Context for the engineer

This is **Phase 2 of 4** of the chat-suggest rebuild. Phase 1 (backend suggestion engine: `chat-suggest` endpoint, `consistency` scan) is **merged to main**.

- **Spec:** `docs/superpowers/specs/2026-06-24-chat-suggest-rebuild-design.md`
- **Scope (locked): Ask mode only.** No Ask/Suggest toggle and **no suggestion cards** — all suggestion UI (cards, apply, dim, undo, grouping) lands in Phase 3. In Ask mode the endpoint returns `suggestions: []`; this phase consumes only `message`.
- **Branch:** `chat-suggest-phase2` (already created off `main`).

### What already exists (read these before starting)

- `src/components/canvas/right-panel.tsx` — `ChatTab` (lines 282–415): local `history: ChatTurn[]` + `draft`, a TanStack `useMutation` calling `api.chatWithMap`, suggested-prompt chips, composer, and `ChatMsg` (417–443) which renders assistant prose by splitting on `\n`. `RightPanel` (props at 80–106) receives `nodes: {id,name,type,lane_id}[]`, `selected: SelectedRef | null`, and `onFocusNode: (id) => void`, but **does not currently pass `nodes`/`onFocusNode` into `ChatTab`** — Phase 2 threads them in.
- `src/lib/api.ts` — `request<T>(path, {json})` helper (51–79); `chatWithMap` (305–314). `API_BASE` from `NEXT_PUBLIC_API_URL`.
- `src/lib/types.ts` — `UUID = string` (line 3); `ChatTurn`/`ChatRequest`/`ChatResponse` (335–348).
- `src/components/canvas/bpmn-canvas.tsx` — `BpmnCanvasHandle` interface (line 136) exposing `selectNode(id)`; `focusNodeInViewport(id)` (592–609) panning to a node center using `lane.y + relativeY`; `useImperativeHandle` (611–626). Refs available in scope: `nodesRef.current`, `edgesRef.current` (each edge has `.from`/`.to`), `displayLanesRef.current` (lane `.y`), `viewportRef.current`, `svgRef.current`.
- `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` — wires `BpmnCanvas` (ref `canvasRef`) and `RightPanel`; passes `onFocusNode={(id) => canvasRef.current?.selectNode(id)}` (~line 447) and `nodes={data.nodes.map(...)}`.
- Backend (Phase 1): `backend/app/services/map_chat.py` `chat(*, history, user_message, map_context_text) -> str`; `backend/app/services/map_chat_suggest.py` `run_chat_suggest(...)` whose ASK branch calls `chat(...)`; `backend/app/api/v2/process_maps.py` `chat_suggest` endpoint + `_resolve_refs`, `_build_suggestion`, and `MapContext` (`node_ref_to_id`/`edge_ref_to_id`/`lane_ref_to_id`/`claim_ref_to_id`).

### Testing conventions

- **Frontend:** Vitest, node env, `src/**/*.test.ts` only (no jsdom/RTL). **Test pure logic in `.ts` modules.** `.tsx` components and the thin `api` client wrapper are NOT unit-tested here (repo convention) — they're verified by typecheck (`npx tsc --noEmit`) and running the app.
  - Single test file: `npx vitest run src/components/canvas/<file>.test.ts`
  - Typecheck: `npx tsc --noEmit`
- **Backend:** `cd backend && source .venv/bin/activate && pytest tests/<file> -v`. No `ANTHROPIC_API_KEY` needed (client faked/patched).

### The mention contract (how teleport-able links flow end-to-end)

> **Implementation note (shipped):** the contract narrowed during the 2.1a polish pass. Edges are **not** chat objects, so the model is instructed not to emit edge refs in prose, and any `[[edge:…]]` that slips through is dropped to plain text on the frontend. Claim refs **are** clickable (they open the Source Viewer), and the response additionally returns `mention_sources` (per-claim source targets). The numbered steps below reflect the original plan; treat this note as the source of truth where they differ.

1. Ask-mode system prompt tells the model to wrap references as `[[N3]]` (node) and `[[C1]]` (claim) using the refs from the map context (edge refs are not requested).
2. The endpoint post-processes the returned `message`, rewriting each `[[N3]]`→`[[node:<uuid>]]`, `[[C1]]`→`[[claim:<uuid>]]` via the Phase 1 ctx maps, and collects each cited claim's source target into `mention_sources`. Unresolvable refs are flattened to plain text (`[[N9]]`→`N9`).
3. The frontend `mentionsToMarkdown` converts the message into `poet://node|claim/<id>` markdown links; node links teleport + flash via the canvas handle, and claim links open the Source Viewer for that citation.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `backend/app/services/map_chat.py` | `chat()` gains optional `extra_instructions` (legacy `/chat` unaffected) | Modify |
| `backend/app/services/map_chat_suggest.py` | ask branch passes the mention-ref instruction | Modify |
| `backend/app/api/v2/process_maps.py` | `_resolve_mention_refs` + apply to endpoint `message` | Modify |
| `backend/tests/test_chat_suggest.py` | tests for instruction + resolver | Modify (append) |
| `src/lib/types.ts` | chat-suggest request/response types (mirror backend) | Modify |
| `src/lib/api.ts` | `api.chatSuggest()` client fn | Modify |
| `src/components/canvas/mentions.ts` | pure `parseMentions` (`[[kind:uuid]]` → segments) | Create |
| `src/components/canvas/mentions.test.ts` | parser tests | Create |
| `src/components/canvas/chat-context.ts` | `selectionToContextRefs`, `selectionChips` (pure) | Create |
| `src/components/canvas/chat-context.test.ts` | tests | Create |
| `src/components/canvas/chat-session.ts` | `makeChatSessionStore(storage)` (DI'd, pure) | Create |
| `src/components/canvas/chat-session.test.ts` | tests | Create |
| `src/components/canvas/edge-focus.ts` | `edgeFocusCenter(edge, nodes, lanes)` (pure geometry) | Create |
| `src/components/canvas/edge-focus.test.ts` | tests | Create |
| `src/components/canvas/bpmn-canvas.tsx` | `navigateTo({kind,id})` on handle + edge focus + transient flash | Modify |
| `src/components/canvas/right-panel.tsx` | thread `nodes`+`onNavigate` into `ChatTab`; rebuild `ChatTab`/`ChatMsg` on `chatSuggest` + mentions + chips + session | Modify |
| `src/app/(canvas)/.../page.tsx` | pass `onNavigate` (maps to `canvasRef.navigateTo`) to `RightPanel` | Modify |

---

## Task 1: Backend — emit + resolve mention refs

Make the ask-mode assistant prose carry stable `[[node:<uuid>]]` mentions.

**Files:**
- Modify: `backend/app/services/map_chat.py`, `backend/app/services/map_chat_suggest.py`, `backend/app/api/v2/process_maps.py`
- Test: `backend/tests/test_chat_suggest.py` (append)

- [ ] **Step 1: Write the failing tests** — append to `backend/tests/test_chat_suggest.py`:

```python
def test_resolve_mention_refs_rewrites_known_refs_to_uuids():
    from app.api.v2 import process_maps as pm_api
    ctx, (n1, _n2, e1, l1, c1) = _ctx_stub()
    msg = "Step [[N1]] feeds edge [[E1]] per claim [[C1]] in lane [[L1]]."
    out = pm_api._resolve_mention_refs(msg, ctx)
    assert f"[[node:{n1}]]" in out
    assert f"[[edge:{e1}]]" in out
    assert f"[[claim:{c1}]]" in out
    assert f"[[lane:{l1}]]" in out


def test_resolve_mention_refs_flattens_unknown_refs():
    from app.api.v2 import process_maps as pm_api
    ctx, _ = _ctx_stub()
    out = pm_api._resolve_mention_refs("Unknown [[N9]] here.", ctx)
    assert out == "Unknown N9 here."  # brackets stripped, plain text kept


def test_chat_runs_extra_instructions_into_system(monkeypatch):
    from app.services import map_chat
    captured = {}

    class _Resp:
        content = [type("B", (), {"type": "text", "text": "ok"})()]

    class _Client:
        @property
        def messages(self):
            return self
        def create(self, **kwargs):
            captured["system"] = kwargs["system"]
            return _Resp()

    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.setattr(map_chat.anthropic, "Anthropic", lambda **k: _Client())
    map_chat.chat(history=[], user_message="hi", map_context_text="M",
                  extra_instructions="WRAP REFS LIKE [[N3]]")
    assert "WRAP REFS LIKE [[N3]]" in captured["system"]


def test_chat_suggest_ask_message_is_mention_resolved(db):
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    project, version, n1, claim = _seed(db)
    # N1 is the first (only) node; ask the service to return a message citing it.
    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_suggest",
                   lambda **k: ("See step [[N1]].", []))
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="x", mode="ask"), db=db)
    assert f"[[node:{n1.id}]]" in resp.message
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd /home/ewise/projects/processreengineering/backend && source .venv/bin/activate && pytest tests/test_chat_suggest.py -k "mention or extra_instructions or ask_message_is_mention" -v`
Expected: FAIL (`_resolve_mention_refs` missing; `chat()` has no `extra_instructions`).

- [ ] **Step 3a: Add `extra_instructions` to `chat()`** in `backend/app/services/map_chat.py`.

Change the signature and system composition:
```python
def chat(
    *,
    history: list[ChatTurn],
    user_message: str,
    map_context_text: str,
    extra_instructions: str = "",
) -> str:
```
Then where `full_system` is built (currently `SYSTEM_PROMPT + "\n\n---\nCurrent process map...\n" + map_context_text`), insert the extra block before the map context:
```python
    full_system = SYSTEM_PROMPT
    if extra_instructions:
        full_system += "\n\n---\n" + extra_instructions
    full_system += (
        "\n\n---\nCurrent process map (grounded source of truth):\n"
        + map_context_text
    )
```
The legacy `/chat` endpoint calls `chat()` without `extra_instructions`, so its behavior is unchanged.

- [ ] **Step 3b: Pass the mention instruction in ask mode** in `backend/app/services/map_chat_suggest.py`.

Add the instruction constant near `SUGGEST_INSTRUCTIONS` (the **shipped** wording drops edge/lane refs — see the implementation note in "The mention contract" above):
```python
MENTION_INSTRUCTIONS = (
    "When you reference a specific element of the map, wrap its short ref in double "
    "brackets so the UI can turn it into a link: a node as [[N3]], an edge as [[E2]], "
    "a claim as [[C1]], a lane as [[L1]]. Use the refs exactly as they appear in the "
    "map context above; never invent one."
)
```
In `run_chat_suggest`, the ASK branch currently calls `chat(history=..., user_message=..., map_context_text=...)`. Add the instruction:
```python
    if mode == ChatMode.ASK:
        message = chat(
            history=history,
            user_message=user_message,
            map_context_text=map_context_text,
            extra_instructions=MENTION_INSTRUCTIONS,
        )
        return message, []
```
Also append `MENTION_INSTRUCTIONS` to the suggest-mode system prompt (so suggest-mode prose links too), right after `SUGGEST_INSTRUCTIONS`:
```python
    system = (
        CHAT_GUARDRAILS
        + "\n\n---\n"
        + SUGGEST_INSTRUCTIONS
        + "\n\n"
        + MENTION_INSTRUCTIONS
        + "\n\n---\nCurrent process map (grounded source of truth):\n"
        + map_context_text
    )
```

- [ ] **Step 3c: Add `_resolve_mention_refs` and apply it** in `backend/app/api/v2/process_maps.py`.

Add near `_build_suggestion` (top-of-file `import re` if not already imported — check first):
```python
import re

_MENTION_RE = re.compile(r"\[\[([NELC])(\d+)\]\]")
_MENTION_KIND = {"N": ("node", "node_ref_to_id"), "E": ("edge", "edge_ref_to_id"),
                 "L": ("lane", "lane_ref_to_id"), "C": ("claim", "claim_ref_to_id")}


def _resolve_mention_refs(message: str, ctx) -> str:
    """Rewrite short refs the model emitted ([[N3]]/[[E2]]/[[C1]]/[[L1]]) into
    stable [[kind:uuid]] mentions the frontend can link. Unknown refs are
    flattened to plain text so prose stays readable."""
    def _sub(m):
        letter, num = m.group(1), m.group(2)
        short = f"{letter}{num}"
        kind, attr = _MENTION_KIND[letter]
        real = getattr(ctx, attr).get(short)
        return f"[[{kind}:{real}]]" if real is not None else short
    return _MENTION_RE.sub(_sub, message)
```
In the `chat_suggest` endpoint, resolve the message before returning. Change the final lines from `return ChatSuggestResponse(message=message, suggestions=suggestions)` to:
```python
    return ChatSuggestResponse(
        message=_resolve_mention_refs(message, ctx),
        suggestions=suggestions,
    )
```

- [ ] **Step 4: Run, verify PASS** (the new tests + full suite no regressions)

Run: `cd /home/ewise/projects/processreengineering/backend && source .venv/bin/activate && pytest tests/test_chat_suggest.py -v && pytest -q`
Expected: new tests pass; full suite green (no regressions — Phase 1 message-equality tests still pass because plain strings have no brackets).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/map_chat.py backend/app/services/map_chat_suggest.py backend/app/api/v2/process_maps.py backend/tests/test_chat_suggest.py
git commit -m "feat(chat-suggest): emit + resolve [[kind:uuid]] mention refs in chat prose"
```

---

## Task 2: Frontend types + `chatSuggest` client

Mirror the backend contract and add the client call. (No unit test — thin wrapper + types, per repo convention; verified by typecheck and later tasks.)

**Files:**
- Modify: `src/lib/types.ts`, `src/lib/api.ts`

- [ ] **Step 1: Add types** to `src/lib/types.ts` (after the existing `ChatResponse` at ~line 348):

```typescript
export type ChatMode = "ask" | "suggest";
export type RefKind = "node" | "edge" | "lane";

export interface ObjectRef {
  kind: RefKind;
  id: UUID;
}

export type OpKind =
  | "relabel_node" | "describe_node" | "add_node" | "remove_node"
  | "add_edge" | "remove_edge" | "relabel_edge" | "reroute_edge"
  | "move_to_lane" | "add_lane" | "rename_lane" | "decompose";

export interface SuggestionSubStep {
  proposed_name: string;
  proposed_type: string;
  role?: string | null;
  edge_label?: string | null;
}

export interface SuggestionOp {
  kind: OpKind;
  node_ref?: string | null;
  edge_ref?: string | null;
  lane_ref?: string | null;
  temp_id?: string | null;
  from_ref?: string | null;
  to_ref?: string | null;
  new_label?: string | null;
  description?: string | null;
  name?: string | null;
  node_type?: string | null;
  near_node_ref?: string | null;
  edge_label?: string | null;
  sub_steps?: SuggestionSubStep[] | null;
}

export interface ChatSuggestion {
  id: string;
  group?: string | null;
  title: string;
  op: SuggestionOp;
  affected_refs: ObjectRef[];
  rationale: string;
  cited_claim_ids: UUID[];
}

export interface ChatSuggestRequest {
  history: ChatTurn[];
  user_message: string;
  mode: ChatMode;
  context_refs: ObjectRef[];
}

export interface ChatSuggestResponse {
  message: string;
  suggestions: ChatSuggestion[];
  // Added during 2.1a: per-claim source targets for the citations referenced in
  // `message`, so claim links can open the Source Viewer.
  mention_sources: MentionSource[];
}
```

- [ ] **Step 2: Add the client fn** to `src/lib/api.ts` directly after `chatWithMap` (which ends ~line 314). First ensure `ChatSuggestRequest` and `ChatSuggestResponse` are added to the type import block at the top of the file (the `from "@/lib/types"` import around lines 20–47):

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

- [ ] **Step 3: Typecheck**

Run: `cd /home/ewise/projects/processreengineering && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts
git commit -m "feat(chat-suggest): frontend chat-suggest types + api.chatSuggest client"
```

---

## Task 3: `mentions.ts` — parse `[[kind:uuid]]` into segments

**Files:**
- Create: `src/components/canvas/mentions.ts`
- Test: `src/components/canvas/mentions.test.ts`

- [ ] **Step 1: Write the failing test** — `src/components/canvas/mentions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseMentions } from "./mentions";

const N = "11111111-1111-1111-1111-111111111111";
const E = "22222222-2222-2222-2222-222222222222";

describe("parseMentions", () => {
  it("returns a single text segment when there are no mentions", () => {
    expect(parseMentions("just prose")).toEqual([{ type: "text", value: "just prose" }]);
  });

  it("splits text around a node mention", () => {
    expect(parseMentions(`See [[node:${N}]] now`)).toEqual([
      { type: "text", value: "See " },
      { type: "ref", kind: "node", id: N },
      { type: "text", value: " now" },
    ]);
  });

  it("handles edge and claim kinds and back-to-back mentions", () => {
    const out = parseMentions(`[[edge:${E}]][[claim:${N}]]`);
    expect(out).toEqual([
      { type: "ref", kind: "edge", id: E },
      { type: "ref", kind: "claim", id: N },
    ]);
  });

  it("leaves unknown kinds as literal text", () => {
    expect(parseMentions("[[bogus:x]] tail")).toEqual([
      { type: "text", value: "[[bogus:x]] tail" },
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseMentions("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd /home/ewise/projects/processreengineering && npx vitest run src/components/canvas/mentions.test.ts`
Expected: FAIL — cannot find `./mentions`.

- [ ] **Step 3: Implement** — `src/components/canvas/mentions.ts`:

```typescript
import type { UUID } from "@/lib/types";

export type MentionKind = "node" | "edge" | "claim" | "lane";

export type MentionSegment =
  | { type: "text"; value: string }
  | { type: "ref"; kind: MentionKind; id: UUID };

const MENTION_RE = /\[\[(node|edge|claim|lane):([^\]]+)\]\]/g;

/** Split assistant prose into text and mention segments. Mentions are the
 * stable [[kind:uuid]] form the backend rewrites short refs into. Anything
 * that does not match a known kind is left as literal text. */
export function parseMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index ?? 0;
    if (start > last) {
      segments.push({ type: "text", value: text.slice(last, start) });
    }
    segments.push({ type: "ref", kind: m[1] as MentionKind, id: m[2] });
    last = start + m[0].length;
  }
  if (last < text.length) {
    segments.push({ type: "text", value: text.slice(last) });
  }
  return segments;
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd /home/ewise/projects/processreengineering && npx vitest run src/components/canvas/mentions.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/mentions.ts src/components/canvas/mentions.test.ts
git commit -m "feat(chat-suggest): parseMentions splits prose into text/ref segments"
```

---

## Task 4: `chat-context.ts` — selection → context refs + chips

**Files:**
- Create: `src/components/canvas/chat-context.ts`
- Test: `src/components/canvas/chat-context.test.ts`

`SelectedRef` (from `right-panel.tsx`) is `{ id: UUID; kind: "node" | "edge"; name?: string; nodeKind?: string } | null`. These helpers turn it into API `context_refs` and display chips.

- [ ] **Step 1: Write the failing test** — `src/components/canvas/chat-context.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { selectionToContextRefs, selectionChips } from "./chat-context";

const NODE = { id: "n1", kind: "node" as const, name: "Review Invoice" };
const EDGE = { id: "e1", kind: "edge" as const };

describe("selectionToContextRefs", () => {
  it("returns empty for null selection", () => {
    expect(selectionToContextRefs(null)).toEqual([]);
  });
  it("maps a node selection to one node ref", () => {
    expect(selectionToContextRefs(NODE)).toEqual([{ kind: "node", id: "n1" }]);
  });
  it("maps an edge selection to one edge ref", () => {
    expect(selectionToContextRefs(EDGE)).toEqual([{ kind: "edge", id: "e1" }]);
  });
});

describe("selectionChips", () => {
  const labelById = new Map([["n1", "Review Invoice"]]);
  it("returns empty for null selection", () => {
    expect(selectionChips(null, labelById)).toEqual([]);
  });
  it("labels a node chip from the map, falling back to its own name", () => {
    expect(selectionChips(NODE, labelById)).toEqual([
      { kind: "node", id: "n1", label: "Review Invoice" },
    ]);
  });
  it("labels an edge chip generically when no name is known", () => {
    expect(selectionChips(EDGE, labelById)).toEqual([
      { kind: "edge", id: "e1", label: "transition" },
    ]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd /home/ewise/projects/processreengineering && npx vitest run src/components/canvas/chat-context.test.ts`
Expected: FAIL — cannot find `./chat-context`.

- [ ] **Step 3: Implement** — `src/components/canvas/chat-context.ts`:

```typescript
import type { ObjectRef, RefKind, UUID } from "@/lib/types";

/** Mirrors the SelectedRef shape used by RightPanel/ChatTab. */
export interface SelectedRef {
  id: UUID;
  kind: "node" | "edge";
  name?: string;
  nodeKind?: string;
}

export interface ContextChip {
  kind: RefKind;
  id: UUID;
  label: string;
}

/** Selection attached to the next chat message as grounding context. */
export function selectionToContextRefs(selected: SelectedRef | null): ObjectRef[] {
  if (!selected) return [];
  return [{ kind: selected.kind, id: selected.id }];
}

/** Display chips shown above the composer for the attached selection. */
export function selectionChips(
  selected: SelectedRef | null,
  labelById: Map<UUID, string>
): ContextChip[] {
  if (!selected) return [];
  const label =
    selected.kind === "node"
      ? labelById.get(selected.id) ?? selected.name ?? "step"
      : "transition";
  return [{ kind: selected.kind, id: selected.id, label }];
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd /home/ewise/projects/processreengineering && npx vitest run src/components/canvas/chat-context.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/chat-context.ts src/components/canvas/chat-context.test.ts
git commit -m "feat(chat-suggest): selection -> context refs + display chips helpers"
```

---

## Task 5: `chat-session.ts` — ephemeral per-version persistence

A storage-injected store so it's testable in the node env (no real `sessionStorage`).

**Files:**
- Create: `src/components/canvas/chat-session.ts`
- Test: `src/components/canvas/chat-session.test.ts`

- [ ] **Step 1: Write the failing test** — `src/components/canvas/chat-session.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { makeChatSessionStore } from "./chat-session";
import type { ChatTurn } from "@/lib/types";

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const TURNS: ChatTurn[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello [[node:abc]]" },
];

describe("makeChatSessionStore", () => {
  it("returns [] when nothing is stored", () => {
    const store = makeChatSessionStore(fakeStorage());
    expect(store.load("v1")).toEqual([]);
  });

  it("round-trips turns per version id", () => {
    const s = fakeStorage();
    const store = makeChatSessionStore(s);
    store.save("v1", TURNS);
    expect(store.load("v1")).toEqual(TURNS);
    expect(store.load("v2")).toEqual([]); // isolated per version
  });

  it("clear() empties a version's history", () => {
    const store = makeChatSessionStore(fakeStorage());
    store.save("v1", TURNS);
    store.clear("v1");
    expect(store.load("v1")).toEqual([]);
  });

  it("load() tolerates corrupt JSON by returning []", () => {
    const s = fakeStorage();
    s.setItem("poet-chat:v1", "{not json");
    const store = makeChatSessionStore(s);
    expect(store.load("v1")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd /home/ewise/projects/processreengineering && npx vitest run src/components/canvas/chat-session.test.ts`
Expected: FAIL — cannot find `./chat-session`.

- [ ] **Step 3: Implement** — `src/components/canvas/chat-session.ts`:

```typescript
import type { ChatTurn, UUID } from "@/lib/types";

/** The subset of the Web Storage API we use; injected so the store is
 * testable in the node test env and SSR-safe. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const keyFor = (versionId: UUID) => `poet-chat:${versionId}`;

export interface ChatSessionStore {
  load(versionId: UUID): ChatTurn[];
  save(versionId: UUID, turns: ChatTurn[]): void;
  clear(versionId: UUID): void;
}

/** Ephemeral chat history keyed by version id. Survives tab navigation
 * within the session; cleared on hard reload (sessionStorage). */
export function makeChatSessionStore(storage: StorageLike): ChatSessionStore {
  return {
    load(versionId) {
      const raw = storage.getItem(keyFor(versionId));
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as ChatTurn[]) : [];
      } catch {
        return [];
      }
    },
    save(versionId, turns) {
      storage.setItem(keyFor(versionId), JSON.stringify(turns));
    },
    clear(versionId) {
      storage.removeItem(keyFor(versionId));
    },
  };
}

/** Returns the browser sessionStorage-backed store, or a no-op store during
 * SSR / when storage is unavailable. */
export function browserChatSessionStore(): ChatSessionStore {
  if (typeof window === "undefined" || !window.sessionStorage) {
    const noop: StorageLike = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    return makeChatSessionStore(noop);
  }
  return makeChatSessionStore(window.sessionStorage);
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd /home/ewise/projects/processreengineering && npx vitest run src/components/canvas/chat-session.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/chat-session.ts src/components/canvas/chat-session.test.ts
git commit -m "feat(chat-suggest): ephemeral per-version chat session store"
```

---

## Task 6: `edge-focus.ts` — pure edge-center geometry

The canvas can already center a node; for edges we center on the midpoint between the two endpoint nodes' centers. Extract the math as a pure function so it's tested independently of the SVG.

**Files:**
- Create: `src/components/canvas/edge-focus.ts`
- Test: `src/components/canvas/edge-focus.test.ts`

- [ ] **Step 1: Write the failing test** — `src/components/canvas/edge-focus.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { edgeFocusCenter } from "./edge-focus";

const lanes = [{ id: "L1", y: 0 }, { id: "L2", y: 100 }];
// node center = (x + w/2, laneY + relativeY + h/2)
const nodes = [
  { id: "a", laneId: "L1", x: 0, relativeY: 10, w: 100, h: 60 },   // center (50, 40)
  { id: "b", laneId: "L2", x: 200, relativeY: 10, w: 100, h: 60 }, // center (250, 140)
];

describe("edgeFocusCenter", () => {
  it("returns the midpoint between the two endpoint node centers", () => {
    const c = edgeFocusCenter({ from: "a", to: "b" }, nodes, lanes);
    expect(c).toEqual({ cx: 150, cy: 90 });
  });

  it("returns null when an endpoint node is missing", () => {
    expect(edgeFocusCenter({ from: "a", to: "ghost" }, nodes, lanes)).toBeNull();
  });

  it("treats a missing lane as y=0 (relativeY only)", () => {
    const c = edgeFocusCenter(
      { from: "a", to: "b" },
      [{ id: "a", laneId: null, x: 0, relativeY: 10, w: 100, h: 60 },
       { id: "b", laneId: null, x: 0, relativeY: 10, w: 100, h: 60 }],
      lanes
    );
    expect(c).toEqual({ cx: 50, cy: 40 });
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd /home/ewise/projects/processreengineering && npx vitest run src/components/canvas/edge-focus.test.ts`
Expected: FAIL — cannot find `./edge-focus`.

- [ ] **Step 3: Implement** — `src/components/canvas/edge-focus.ts`:

```typescript
import type { UUID } from "@/lib/types";

interface FocusNode {
  id: UUID;
  laneId: UUID | null;
  x: number;
  relativeY: number;
  w: number;
  h: number;
}
interface FocusLane {
  id: UUID;
  y: number;
}

/** World-space center of the midpoint between an edge's two endpoint nodes,
 * or null if either endpoint is missing. Mirrors the canvas convention that a
 * node's absolute Y is its lane's y plus relativeY. */
export function edgeFocusCenter(
  edge: { from: UUID; to: UUID },
  nodes: FocusNode[],
  lanes: FocusLane[]
): { cx: number; cy: number } | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const a = byId.get(edge.from);
  const b = byId.get(edge.to);
  if (!a || !b) return null;
  const laneY = (n: FocusNode) =>
    (n.laneId ? lanes.find((l) => l.id === n.laneId)?.y ?? 0 : 0) + n.relativeY;
  const centerOf = (n: FocusNode) => ({ x: n.x + n.w / 2, y: laneY(n) + n.h / 2 });
  const ca = centerOf(a);
  const cb = centerOf(b);
  return { cx: (ca.x + cb.x) / 2, cy: (ca.y + cb.y) / 2 };
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd /home/ewise/projects/processreengineering && npx vitest run src/components/canvas/edge-focus.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/edge-focus.ts src/components/canvas/edge-focus.test.ts
git commit -m "feat(chat-suggest): pure edge-focus center geometry"
```

---

## Task 7: Canvas `navigateTo` + transient flash

Extend the canvas handle with `navigateTo({kind,id})` (node → existing focus; edge → pan to `edgeFocusCenter`), select the target, and set a short-lived `flashId` for a highlight pulse.

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx`
- (No unit test — DOM/imperative; the geometry it relies on is tested in Task 6. Verified by typecheck + running the app.)

- [ ] **Step 1: Extend the handle interface.** In `src/components/canvas/bpmn-canvas.tsx`, add to the `BpmnCanvasHandle` interface (line 136 block), after `selectNode`:

```typescript
  /** Pan/zoom to an object by id, select it, and flash it briefly. Handles
   * both nodes and edges (used by chat mention links). */
  navigateTo: (ref: { kind: "node" | "edge"; id: UUID }) => void;
```

- [ ] **Step 2: Add flash state + an edge focuser + the handle method.**

Add the import at the top with the other local imports:
```typescript
import { edgeFocusCenter } from "./edge-focus";
```
Add flash state near the other `useState` hooks (e.g. by `selectedIds`):
```typescript
  const [flashId, setFlashId] = useState<UUID | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((id: UUID) => {
    setFlashId(id);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 1400);
  }, []);
```
Add an edge-focuser next to `focusNodeInViewport` (reuses the same pan math):
```typescript
  const focusEdgeInViewport = useCallback((id: UUID) => {
    const edge = edgesRef.current.find((e) => e.id === id);
    if (!edge) return;
    const center = edgeFocusCenter(
      { from: edge.from, to: edge.to },
      nodesRef.current,
      displayLanesRef.current
    );
    const svg = svgRef.current;
    if (!center || !svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const v = viewportRef.current;
    setViewport({
      scale: v.scale,
      tx: rect.width / 2 - center.cx * v.scale,
      ty: rect.height / 2 - center.cy * v.scale,
    });
  }, []);
```
In the `useImperativeHandle` value (lines 611–626), add the method alongside `selectNode`:
```typescript
      navigateTo: (refTarget) => {
        setSelectedIds(new Set([refTarget.id]));
        if (refTarget.kind === "edge") focusEdgeInViewport(refTarget.id);
        else focusNodeInViewport(refTarget.id);
        flash(refTarget.id);
      },
```
Add `focusEdgeInViewport` and `flash` to that `useImperativeHandle` dependency array.

- [ ] **Step 3: Render the flash highlight.** Where nodes and edges are rendered, add a highlight when `flashId === <id>`. For nodes, the simplest non-invasive approach is an extra SVG `<rect>` outline behind/around the flashed node, and for edges a thickened stroke. Add this, after the existing node/edge rendering, a highlight overlay keyed on `flashId`:

```typescript
  {flashId && (() => {
    const fn = renderNodes.find((n) => n.id === flashId);
    if (fn) {
      return (
        <rect
          x={fn.x - 4}
          y={fn.y - 4}
          width={fn.w + 8}
          height={fn.h + 8}
          rx={8}
          fill="none"
          stroke="#6366f1"
          strokeWidth={3}
          className="pointer-events-none"
        >
          <animate attributeName="opacity" values="1;0.2;1" dur="0.7s" repeatCount="2" />
        </rect>
      );
    }
    return null;
  })()}
```
(`renderNodes` is the resolved-coords array computed at lines ~801–812; it has absolute `y`. Place this block inside the same `<g>`/SVG group that renders nodes, after the nodes map so the outline draws on top. Edge flashing is optional polish — node flashing covers the primary mention case; if edges render in the same group you may add an analogous stroked overlay, but it is not required for this task.)

- [ ] **Step 4: Typecheck + build**

Run: `cd /home/ewise/projects/processreengineering && npx tsc --noEmit`
Expected: no errors. (Existing `selectNode` callers unaffected; `navigateTo` is additive.)

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx
git commit -m "feat(chat-suggest): canvas navigateTo (node+edge) with transient flash"
```

---

## Task 8: Rebuild `ChatTab` on chat-suggest + mentions + chips + session

Wire it all together. `ChatTab` now receives `nodes` and `onNavigate`; `RightPanel` threads them in; the page passes `onNavigate` mapping to `canvasRef.navigateTo`.

**Files:**
- Modify: `src/components/canvas/right-panel.tsx`
- Modify: `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx`
- (No unit test — JSX wiring; logic is in the tested modules. Verified by typecheck + running the app.)

- [ ] **Step 1: Page — pass `onNavigate`.** In `page.tsx`, the `<RightPanel ... />` already has `onFocusNode={(id) => canvasRef.current?.selectNode(id)}`. Add directly below it:

```tsx
            onNavigate={(refTarget) => canvasRef.current?.navigateTo(refTarget)}
```

- [ ] **Step 2: RightPanel — accept + forward `onNavigate`, pass `nodes`+`onNavigate` to ChatTab.**

Add to the `RightPanel` props type (the block at lines 88–106), after `onFocusNode`:
```tsx
  /** Teleport + flash any object (node/edge) on the canvas. Used by chat mentions. */
  onNavigate: (ref: { kind: "node" | "edge"; id: UUID }) => void;
```
Add `onNavigate` to the destructured params (the list at lines ~74–87).
Find where `<ChatTab .../>` is rendered (in the tab switch, `tab === "chat"`) and change it to pass the extra props:
```tsx
            <ChatTab
              projectId={projectId}
              modelId={modelId}
              versionId={versionId}
              selected={selected}
              nodes={nodes}
              onNavigate={onNavigate}
            />
```

- [ ] **Step 3: ChatTab — replace the implementation.** Replace the entire `ChatTab` function (lines 282–415) with this. It calls `api.chatSuggest` in `"ask"` mode, persists history per version, renders assistant prose through `parseMentions`, and shows selection chips above the composer.

```tsx
function ChatTab({
  projectId,
  modelId,
  versionId,
  selected,
  nodes,
  onNavigate,
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  selected: SelectedRef | null;
  nodes: { id: UUID; name: string; type: string; lane_id: UUID | null }[];
  onNavigate: (ref: { kind: "node" | "edge"; id: UUID }) => void;
}) {
  const sessionStore = useMemo(() => browserChatSessionStore(), []);
  const [history, setHistory] = useState<ChatTurn[]>(() => sessionStore.load(versionId));
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reload history when switching to a different version.
  useEffect(() => {
    setHistory(sessionStore.load(versionId));
  }, [versionId, sessionStore]);

  const labelById = useMemo(() => {
    const m = new Map<UUID, string>();
    for (const n of nodes) m.set(n.id, n.name);
    return m;
  }, [nodes]);

  const chips = selectionChips(selected, labelById);

  const ask = useMutation({
    mutationFn: (input: { history: ChatTurn[]; userMessage: string }) =>
      api.chatSuggest(projectId, modelId, versionId, {
        history: input.history,
        user_message: input.userMessage,
        mode: "ask",
        context_refs: selectionToContextRefs(selected),
      }),
    onSuccess: (data, vars) => {
      setHistory((curr) => {
        const next: ChatTurn[] = [
          ...curr,
          { role: "user", content: vars.userMessage },
          { role: "assistant", content: data.message },
        ];
        sessionStore.save(versionId, next);
        return next;
      });
    },
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, ask.isPending]);

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || ask.isPending) return;
    setDraft("");
    ask.mutate({ history, userMessage: trimmed });
  };

  const clearChat = () => {
    sessionStore.clear(versionId);
    setHistory([]);
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        <div className="flex items-start justify-between gap-2 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2.5">
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-indigo-700">
              POET Assistant
            </div>
            <div className="text-[11.5px] leading-relaxed text-indigo-900/80">
              Grounded in this map&apos;s claims and citations. I link the steps
              and transitions I mention — click to jump to them.
            </div>
          </div>
          {history.length > 0 && (
            <button
              onClick={clearChat}
              className="shrink-0 rounded-full border border-indigo-200 px-2 py-0.5 text-[10px] text-indigo-700 hover:bg-indigo-100"
            >
              Clear
            </button>
          )}
        </div>

        {history.map((m, i) => (
          <ChatMsg key={i} turn={m} labelById={labelById} onNavigate={onNavigate} />
        ))}

        {ask.isPending && (
          <div className="flex items-start gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-900 text-[10px] font-bold text-white">
              AI
            </div>
            <div className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: "0s" }} />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: "0.15s" }} />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: "0.3s" }} />
                <span className="ml-2 text-[11px] text-slate-500">Thinking…</span>
              </div>
            </div>
          </div>
        )}

        {ask.isError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
            {(ask.error as Error).message}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-slate-200 p-2">
        {chips.length > 0 && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Context
            </span>
            {chips.map((c) => (
              <button
                key={`${c.kind}:${c.id}`}
                onClick={() => onNavigate({ kind: c.kind as "node" | "edge", id: c.id })}
                className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-700 hover:bg-slate-100"
                title="Jump to this object"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
                {c.label}
              </button>
            ))}
          </div>
        )}
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {SUGGESTED_PROMPTS.map((s) => (
            <button
              key={s}
              onClick={() => submit(s)}
              className="rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-200"
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(draft);
              }
            }}
            rows={2}
            placeholder="Ask about any node, or describe a change…"
            className="flex-1 resize-none rounded-md border border-slate-200 px-2 py-1.5 text-xs focus:border-slate-500 focus:outline-none"
          />
          <button
            onClick={() => submit(draft)}
            disabled={!draft.trim() || ask.isPending}
            className="h-8 rounded-md bg-slate-900 px-3 text-[11px] font-semibold text-white hover:bg-slate-800 disabled:bg-slate-300"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: ChatMsg — render mentions as link chips.** Replace the `ChatMsg` function (lines 417–443) with a version that parses the assistant content:

```tsx
function ChatMsg({
  turn,
  labelById,
  onNavigate,
}: {
  turn: ChatTurn;
  labelById: Map<UUID, string>;
  onNavigate: (ref: { kind: "node" | "edge"; id: UUID }) => void;
}) {
  if (turn.role === "user") {
    return (
      <div className="flex items-start justify-end gap-2">
        <div className="max-w-[85%] rounded-lg bg-slate-900 px-3 py-2 text-[11.5px] leading-relaxed text-white">
          {turn.content}
        </div>
      </div>
    );
  }
  const segments = parseMentions(turn.content);
  return (
    <div className="flex items-start gap-2">
      <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-slate-900 text-[10px] font-bold text-white">
        AI
      </div>
      <div className="min-w-0 flex-1">
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11.5px] leading-relaxed text-slate-800">
          {segments.map((seg, i) => {
            if (seg.type === "text") {
              return <span key={i} className="whitespace-pre-wrap">{seg.value}</span>;
            }
            const isNav = seg.kind === "node" || seg.kind === "edge";
            const label =
              seg.kind === "node"
                ? labelById.get(seg.id) ?? "step"
                : seg.kind === "edge"
                  ? "transition"
                  : seg.kind === "claim"
                    ? "source"
                    : "lane";
            if (!isNav) {
              return (
                <span
                  key={i}
                  className="mx-0.5 inline-flex items-center rounded border border-slate-300 bg-white px-1 text-[10.5px] text-slate-600"
                >
                  {label}
                </span>
              );
            }
            return (
              <button
                key={i}
                onClick={() => onNavigate({ kind: seg.kind as "node" | "edge", id: seg.id })}
                className="mx-0.5 inline-flex items-center rounded border border-indigo-200 bg-indigo-50 px-1 text-[10.5px] font-medium text-indigo-700 hover:bg-indigo-100"
                title="Jump to this object"
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add imports** at the top of `right-panel.tsx`. Ensure these are imported (add what's missing):
```tsx
import { useMemo } from "react"; // (merge into the existing React import)
import { parseMentions } from "./mentions";
import { selectionChips, selectionToContextRefs } from "./chat-context";
import { browserChatSessionStore } from "./chat-session";
```
(`useState`, `useEffect`, `useRef` are already imported; `useMutation` and `api` are already imported; `ChatTurn`, `UUID`, `SelectedRef` are already in scope.)

- [ ] **Step 6: Typecheck + lint-build**

Run: `cd /home/ewise/projects/processreengineering && npx tsc --noEmit && npm run build`
Expected: typecheck clean; Next build succeeds. (`npm run build` runs ESLint + type checking across the app and is the closest thing to CI for the frontend.)

- [ ] **Step 7: Commit**

```bash
git add src/components/canvas/right-panel.tsx "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx"
git commit -m "feat(chat-suggest): chat tab on chat-suggest with mention links + context chips + session"
```

---

## Task 9: Manual verification (run the app)

No automated end-to-end here (no browser test harness). Verify by running the app.

- [ ] **Step 1: Start the app**

```bash
cd /home/ewise/projects/processreengineering && ./run-local.sh start
```
(If the `poet-postgres` container name conflicts because it's already running, Postgres is fine — start just the servers: run migrations then `uvicorn main:app --port 8000` from `backend/` with the venv, and `npm run dev -- --port 3000`. `ANTHROPIC_API_KEY` must be set in `backend/.env` for real answers.)

- [ ] **Step 2: Verify in the browser** at `http://localhost:3000`:
  - Open a project → a map version with claims.
  - Select a node → its chip appears above the composer under "Context"; clicking the chip recenters + flashes that node.
  - Ask "What does this step do?" → the answer renders; any `[[node:…]]`/`[[edge:…]]` mention appears as an indigo link chip; clicking it teleports + flashes the object.
  - Reload-free tab switching (e.g. to Issues and back) keeps the chat history; a hard browser reload clears it.
  - "Clear" empties the thread.

- [ ] **Step 3: Stop the app**

```bash
cd /home/ewise/projects/processreengineering && ./run-local.sh stop
```

---

## Self-review notes (reconciled)

- **Spec coverage (Phase 2 scope):** chat panel rebuilt on chat-suggest (T8); Ask mode (T1/T2/T8); selection chips → context (T4/T8); mentions-as-hyperlinks (T1 backend resolve + T3 parser + T8 render); teleport-to-object incl. step-through-able navigation per-object (T6/T7 + click each mention); ephemeral session persistence (T5/T8). Suggest toggle + cards + apply/undo/staleness/grouping/dimming are explicitly **Phase 3** — not gaps.
- **Type consistency:** `navigateTo({kind,id})` on the handle (T7) matches `onNavigate` prop (T8) and the page wiring (T8); `parseMentions` segment shape (T3) matches `ChatMsg` consumption (T8); `selectionToContextRefs`/`selectionChips` signatures (T4) match `ChatTab` usage (T8); `browserChatSessionStore().load/save/clear` (T5) match `ChatTab`. Mention wire format `[[kind:uuid]]` is produced by the backend (T1) and consumed by the parser (T3) identically.
- **No new lint job assumption:** frontend "CI" proxy is `npm run build` (ESLint + tsc), used in T8.
- **Backend regression safety:** `_resolve_mention_refs` only rewrites bracketed refs; Phase 1 tests that assert plain-string message equality stay green.
