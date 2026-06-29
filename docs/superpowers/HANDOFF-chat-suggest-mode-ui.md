# Handoff — Suggest-Mode UI (chat-suggest)

Paste this into a fresh chat to continue. The full background also lives in auto-memory `chat_suggest_phase1.md`.

## Where we are
The suggest-mode UI feature is **built and was reviewed** (8-task subagent run, commits `132f75a…c9a0252` on branch `feat/chat-suggest-mode-ui`, pushed). We're now in a **live manual-test + polish round**. There is a **large set of UNCOMMITTED working-tree changes** on top of `c9a0252` (backend + frontend) — nothing committed yet this round.

**Branch:** `feat/chat-suggest-mode-ui` (do NOT merge to main without explicit OK; use `gh --repo ewise123/processreengineering`).

**⚠️ Before committing:** strip the temporary `[DIAG-suggest]` `console.warn`/`console.error` in `src/components/canvas/chat-tab.tsx` `applyBundle`.

## Run the app (servers may already be up on :8000 / :3000)
- Backend: `cd backend && set -a && . ./.env && set +a && ./.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000` — **no --reload**, so restart after backend edits. Logs → `…/scratchpad/backend.log`. Postgres already on 5433.
- Frontend: `npm run dev -- --port 3000`.
- Test map URL: `http://localhost:3000/projects/019dd102-a016-75e2-b0b2-3068649a494c/maps/019dd45b-06d5-78f3-a1be-b20b3778a8d4/versions/019ed21f-e940-7392-9d54-91dc124eac90` (AP-invoice process, 6 lanes / 24 nodes, sources interview.txt + ap-sop.txt).
- Gates: `npm run build` (clean), `npx vitest run` (124 pass), backend `cd backend && set -a && . ./.env && set +a && ./.venv/bin/python -m pytest tests/test_chat_suggest.py -q` (33 pass).

## What's DONE this round (uncommitted)
- #2 ✨ avatar restored for cards-only replies (avatar lifted to row level in `chat-tab.tsx`; `ChatMsg` now returns only the bubble, `null` when empty).
- #5 Dismiss dims + labels the card with a **Restore** link (no longer filtered out).
- #6 A bundle shows **every** change (per-op action badge + title), not "+N more".
- **Bundle purpose summary** — backend emits `groups:[{id,summary}]` (new `propose_changes` tool param) → `ChatSuggestResponse.group_summaries` → shown atop the card.
- **Named node/claim links in title/rationale** — backend resolves `[[N3]]`/`[[C1]]` in title+rationale (`_build_suggestion` → `_resolve_mention_refs`); shared renderer `src/components/canvas/mention-view.tsx` (`MentionMarkdown`) renders them; `mention_sources` now also scans suggestion titles/rationales.
- #1 **direct→cards** — suggest prompt tuned so an imperative request emits suggestions immediately (no "Shall I apply it?").
- **422 fixes** — `src/components/canvas/chat-history.ts` `toRequestHistory` coerces empty assistant content to a placeholder AND caps history to the last 40 turns.
- **Readable API errors** — `src/lib/error-detail.ts` `formatErrorDetail` (FastAPI 422 `detail` array was rendering as "[object Object]"); wired into `src/lib/api.ts`.
- Per-bundle apply error now shown on the card + a toast (`bundleErrorById` state + `errorById` prop), and `planBundle`'s reason names the offending ref.

## #8 (apply "Failed") — FIXED (uncommitted)
The handoff's two hypotheses (stale `graphIndex`; backend leaving a short ref unresolved) were both **wrong**. Server-side reproduction (curl + a temporary `[DIAG-build]` log in the endpoint) showed the real cause:

**Root cause:** the model emits an `add_node` op but puts the new step's label in the generic **`name`** field, while `_REQUIRED_BY_KIND[ADD_NODE]` requires **`new_label`**. So `_build_suggestion` → `SuggestionOp(**)` raises `ValueError` → the add_node is **silently dropped** (the build loop discards `None` with no log). The surviving `add_edge` ops still point `from_ref`/`to_ref` at the dropped node's `tmp:1` temp_id, so on the client `planBundle` rejects the whole bundle: `node ("tmp:1") is not on the current map`.

**Fix (3 layers, all in this tree):**
1. `_build_suggestion` (`backend/app/api/v2/process_maps.py`) coalesces `name`→`new_label` for `add_node` when `new_label` is absent.
2. New `_drop_orphaned_consumers(suggestions)` (same file) prunes any suggestion consuming a `tmp:` ref with no surviving producer (fixpoint loop), wired into the endpoint right after the build loop — so a dropped producer (for **any** reason) never ships a dangling bundle to the client.
3. `propose_changes` tool schema (`map_chat_suggest.py`) now describes `new_label` (node label) vs `name` (lanes only) + a matching `SUGGEST_INSTRUCTIONS` rule, so the model fills the right field.

**Verified:** 3/3 live add+connect bundles now pass planBundle-style validation (add_node preserved with `new_label`, every ref resolves). Backend 37 tests pass (4 new in `test_chat_suggest.py`), frontend 124 pass, `npm run build` clean. The `[DIAG-suggest]` console logs in `chat-tab.tsx` `applyBundle` are now **stripped**; the backend `[DIAG-build]` log was removed.

To reproduce server-side: `POST .../chat-suggest` with `{"mode":"suggest","user_message":"Insert a new 'Manager approval' task step right after the selected step and wire it into the flow with edges.","history":[],"context_refs":[{"kind":"node","id":"<existing-node-id>"}]}` — non-deterministic; empty history often returns 0, so hammer ~15–40× (a selected node makes add+connect bundles likely). Then check each op ref against the live graph's node/edge/lane id sets (see `scratchpad/verify.py`).

## #3 (decouple chat context from canvas selection) — FIXED (uncommitted)
Root cause (Playwright-confirmed, not what was assumed): chat context was a *live mirror* of canvas selection, so any deselect (clicking empty canvas, Escape) silently emptied it before send → the request carried `context_refs: []` → the model replied "Which step would you like me to describe?". FIX: `ChatTab` now owns a `chatContext` state, synced from the `selected` prop **keyed on the set of selected ids** (not the array reference — so a post-apply graph refetch doesn't spuriously re-attach). A non-empty selection replaces it; deselecting leaves it intact. The context-tab ✕ controls now edit `chatContext` only — they no longer deselect the canvas node or close the Properties panel. Send clears `chatContext` but leaves the canvas selection alone (so Properties stays open — see #4). Removed the now-dead `onClearSelection`/`onRemoveContext` prop chains and the canvas `deselectId` handle method. User decisions baked in: **replace on new selection** + **clear after send**.

## #4 (Properties description stale after chat-apply) — FIXED (uncommitted)
The AI-edit *panel* describe already worked. The real bug: applying a `describe_node` (or relabel / move-to-lane) **chat suggestion** mutated the canvas node but the Properties panel kept its stale `selected` snapshot until reselect — because the canvas selection-emit effect only re-ran on `[selectedIds]` and read node fields from a ref. FIX (`bpmn-canvas.tsx`): added a `selectedNodeSig` memo (label|kind|type|laneId|description of the single selected node) to the emit effect deps, so editing the selected node from anywhere (chat-apply, undo/redo) re-emits a fresh selection and the panel reflects it live. Excludes position so a plain drag doesn't churn the selection. Verified end-to-end via Playwright: description "" → populated live after Apply, no reselect.

**Verification:** Playwright (headless chromium) installed in scratchpad + `drive*.mjs` scripts drive the live app (no auth gate). #3 (deselect-then-send preserves context; ✕ leaves Properties open), #4 (live panel refresh), #8 (apply works) all PASS. Gates: backend 37, frontend 124, build clean. All DIAG logs removed.

## Two suggest-mode prompt regressions — FIXED (uncommitted, backend-only)
Reported mid-session; both happen **in suggest mode** and only with a chatty conversation history (empty-history samples were clean, which had masked them). Fixed in `backend/app/services/map_chat_suggest.py` (restart uvicorn — no --reload):
1. **Restated node name after the link** — the model appended the step's name (bold heading / after a dash) right after its `[[ref]]` link. `MENTION_INSTRUCTIONS` only banned the name *in parentheses*; broadened to forbid restating the name in **any** form (heading, dash, colon, parens, quoted label) — refer to a step ONLY through its link.
2. **"Shall I apply it?" + redundant prose** — a direct command returned a full prose description plus a permission question alongside/instead of the card. `SUGGEST_INSTRUCTIONS` now: when proposing, prose MUST be empty or one short clause; never restate the proposed content (label/description/step) in prose; NEVER ask to apply/proceed/confirm; and this holds "even mid-conversation."

Verified server-side with the exact triggering histories (10/10 and 12/12: empty prose, card present, no restatement, no permission-asking) and a live Playwright multi-turn run. Questions in suggest mode still correctly return prose (with link, no restated name) and no card.

## Still PENDING
- **#7** "Walk the change" preview (step through each affected node with reasoning, or zoom-to-fit affected nodes) — **its own brainstorm** (use the brainstorming skill). #6 already covers "see what each change is."
- Then: focused commits (nothing committed yet this round), ask before PR, run `/autofix-pr` after.

## Wrap-up when done
Strip `[DIAG-suggest]`, run all gates, make a clean conventional commit (or a few focused ones), then ask the user before opening a PR. After PR, run `/autofix-pr`.
