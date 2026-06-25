# Chat-Suggest Phase 2.1a: Chat Polish (non-streaming) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the Phase 2 Ask-mode chat: real markdown rendering, clickable source links, multi-object grounding, edges removed from chat, optimistic prompt echo, a Sparkles avatar, context-tab fixes (no overlap, per-chip remove, post-send indicator), plus two canvas tweaks (Properties pill instead of auto-open; Space / middle-mouse pan with a hand icon).

**Architecture:** Backend grounds on *all* attached context nodes and stops emitting edge refs; it attaches per-claim `mention_sources` (ViewerTarget data) so claim mentions open the Source Viewer. The frontend converts `[[kind:uuid]]` mentions into custom `poet://` markdown links and renders the whole message through `react-markdown` with a custom link component (node → teleport, claim → open source). Chat context is node-only. Canvas gains Space/middle-mouse panning and a node-anchored Properties pill.

**Tech Stack:** Next.js + React + TanStack Query, Tailwind, **react-markdown (new dep)**, Vitest (node env, pure-logic tests only), FastAPI + anthropic SDK.

---

## Context for the engineer

Phase 2 (Ask-mode chat with mention links, context chips, session persistence) is on branch **`chat-suggest-phase2`** (this plan continues on it). Streaming, the Thinking/activity display, and play/pause are **Phase 2.1b** — NOT in this plan.

**Decisions baked in:**
- **Edges are not chat objects.** Selecting an edge contributes nothing to context; no edge chips; the model references transitions via their endpoint **node** links. (Edges remain selectable on the canvas for editing.)
- Markdown renders via **react-markdown**; mentions are pre-converted to `poet://node/<uuid>` and `poet://claim/<uuid>` markdown links and intercepted by a custom link renderer.

**Test conventions:** Frontend — Vitest node env, `src/**/*.test.ts` only (pure logic). `.tsx`/client verified by `npx tsc --noEmit` + `npm run build`. Single test: `npx vitest run <file>`. Backend — `cd backend && source .venv/bin/activate && pytest <file> -v`; full suite `pytest -q`. `ANTHROPIC_API_KEY` not needed (client faked).

**Key files & signatures (from exploration):**
- `ViewerTarget` (`src/lib/types.ts:574`): `{ inputId: UUID; inputName: string; sectionRef: Record<string, unknown> | null; quote: string | null }`.
- `map_context.py` builds `quote_by_claim` + `source_by_claim` (input *name*) from `ClaimCitation` joined to `Input`. It does NOT currently capture `input_id` or `section_ref` — Task 2 adds them.
- `map_chat_suggest.py`: `MENTION_INSTRUCTIONS`, `run_chat_suggest(*, history, user_message, map_context_text, mode)`; ask branch calls `chat(..., extra_instructions=MENTION_INSTRUCTIONS)`.
- `process_maps.py`: `chat_suggest` endpoint computes `selected_node_id = next((r.id for r in payload.context_refs if r.kind == RefKind.NODE), None)` (THIS is bug #13 — only the first node is grounded); `_resolve_mention_refs`, `_resolve_refs`; `MapContext.{node_ref_by_id, node_ref_to_id, claim_ref_to_id, ...}`.
- `right-panel.tsx`: `ChatTab` (composer + context tab) and `ChatMsg` (renders assistant text via `parseMentions`). `RightPanel` already receives `onOpenSource: (t: ViewerTarget) => void` and `nodes`.
- `chat-context.ts`: `selectionToContextRefs(SelectedObject[])`, `selectionChips(SelectedObject[], labelById)`, `SelectedObject = {id, kind:"node"|"edge", name?}`.
- `bpmn-canvas.tsx`: `tool` state (`"select"|"pan"|"connect"`), `drag.type==="pan"` path, keydown handler (~678–737), node mousedown (~904), bg mousedown (~1038), `BpmnCanvasHandle`, `toggleSelection(id)` (~228), `clearSelection` (~231).
- `floating-toolbar.tsx`: `CanvasTool` type; the pan button uses a custom inline SVG (~74–82) — swap to lucide `Hand`.
- `page.tsx`: `propertiesCollapsed`/`setPropertiesCollapsed` (~70); `handleSelectionChange` auto-opens via `setPropertiesCollapsed(false)` (~161); `chatSelected` memo; `<RightPanel onClearSelection=.../>`.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `backend/app/services/map_chat_suggest.py` | mention prompt: drop edges, no parenthetical, add focus note | Modify |
| `backend/app/api/v2/process_maps.py` | ground on all context nodes; attach `mention_sources` | Modify |
| `backend/app/services/map_context.py` | expose per-claim source target (input_id, section_ref, quote, name) | Modify |
| `backend/app/schemas/version_chat_suggest.py` | `MentionSource` + `mention_sources` on response | Modify |
| `backend/tests/test_chat_suggest.py` | tests | Modify |
| `src/lib/types.ts` | `MentionSource`, `mention_sources` on `ChatSuggestResponse` | Modify |
| `package.json` | add `react-markdown` | Modify |
| `src/components/canvas/mention-markdown.ts` | pure: mentions → `poet://` markdown links | Create |
| `src/components/canvas/mention-markdown.test.ts` | tests | Create |
| `src/components/canvas/chat-context.ts` | node-only context (drop edges) | Modify |
| `src/components/canvas/chat-context.test.ts` | tests | Modify |
| `src/components/canvas/right-panel.tsx` | markdown ChatMsg, source links, optimistic prompt, avatar, tab fixes, per-chip remove, post-send indicator | Modify |
| `src/components/canvas/bpmn-canvas.tsx` | Space/middle-mouse pan; `deselectId`; Properties-pill anchor | Modify |
| `src/components/canvas/floating-toolbar.tsx` | hand icon | Modify |
| `src/app/(canvas)/.../page.tsx` | node-only chatSelected; stop auto-open Properties; wire pill + per-chip remove | Modify |

---

## Task 1: Backend — ground on all context nodes, drop edge/parenthetical from prompt

Fixes **#13** (multi-context ignored), **#7** (duplicate "(nickname)"), **#10** (edge refs in prose).

**Files:** `backend/app/services/map_chat_suggest.py`, `backend/app/api/v2/process_maps.py`, `backend/tests/test_chat_suggest.py`

- [ ] **Step 1: Failing tests** — append to `backend/tests/test_chat_suggest.py`:

```python
def test_mention_instructions_drop_edges_and_parenthetical():
    from app.services.map_chat_suggest import MENTION_INSTRUCTIONS
    low = MENTION_INSTRUCTIONS.lower()
    assert "[[e" not in low                      # no edge-ref instruction
    assert "parenthes" in low or "do not repeat" in low  # tells model not to restate name


def test_chat_suggest_focuses_on_all_context_nodes(db):
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest, ObjectRef
    project, version, n1, claim = _seed(db)
    # second node so we can attach two
    from app.models.process import ProcessNode
    n2 = ProcessNode(version_id=version.id, lane_id=n1.lane_id, type="task", name="Approve", position={}, properties={})
    db.add(n2); db.commit()
    captured = {}

    def fake_service(*, history, user_message, map_context_text, mode):
        captured["ctx"] = map_context_text
        return ("ok", [])

    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_suggest", fake_service)
        pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(
                user_message="compare these", mode="ask",
                context_refs=[ObjectRef(kind="node", id=n1.id), ObjectRef(kind="node", id=n2.id)],
            ),
            db=db,
        )
    # The focus line names BOTH node refs, not just the first.
    assert "N1" in captured["ctx"] and "N2" in captured["ctx"]
    assert "focus" in captured["ctx"].lower()
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd /home/ewise/projects/processreengineering/backend && source .venv/bin/activate && pytest tests/test_chat_suggest.py -k "mention_instructions_drop or focuses_on_all" -v`

- [ ] **Step 3a: Update `MENTION_INSTRUCTIONS`** in `map_chat_suggest.py` to drop edges + forbid the parenthetical:

```python
MENTION_INSTRUCTIONS = (
    "When you reference a specific step or a source claim, wrap its short ref in "
    "double brackets so the UI can turn it into a link: a node (step) as [[N3]], a "
    "claim as [[C1]]. Refer to a transition by linking its endpoint STEPS — e.g. "
    "\"from [[N1]] to [[N2]]\" — never emit an edge ref. Use the refs exactly as they "
    "appear in the map context below; never invent one. Do NOT repeat the element's "
    "name in parentheses after a bracketed ref — the link already shows its name."
)
```

- [ ] **Step 3b: Ground on all context nodes** in `process_maps.py` `chat_suggest`. After `ctx = assemble_map_context(...)`, build a focus note from every attached node ref and append it to the map context text passed to the service. Replace the body between `ctx = assemble_map_context(...)` and the `run_chat_suggest(...)` call:

```python
    selected_node_id = next(
        (r.id for r in payload.context_refs if r.kind == RefKind.NODE), None
    )
    ctx = assemble_map_context(db, version, selected_node_id=selected_node_id)

    # Ground the model on EVERY attached node (not just the first). Reference
    # them by the same short refs the map context uses.
    focus_refs = [
        ctx.node_ref_by_id[r.id]
        for r in payload.context_refs
        if r.kind == RefKind.NODE and r.id in ctx.node_ref_by_id
    ]
    map_text = ctx.text
    if focus_refs:
        map_text += (
            "\n\nThe user has attached these steps as the focus of the question; "
            "address all of them: " + ", ".join(focus_refs)
        )

    history = [SuggestChatTurn(role=t.role, content=t.content) for t in payload.history]
    try:
        message, raw_suggestions = run_chat_suggest(
            history=history,
            user_message=payload.user_message,
            map_context_text=map_text,
            mode=payload.mode,
        )
```

(Leave the rest of the endpoint — suggestion building + `_resolve_mention_refs(message, ctx)` return — unchanged.)

- [ ] **Step 4: Run, verify PASS + full suite**

Run: `pytest tests/test_chat_suggest.py -v && pytest -q` → all green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/map_chat_suggest.py backend/app/api/v2/process_maps.py backend/tests/test_chat_suggest.py
git commit -m "feat(chat): ground on all context nodes; drop edge refs + parenthetical from prompt"
```

---

## Task 2: Backend — per-claim source targets for clickable source links

Fixes **#6** (source chips show doc name + open viewer). Adds `mention_sources` to the response: one `ViewerTarget`-shaped entry per cited claim that appears in the message.

**Files:** `backend/app/services/map_context.py`, `backend/app/schemas/version_chat_suggest.py`, `backend/app/api/v2/process_maps.py`, `backend/tests/test_chat_suggest.py`

- [ ] **Step 1: Failing test** — append to `backend/tests/test_chat_suggest.py`:

```python
def test_chat_suggest_attaches_mention_sources_for_cited_claims(db):
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    from app.models.input import Chunk, DocumentSection, Input
    from app.models.claim import ClaimCitation
    project, version, n1, claim = _seed(db)
    # Give the claim a citation backed by a real input/section/chunk.
    inp = Input(project_id=project.id, name="SOP.pdf", kind="document", status="ready")
    db.add(inp); db.flush()
    sec = DocumentSection(input_id=inp.id, title="S1", order_index=0); db.add(sec); db.flush()
    chunk = Chunk(section_id=sec.id, text="...", order_index=0); db.add(chunk); db.flush()
    db.add(ClaimCitation(claim_id=claim.id, chunk_id=chunk.id, quote="the clerk receives it"))
    db.commit()

    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_suggest", lambda **k: ("Per [[C1]] this is logged.", []))
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="x", mode="ask"), db=db)
    assert f"[[claim:{claim.id}]]" in resp.message      # claim ref resolved
    src = next(s for s in resp.mention_sources if s.claim_id == claim.id)
    assert src.input_id == inp.id and src.input_name == "SOP.pdf"
    assert src.quote == "the clerk receives it"
```

(Adjust the `Input`/`DocumentSection`/`Chunk`/`ClaimCitation` constructor kwargs to match the real models in `backend/app/models/input.py` and `claim.py` if they differ — read them; keep the assertions.)

- [ ] **Step 2: Run, verify FAIL** (`mention_sources` missing on response).

- [ ] **Step 3a: Expose per-claim source target in `map_context.py`.** Where `quote_by_claim`/`source_by_claim` are built from the `ClaimCitation`→`Chunk`→`DocumentSection`→`Input` query, also capture the input id and section ref. Add to the `cit_rows` select: `Input.id`, `DocumentSection.section_ref` (or the section identifier the viewer uses — match `ViewerTarget.sectionRef`; if sections have no such field, use `None`). Build:

```python
    source_target_by_claim: dict[UUID, dict] = {}
    ...
    for claim_id, quote, input_id, input_name, section_ref in cit_rows:
        if claim_id not in source_target_by_claim:
            source_target_by_claim[claim_id] = {
                "input_id": input_id,
                "input_name": input_name,
                "section_ref": section_ref,
                "quote": quote,
            }
```

Add `source_target_by_claim: dict[UUID, dict]` to the `MapContext` dataclass and return it. (Keep the existing `quote_by_claim`/`source_by_claim` for the text rendering.)

- [ ] **Step 3b: Schema** — in `version_chat_suggest.py` add:

```python
class MentionSource(BaseModel):
    claim_id: UUID
    input_id: UUID
    input_name: str
    section_ref: dict | None = None
    quote: str | None = None
```

and add to `ChatSuggestResponse`: `mention_sources: list[MentionSource] = Field(default_factory=list)`.

- [ ] **Step 3c: Build `mention_sources` in the endpoint.** In `chat_suggest`, after computing the resolved message, collect claim ids that appear as `[[claim:<uuid>]]` and map them via `ctx.source_target_by_claim`:

```python
    resolved = _resolve_mention_refs(message, ctx)
    cited = set(re.findall(r"\[\[claim:([0-9a-fA-F-]+)\]\]", resolved))
    mention_sources = []
    for cid_str in cited:
        cid = UUID(cid_str)
        tgt = ctx.source_target_by_claim.get(cid)
        if tgt:
            mention_sources.append(MentionSource(claim_id=cid, **tgt))
    return ChatSuggestResponse(
        message=resolved, suggestions=suggestions, mention_sources=mention_sources
    )
```

(Import `MentionSource`; `re` is already imported from Phase-2 Task 1.)

- [ ] **Step 4: Run, verify PASS + full suite.**

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/map_context.py backend/app/schemas/version_chat_suggest.py backend/app/api/v2/process_maps.py backend/tests/test_chat_suggest.py
git commit -m "feat(chat): attach per-claim source targets (mention_sources) for clickable sources"
```

---

## Task 3: Frontend types + react-markdown dependency

**Files:** `src/lib/types.ts`, `package.json`

- [ ] **Step 1: Types** — in `src/lib/types.ts`, add and extend:

```typescript
export interface MentionSource {
  claim_id: UUID;
  input_id: UUID;
  input_name: string;
  section_ref: Record<string, unknown> | null;
  quote: string | null;
}
```

and add `mention_sources: MentionSource[];` to `ChatSuggestResponse`.

- [ ] **Step 2: Install react-markdown**

Run: `cd /home/ewise/projects/processreengineering && npm install react-markdown@^9`
Expected: adds to dependencies + lockfile.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts package.json package-lock.json
git commit -m "feat(chat): MentionSource type + react-markdown dependency"
```

---

## Task 4: `mention-markdown.ts` — convert mentions to poet:// markdown links

Pure helper. Fixes the rendering half of **#5/#6/#7/#10**.

**Files:** Create `src/components/canvas/mention-markdown.ts` + `.test.ts`

- [ ] **Step 1: Failing test** — `src/components/canvas/mention-markdown.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mentionsToMarkdown } from "./mention-markdown";

const N = "11111111-1111-1111-1111-111111111111";
const C = "33333333-3333-3333-3333-333333333333";

describe("mentionsToMarkdown", () => {
  const labels = new Map([[N, "Review Invoice"]]);
  const sources = new Map([[C, "SOP.pdf"]]);

  it("passes through plain markdown untouched", () => {
    expect(mentionsToMarkdown("**bold** and a list", labels, sources)).toBe("**bold** and a list");
  });
  it("turns a node mention into a poet node link with its label", () => {
    expect(mentionsToMarkdown(`See [[node:${N}]].`, labels, sources)).toBe(
      `See [Review Invoice](poet://node/${N}).`
    );
  });
  it("turns a claim mention into a poet claim link with the doc name", () => {
    expect(mentionsToMarkdown(`per [[claim:${C}]]`, labels, sources)).toBe(
      `per [SOP.pdf](poet://claim/${C})`
    );
  });
  it("falls back to 'step'/'source' when not found", () => {
    expect(mentionsToMarkdown(`[[node:x]] [[claim:y]]`, labels, sources)).toBe(
      `[step](poet://node/x) [source](poet://claim/y)`
    );
  });
  it("renders any stray edge mention as plain endpoint-less text (edges dropped)", () => {
    expect(mentionsToMarkdown(`[[edge:z]] gone`, labels, sources)).toBe("gone");
  });
  it("escapes ] in a label so the link stays valid", () => {
    const l = new Map([[N, "Step [final]"]]);
    expect(mentionsToMarkdown(`[[node:${N}]]`, l, sources)).toBe(
      `[Step [final\\]](poet://node/${N})`
    );
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** `src/components/canvas/mention-markdown.ts`:

```typescript
import type { UUID } from "@/lib/types";

const MENTION_RE = /\[\[(node|edge|claim|lane):([^\]]+)\]\]\s?/g;

/** Convert backend [[kind:uuid]] mentions into custom poet:// markdown links so
 * the message can render through react-markdown with one custom link renderer.
 * Node → poet://node/<id> (label = step name), claim → poet://claim/<id>
 * (label = source doc name). Edges/lanes are dropped to plain text (edges are
 * not chat objects). The rest of the string is left as-is for markdown. */
export function mentionsToMarkdown(
  text: string,
  labelById: Map<UUID, string>,
  sourceNameByClaimId: Map<UUID, string>
): string {
  return text.replace(MENTION_RE, (_m, kind: string, id: string, offset: number, full: string) => {
    const trailing = /\s$/.test(_m) ? " " : "";
    if (kind === "node") {
      const label = (labelById.get(id) ?? "step").replace(/\]/g, "\\]");
      return `[${label}](poet://node/${id})${trailing}`;
    }
    if (kind === "claim") {
      const label = (sourceNameByClaimId.get(id) ?? "source").replace(/\]/g, "\\]");
      return `[${label}](poet://claim/${id})${trailing}`;
    }
    // edge / lane: not a chat object — drop the token, keep surrounding prose tidy.
    return trailing;
  });
}
```

(Note: the test `"[[edge:z]] gone"` → `"gone"` works because the regex consumes the trailing space after the token.)

- [ ] **Step 4: Run, verify PASS (6) + `npx tsc --noEmit`.**

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/mention-markdown.ts src/components/canvas/mention-markdown.test.ts
git commit -m "feat(chat): mentionsToMarkdown converts mentions to poet:// markdown links"
```

---

## Task 5: `chat-context.ts` — node-only context (drop edges)

Fixes **#10** (context side).

**Files:** `src/components/canvas/chat-context.ts`, `chat-context.test.ts`

- [ ] **Step 1: Update the test** — replace the edge-keeping cases in `chat-context.test.ts` so edges are filtered out:

```typescript
import { describe, it, expect } from "vitest";
import { selectionToContextRefs, selectionChips } from "./chat-context";

const NODE = { id: "n1", kind: "node" as const, name: "Review Invoice" };
const EDGE = { id: "e1", kind: "edge" as const };

describe("selectionToContextRefs", () => {
  it("returns empty for no selection", () => {
    expect(selectionToContextRefs([])).toEqual([]);
  });
  it("keeps only node refs (edges are not chat context)", () => {
    expect(selectionToContextRefs([NODE, EDGE])).toEqual([{ kind: "node", id: "n1" }]);
  });
});

describe("selectionChips", () => {
  const labelById = new Map([["n1", "Review Invoice"]]);
  it("returns empty for no selection", () => {
    expect(selectionChips([], labelById)).toEqual([]);
  });
  it("shows node chips only, labeled from the map", () => {
    expect(selectionChips([NODE, EDGE], labelById)).toEqual([
      { kind: "node", id: "n1", label: "Review Invoice" },
    ]);
  });
  it("falls back to the node's own name when not in the label map", () => {
    expect(selectionChips([{ id: "n9", kind: "node", name: "Orphan" }], new Map())).toEqual([
      { kind: "node", id: "n9", label: "Orphan" },
    ]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** (current helpers still include edges).

- [ ] **Step 3: Implement** — in `chat-context.ts`, filter to nodes in both helpers and narrow `ContextChip.kind`/return to node:

```typescript
export function selectionToContextRefs(selected: SelectedObject[]): ObjectRef[] {
  return selected.filter((s) => s.kind === "node").map((s) => ({ kind: "node" as const, id: s.id }));
}

export function selectionChips(
  selected: SelectedObject[],
  labelById: Map<UUID, string>
): ContextChip[] {
  return selected
    .filter((s) => s.kind === "node")
    .map((s) => ({ kind: "node" as const, id: s.id, label: labelById.get(s.id) ?? s.name ?? "step" }));
}
```

Change `ContextChip.kind` to `"node"`. Keep `SelectedObject` as-is (canvas still selects edges; we just ignore them here).

- [ ] **Step 4: Run, verify PASS + `npx tsc --noEmit`.** (tsc may flag the chip onClick cast in right-panel — Task 6 updates that file; if tsc fails only there, proceed to Task 6 and re-run.)

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/chat-context.ts src/components/canvas/chat-context.test.ts
git commit -m "feat(chat): chat context is node-only (edges dropped)"
```

---

## Task 6: ChatMsg markdown + source links; ChatTab optimistic prompt, avatar, tab fixes, per-chip remove, post-send indicator

Fixes **#1, #3, #5, #6, #7, #8, #11, #12**. This is the chat UI bundle. No unit test (JSX); verified by `tsc` + `npm run build` + browser. Touches `right-panel.tsx`, plus `bpmn-canvas.tsx` (a `deselectId` handle) and `page.tsx` (wiring).

- [ ] **Step 1: Canvas `deselectId` handle (for #12).** In `bpmn-canvas.tsx`, add to `BpmnCanvasHandle` after `clearSelection`:
```typescript
  /** Remove a single object id from the current selection (chat context ✕). */
  deselectId: (id: UUID) => void;
```
Add to the `useImperativeHandle` value (there is an internal `toggleSelection`/`setSelectedIds`; use a set delete):
```typescript
      deselectId: (id) =>
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        }),
```
Add nothing new to deps (only uses the `setSelectedIds` state setter, which is stable).

- [ ] **Step 2: page.tsx wiring.** Pass two new props to `<RightPanel>`:
```tsx
            mentionSourcesUnused={undefined}
```
— ignore that; instead add:
```tsx
            onRemoveContext={(id) => canvasRef.current?.deselectId(id)}
```
(next to `onClearSelection`). The `onOpenSource` prop already exists on RightPanel and is passed; ensure ChatTab receives it (Step 4).

- [ ] **Step 3: RightPanel forwards new props to ChatTab.** Add to RightPanel props type + destructure: `onRemoveContext: (id: UUID) => void;`. In the `<ChatTab .../>` render add `onRemoveContext={onRemoveContext}` and `onOpenSource={onOpenSource}`.

- [ ] **Step 4: Rewrite `ChatMsg`** in `right-panel.tsx` to render markdown with custom links. Replace the whole `ChatMsg` function with:

```tsx
import ReactMarkdown from "react-markdown";
// ^ add to the import block at the top of the file (not inside the function)

function ChatMsg({
  turn,
  labelById,
  sourceNameByClaim,
  sourceTargetByClaim,
  onNavigate,
  onOpenSource,
  contextNote,
}: {
  turn: ChatTurn;
  labelById: Map<UUID, string>;
  sourceNameByClaim: Map<UUID, string>;
  sourceTargetByClaim: Map<UUID, ViewerTarget>;
  onNavigate: (ref: { kind: "node" | "edge"; id: UUID }) => void;
  onOpenSource: (t: ViewerTarget) => void;
  contextNote?: string;
}) {
  if (turn.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-lg bg-slate-900 px-3 py-2 text-[11.5px] leading-relaxed text-white">
          {turn.content}
        </div>
        {contextNote && (
          <div className="text-[9.5px] text-slate-400">Context: {contextNote}</div>
        )}
      </div>
    );
  }
  const md = mentionsToMarkdown(turn.content, labelById, sourceNameByClaim);
  return (
    <div className="flex items-start gap-2">
      <Sparkles size={16} className="mt-1 flex-shrink-0 text-indigo-500" />
      <div className="min-w-0 flex-1">
        <div className="poet-chat-md rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11.5px] leading-relaxed text-slate-800">
          <ReactMarkdown
            components={{
              a: ({ href, children }) => {
                const m = /^poet:\/\/(node|claim)\/(.+)$/.exec(href ?? "");
                if (m && m[1] === "node") {
                  const id = m[2];
                  return (
                    <button
                      onClick={() => onNavigate({ kind: "node", id })}
                      className="mx-0.5 inline rounded border border-indigo-200 bg-indigo-50 px-1 font-medium text-indigo-700 hover:bg-indigo-100"
                      title="Jump to this step"
                    >
                      {children}
                    </button>
                  );
                }
                if (m && m[1] === "claim") {
                  const id = m[2];
                  const tgt = sourceTargetByClaim.get(id);
                  return (
                    <button
                      onClick={() => tgt && onOpenSource(tgt)}
                      className="mx-0.5 inline rounded border border-slate-300 bg-white px-1 text-slate-600 hover:bg-slate-100"
                      title={tgt ? `Open ${tgt.inputName}` : "Source"}
                    >
                      {children}
                    </button>
                  );
                }
                return <span>{children}</span>;
              },
            }}
          >
            {md}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
```

Add minimal markdown spacing in `src/globals.css` (so paragraphs/lists/hr render sanely in the tight bubble):
```css
.poet-chat-md > * + * { margin-top: 0.5rem; }
.poet-chat-md ul { list-style: disc; padding-left: 1.1rem; }
.poet-chat-md ol { list-style: decimal; padding-left: 1.2rem; }
.poet-chat-md strong { font-weight: 600; }
.poet-chat-md hr { margin: 0.6rem 0; border-color: rgb(226 232 240); }
.poet-chat-md h1, .poet-chat-md h2, .poet-chat-md h3 { font-weight: 600; }
```

- [ ] **Step 5: ChatTab — optimistic prompt (#1), avatar/import, tab fixes (#8), per-chip remove (#12), post-send context note (#11), source maps for ChatMsg.** Apply these edits inside `ChatTab`:

(a) Accept new props in the `ChatTab` signature: add `onRemoveContext: (id: UUID) => void;` and `onOpenSource: (t: ViewerTarget) => void;` (import `ViewerTarget` type at top of file if not present).

(b) Hold the per-message context note + the latest response's source maps. Change `history` items to also carry an optional context label; simplest: keep a parallel state. Replace the message state with a richer turn type local to ChatTab:

```tsx
  type ChatItem = ChatTurn & { contextNote?: string };
  const [history, setHistory] = useState<ChatItem[]>(() => sessionStore.load(versionId) as ChatItem[]);
  const [sourceTargetByClaim, setSourceTargetByClaim] = useState<Map<UUID, ViewerTarget>>(new Map());
```

(c) `sourceNameByClaim` derived from `sourceTargetByClaim`:
```tsx
  const sourceNameByClaim = useMemo(() => {
    const m = new Map<UUID, string>();
    sourceTargetByClaim.forEach((t, cid) => m.set(cid, t.inputName));
    return m;
  }, [sourceTargetByClaim]);
```

(d) Optimistic submit (#1) + post-send: hide the context tab by clearing selection after capturing its labels, and tag the user turn with the context note. Replace `submit` + the mutation `onSuccess`:

```tsx
  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || ask.isPending) return;
    const note = chips.length ? chips.map((c) => c.label).join(", ") : undefined;
    setDraft("");
    setHistory((curr) => [...curr, { role: "user", content: trimmed, contextNote: note }]);
    ask.mutate({ history, userMessage: trimmed });
    onClearSelection(); // #11: tab slides away once the prompt is sent
  };
```

```tsx
    onSuccess: (data, vars) => {
      const next: ChatItem[] = [
        ...vars.history,
        { role: "user", content: vars.userMessage, contextNote: vars.note },
        { role: "assistant", content: data.message },
      ];
      sessionStore.save(versionId, next);
      setHistory(next);
      const sm = new Map<UUID, ViewerTarget>();
      for (const s of data.mention_sources) {
        sm.set(s.claim_id, { inputId: s.input_id, inputName: s.input_name, sectionRef: s.section_ref, quote: s.quote });
      }
      setSourceTargetByClaim((prev) => new Map([...prev, ...sm]));
    },
```

The mutation input must carry `note` so `onSuccess` can tag the persisted user turn (the optimistic one above is replaced by `next`): change `mutationFn` input type to `{ history: ChatItem[]; userMessage: string; note?: string }` and call `ask.mutate({ history, userMessage: trimmed, note })`. (Pass the pre-send `history` snapshot, not the optimistic one, so the persisted list isn't doubled.)

(e) Render messages with the new props + post-send note:
```tsx
        {history.map((m, i) => (
          <ChatMsg
            key={i}
            turn={m}
            contextNote={m.contextNote}
            labelById={labelById}
            sourceNameByClaim={sourceNameByClaim}
            sourceTargetByClaim={sourceTargetByClaim}
            onNavigate={onNavigate}
            onOpenSource={onOpenSource}
          />
        ))}
```

(f) #8 — stop the slide-up tab covering messages: give the scroll area bottom padding when chips are present. On the messages scroll `div` add `style={{ paddingBottom: chips.length ? 44 : undefined }}`.

(g) #3 — composer Sparkles avatar already handled in ChatMsg (replaced the "AI" box). No box now.

(h) #12 — per-chip hover ✕ in the context tab: wrap each chip in a `group` and add a small ✕ that calls `onRemoveContext(c.id)`. Replace the chip button block in the context tab with:
```tsx
              {chips.map((c) => (
                <span key={`${c.kind}:${c.id}`} className="group relative inline-flex">
                  <button
                    onClick={() => onNavigate({ kind: c.kind, id: c.id })}
                    className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white py-0.5 pl-2 pr-5 text-[10px] text-slate-700 hover:bg-slate-100"
                    title="Jump to this step"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
                    {c.label}
                  </button>
                  <button
                    onClick={() => onRemoveContext(c.id)}
                    title="Remove from context"
                    className="absolute right-0.5 top-1/2 hidden -translate-y-1/2 rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 group-hover:block"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
```
(Keep the trailing clear-all ✕ as-is.)

- [ ] **Step 6: Verify** — `npx tsc --noEmit` (clean) and `npm run build` (success). Then `npm run test` (existing 77+ pass).

- [ ] **Step 7: Commit**

```bash
git add src/components/canvas/right-panel.tsx src/components/canvas/bpmn-canvas.tsx \
        "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx" src/globals.css
git commit -m "feat(chat): markdown render + source links, optimistic prompt, sparkles avatar, tab fixes, per-chip remove, context note"
```

---

## Task 7: page.tsx — node-only chatSelected

Fixes **#10** (selecting an edge shouldn't create context). Small, but separate so the chat-context filter and the page agree.

**Files:** `src/app/(canvas)/.../page.tsx`

- [ ] **Step 1:** In the `chatSelected` memo, drop the edge branches so only nodes flow to chat:
```tsx
  const chatSelected: SelectedObject[] = useMemo(() => {
    if (selected.kind === "node")
      return [{ id: selected.id, kind: "node", name: selected.name }];
    if (selected.kind === "multi") {
      const nameById = new Map((data?.nodes ?? []).map((n) => [n.id, n.name]));
      return selected.nodeIds.map((id) => ({ id, kind: "node" as const, name: nameById.get(id) }));
    }
    return [];
  }, [selected, data]);
```
(Removed the `edge` and `edgeIds` branches — edges no longer become chat context.)

- [ ] **Step 2: Verify** `npx tsc --noEmit` + `npm run build`.

- [ ] **Step 3: Commit**
```bash
git add "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx"
git commit -m "feat(chat): only nodes flow to chat context from the page"
```

---

## Task 8: Canvas — Space / middle-mouse pan + hand icon

Fixes **#9**.

**Files:** `src/components/canvas/bpmn-canvas.tsx`, `src/components/canvas/floating-toolbar.tsx`

- [ ] **Step 1: Space-hold + middle-mouse pan.** In `bpmn-canvas.tsx`:

(a) Add a ref near the other refs: `const spaceHeld = useRef(false);`

(b) In the keydown handler (the `useEffect` ~678), at the top of the handler (before the editable-guard return is fine, but Space should not pan while typing — keep it AFTER the `inEditable` guard), add:
```typescript
      if (e.code === "Space") {
        e.preventDefault();
        spaceHeld.current = true;
        return;
      }
```
Add a keyup listener in the same effect that clears it:
```typescript
    const upHandler = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceHeld.current = false;
    };
    document.addEventListener("keyup", upHandler);
```
and remove it in the cleanup.

(c) In the SVG background mousedown handler (~1038) and node mousedown (~904), start a pan when `spaceHeld.current` or middle button. At the very top of each handler:
```typescript
    if (e.button === 1 || spaceHeld.current) {
      e.preventDefault();
      setDrag({
        type: "pan",
        startX: e.clientX,
        startY: e.clientY,
        tx0: viewportRef.current.tx,
        ty0: viewportRef.current.ty,
      });
      return;
    }
```
(Middle-click default is autoscroll — `preventDefault` blocks it. The existing `drag.type==="pan"` motion handler already moves the viewport.)

- [ ] **Step 2: Hand icon.** In `floating-toolbar.tsx`, import `Hand` from lucide-react and replace the custom pan SVG (~74–82) with `<Hand size={14} />`.

- [ ] **Step 3: Verify** `npx tsc --noEmit` + `npm run build`.

- [ ] **Step 4: Commit**
```bash
git add src/components/canvas/bpmn-canvas.tsx src/components/canvas/floating-toolbar.tsx
git commit -m "feat(canvas): Space/middle-mouse pan + hand pan-tool icon"
```

---

## Task 9: Canvas — Properties pill instead of auto-open

Fixes **#4**.

**Files:** `src/app/(canvas)/.../page.tsx`, `src/components/canvas/bpmn-canvas.tsx`

- [ ] **Step 1: Stop auto-open.** In `page.tsx` `handleSelectionChange`, remove `if (s.kind === "node") setPropertiesCollapsed(false);` — and instead keep Properties collapsed by default (set the initial `useState(true)` for `propertiesCollapsed`, so it only opens on demand).

- [ ] **Step 2: Pill anchored to the selected node.** The canvas knows node positions + viewport, so render the pill there. In `bpmn-canvas.tsx`, add a prop `onOpenProperties?: () => void;` to `BpmnCanvasProps`. When exactly one node is selected and `propertiesCollapsed` is true, render a small HTML pill in the canvas's existing overlay layer (the absolutely-positioned div that wraps the SVG; if none exists, wrap the SVG in `<div className="relative h-full w-full">` and mount the pill as a sibling `absolute` element). Compute screen position from the resolved node and viewport:
```tsx
{(() => {
  if (selectedIds.size !== 1) return null;
  const id = [...selectedIds][0];
  const n = renderNodes.find((rn) => rn.id === id);
  if (!n || !onOpenProperties) return null;
  const v = viewport;
  const left = v.tx + n.x * v.scale;            // top-left of node in screen space
  const top = v.ty + n.y * v.scale - 26;        // just above the node
  return (
    <button
      onClick={onOpenProperties}
      style={{ position: "absolute", left, top, zIndex: 20 }}
      className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-700 shadow-sm hover:bg-slate-50"
    >
      Properties <ChevronRight size={11} />
    </button>
  );
})()}
```
(Import `ChevronRight` from lucide-react in this file if needed. The pill repositions automatically because `viewport`/`selectedIds` are state and trigger re-render. Only show it for single-node selections.)

- [ ] **Step 3: page wires the pill to open the panel.** Pass `onOpenProperties={() => setPropertiesCollapsed(false)}` to `<BpmnCanvas>`. Properties panel close (✕) sets it back to collapsed — pill reappears.

- [ ] **Step 4: Verify** `npx tsc --noEmit` + `npm run build`.

- [ ] **Step 5: Commit**
```bash
git add src/components/canvas/bpmn-canvas.tsx "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx"
git commit -m "feat(canvas): Properties pill on node select instead of auto-opening the panel"
```

---

## Task 10: Full verification

- [ ] Backend: `cd backend && source .venv/bin/activate && pytest -q` (all green).
- [ ] Frontend: `npx tsc --noEmit`, `npm run test` (all green), `npm run build` (success).
- [ ] Browser (run the app): markdown renders (bold, lists, `---`); node links teleport; source chips show the document name and open the Source Viewer; sending a prompt echoes it immediately and slides the context tab away, leaving a "Context: …" note; multi-select grounds the answer on all selected steps; hovering a context chip shows ✕ to remove just that one; selecting a node shows a Properties pill (panel doesn't auto-open); Space-hold and middle-mouse pan; pan tool shows a hand.

---

## Self-review notes (reconciled)

- **Coverage:** #1 (T6 optimistic), #3 (T6 Sparkles avatar), #5 (T3 dep + T4 + T6 markdown render), #6 (T2 backend sources + T6 click→viewer), #7 (T1 prompt + T4 label-only link), #8 (T6 padding), #10 (T1 prompt + T4 drop + T5 context filter + T7 page), #11 (T6 clear-on-send + context note), #12 (T6 per-chip ✕ + canvas deselectId), #13 (T1 all-nodes focus), #4 (T9), #9 (T8). #2 + #14 are Phase 2.1b (streaming), out of scope here.
- **Type consistency:** `MentionSource`(BE)↔`MentionSource`(FE)↔`mention_sources`; `mentionsToMarkdown(text, labelById, sourceNameByClaim)` used in T6; `poet://node|claim/<id>` produced by T4 and parsed by T6's `a` renderer identically; `deselectId`(handle)↔`onRemoveContext`(prop)↔page wiring; `onOpenProperties` handle prop ↔ page.
- **Edges:** dropped consistently across prompt (T1), markdown (T4), context (T5), page (T7). Canvas edge *selection* for editing is untouched.
- **Risk note:** T6 is large (chat UI). If it grows unwieldy mid-task, split ChatMsg-markdown from the ChatTab-state changes into two commits — but keep them in one task so the source-map plumbing stays coherent.
