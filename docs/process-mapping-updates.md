# Process mapping — update list

_Created 2026-06-22. Source: `docs/transcripts/Process Mapping Updates.txt` (design call, Camp + Emory). Pairs with `docs/how-it-works.md` (what runs today) and `docs/spec/process-reengineering-spec-v1.1.md` (target spec)._

This is the running task list from the call, mapped against what the codebase actually does today. Keep editing it as we knock items down.

## The headline

The call reads like a feature brainstorm, but most of the scaffolding already exists. The real near-term work is **persisting reasoning** and **wiring up models that are already defined but dead** — not greenfield building. Three models (`AuditEvent`, `AiInteraction`, `ReviewComment`) are declared in `backend/app/models/` and never imported by a single endpoint or service. The version graph, the diff engine, the claim→source provenance UI, and a per-node AI-edit flow with rationale all exist. What's missing is the connective tissue Emory kept circling: **every node and edge carrying the reason it exists, and every change carrying the reason it was made — both stored in source control and traceable back to origin.**

Items 1–5 are active near-term work. The **Parked** section at the bottom holds what Emory himself deferred behind multi-user auth ("that's like last thing", "we should hold off on that").

---

## 1. Per-object reasoning trail (the core ask)

> Emory: "every object has a history… here's the reasoning, this was first created, and then as it's edited, you see the change, the reasoning for that change… you can still trace it all the way back to the original reasoning behind why it was created." Applies to **both nodes and edges**. AI edits *and* manual edits must record a reason.

**Current state**
- `AuditEvent` (actor, action, target_type, target_id, before/after) and `AiInteraction` (prompt, response, proposed_patch, applied) exist in `backend/app/models/audit.py` — **never written or read by any endpoint** (only referenced in `models/__init__.py`).
- `ProcessSuggestion.rationale` (`models/process_inventory.py`) stores AI reasoning, but only for *pending* suggestions; once applied, the rationale isn't attached to the resulting node/edge.
- `NodeClaimLink` / `EdgeClaimLink` (`models/process.py`) link to claims but have **no rationale field**.
- AI-edit proposals (`ai_edit_node` in `app/api/v2/process_maps.py`, ~line 1441) return `rationale` + `cited_claim_ids`, but the reasoning is **discarded on apply**.

**The gap.** Nothing persists a per-object "why it exists / why it changed" history. Edges have no origin reasoning at all. Manual edits record nothing.

**Sub-tasks**
- Backend
  - [ ] Decide the storage shape: a single `change_event` table keyed by `(target_type, target_id)` is simpler than reviving both `AuditEvent` + `AiInteraction`. Record: actor (user vs AI), kind (create/relabel/describe/move/link/delete), before/after, `reason` (text), `cited_claim_ids`, `source` (manual | chat | ai_edit | reconcile | import), timestamp, version_id.
  - [ ] Capture origin reasoning at map-generation time: when the initial map is drafted from claims, write a `create` event per node *and per edge* with the reasoning the generator used.
  - [ ] Write a change event on every mutating node/edge endpoint (`update_node`, `create_edge`, `delete_edge`, `apply_proposed_step`, reconcile ops). Backfill rationale from the proposal that produced the change.
  - [ ] Require a `reason` on manual edits (API rejects a manual node/edge mutation with no reason — or defaults to a logged "no reason given" so the trail is never silently empty).
  - [ ] `GET /nodes/{id}/history` and `GET /edges/{id}/history` returning the ordered event chain back to origin.
- Frontend
  - [ ] "History" section in `properties-panel.tsx` (sits next to the existing Provenance section, ~line 353): chronological list of changes, each with reason, author (AI/human), and cited claims.
  - [ ] Manual-edit reason prompt: when a user relabels/moves/deletes by hand, capture a one-line reason (cheap inline input, not a modal wall).

**Acceptance.** Select any node or edge → see an unbroken chain from "created because X" through each edit's reason, with AI vs human attribution. No change can enter the map without a recorded reason.

---

## 2. Unified "map log"

> Camp: "we need… a map log basically where it's literally just a trail from the original map that was generated, what has been changed… we have the ability to see in the transcript where each claim came from… and the git log essentially where you can go back in time… but there isn't a good combination of both of those features into one."

**Current state.** The two halves exist but live apart:
- Version savepoints + commit-graph tree + structural diff: `version-tree.ts`, `version-diff.ts`, `RightPanel` VersionsTab; backend `diff_versions` / `copy_version` in `app/api/v2/versions.py`.
- Claim→source traceability: Provenance section in `properties-panel.tsx` + `document-viewer.tsx`.

**The gap.** No single timeline that fuses version savepoints, per-object change reasons (from item 1), and claim sources. They're three separate tabs.

**Sub-tasks**
- [ ] Define what the unified log shows: a reverse-chronological feed spanning versions *and* the change events from item 1, filterable by object, author, or source.
- [ ] Backend feed endpoint that merges version rows + change events for a model.
- [ ] New "Log" view (likely a RightPanel tab, or promote the existing VersionsTab): timeline entries link out to the affected node/edge and to the source quote.
- [ ] Cross-link: clicking a log entry focuses the object on canvas (the ReviewTab → canvas focus pattern already exists, reuse it).

**Acceptance.** One view answers "what changed since the original map, when, by whom, and why" — with each entry traceable to both its reason and its source document. **Depends on item 1.**

---

## 3. Chat-as-editor (Claude-in-Word UX)

> Emory: "if you were editing it with a chat like that and you accepted that edit, I want that exact reasoning behind that change… stored with source control." Camp on the Claude-in-Word feel: highlights exactly what it's changing, simple click to accept/replace; plus the "reasoning dropdown" and "sources for everything."

**Current state**
- Chat tab (`RightPanel` ChatTab, ~line 294) is **read-only Q&A** grounded in the map — it answers, it doesn't edit.
- Per-node AI edits (`ai-edit-panel.tsx` + `runAiEdit`) do propose changes with rationale + cited claim chips, and "suggest next step" has accept/reject (`apply_proposed_step`).

**The gap.** Chat can't propose-and-apply an edit; there's no inline "here's exactly what I'll change, click to accept" highlight; accepted edits don't persist their reasoning (overlaps item 1); no expandable "thinking" view; chat answers don't surface which claims they leaned on.

**Sub-tasks**
- [ ] Let chat return structured edit proposals (reuse the `ai_edit_node` proposal shape), not just prose.
- [ ] Inline accept/replace UX on canvas: highlight the target node/edge and the proposed delta, one click to apply, one to dismiss — model it on the existing AI-proposed-step dashed-outline treatment in `shapes.tsx`.
- [ ] On accept, write the change event with the chat reasoning (item 1's pipeline).
- [ ] "Show thinking" dropdown in chat (collapsed by default) + a sources list showing the claims/citations behind each answer.

**Acceptance.** From chat: "rename this step and add a validation gate" → see the exact proposed change highlighted → accept → the map updates and the reasoning is in the object's history and the map log. **Reasoning persistence depends on item 1.**

---

## 4. Stakeholder comments + AI triage

> Emory: "you could have people comment on the process… then you could be like, chat, respond, triage all the comments on this and help me edit the map based on the comments… it gives you suggestions, you click approve all / approve one, it adds those, the reason gets logged."

**Current state.** `ReviewComment` (author, body, `anchor` JSONB, `parent_comment_id` for threads) exists in `backend/app/models/workflow.py` — **no endpoints, no UI.** Comments are model-only and currently hang off a `Review`, not directly off a node/edge.

**The gap.** Essentially everything: CRUD endpoints, anchoring comments to a specific node/edge, the comment UI, the resolve workflow, and the AI triage step.

**Sub-tasks**
- Backend
  - [ ] Decide anchoring: let `ReviewComment.anchor` reference a node/edge id directly (not only via a Review), so a comment can exist without a formal review.
  - [ ] Comment CRUD endpoints (create/list/resolve/reply) scoped to a node/edge/version.
  - [ ] Triage endpoint: feed all open comments for a map to Claude → return edit suggestions as `ProcessSuggestion` rows (the batch accept/reject machinery from reconcile already exists — reuse it). Approving a suggestion writes a change event with the comment as the reason.
- Frontend
  - [ ] Google-Doc-style comment thread on a selected node/edge (new section in `properties-panel.tsx`); comment-count badge on nodes.
  - [ ] "Triage comments" action → suggestion cards with approve-all / approve-one (mirror the existing reconcile/AI-edit proposal cards).

**Acceptance.** A stakeholder comments on a step; the consultant clicks "triage"; AI proposes edits citing the comments; approving one updates the map and logs the comment as the change reason. **Note:** *external* commenters depend on multi-user auth (Parked P2). Until then this works for internal users only.

---

## 5. "Research best practices" seeding cadence

> Camp: "create your first process map on a blank canvas… research best practices map, present to the client, they tell you why it's wrong, you have that transcript, feed it in… and then you have the whole trail of traceability for each step."

**Current state.** Map generation from transcripts/claims already exists (the core flow in `how-it-works.md`). This is mostly a *workflow* that rides on top of items 1–4 rather than a new subsystem.

**The gap.** No "seed a best-practices draft on an empty canvas" entry point; the iterative present→correct→re-ingest loop isn't a first-class cadence.

**Sub-tasks**
- [ ] "Generate best-practices draft" action on an empty map (generic/best-practice claims rather than client documents), with each generated node/edge carrying origin reasoning (item 1).
- [ ] Make re-ingesting a correction transcript additive to an existing map (vs. fresh generation), so the provenance trail accumulates across rounds.

**Acceptance.** Start from a best-practices draft → present → feed the client's correction transcript back → the map updates and every step shows its full origin-to-now trail. **Depends on items 1–2; lowest priority of the active set.**

---

## Parked — blocked on multi-user auth

Emory explicitly deferred these on the call. Listed so they're not lost, not scheduled.

### P1. Reviewer assignment
> "add a reviewer… it sends them a message saying they've been added as a reviewer for that step… they click a button and it validates it." Emory: "that's like last thing."

- Today: per-node **approve / request-change works** (`reviews.py`, ReviewTab, properties-panel Stakeholder Review section). The **`@ Assign` button is a disabled stub** — `properties-panel.tsx:457`, tooltip "Assigning reviewers needs multi-user accounts (coming later)."
- Needs: a reviewer/assignment relation, assignment UI, and notifications — all gated on real users (P2).

### P2. Full user management / auth
> Emory: "through your provider… OIDC… for clients that's where it actually matters… full user management. We probably have to pay for an auth service."

- Today: login screen is **cosmetic**; every request is a hard-coded dev user (`how-it-works.md`). `User` / `Organization` / `ProjectMember` (roles OWNER/EDITOR/REVIEWER/VIEWER) + `auth_provider`/`auth_subject` fields exist in `models/identity.py` but **no OAuth flow and no role enforcement** anywhere.
- Needs: real OIDC flow, session/identity wiring, RBAC enforcement on endpoints, invitations, internal-vs-external accounts.

### P3. Client view
> "a client view where they have a very simple UI… as simple as making comments on a Google Doc… they don't see the traceability, they just see this is what the current state is."

- Today: absent — everyone gets the same editable canvas.
- Needs: a role-gated read-only-plus-comment surface. Depends on P2 (roles) and item 4 (comments). Open question from the call (unresolved): whether the client view exposes document traceability at all — Camp went back and forth on it.

---

## Suggested sequence

1. **Item 1** (reasoning trail) is the keystone — items 2, 3, 5 and the logging in 4 all depend on it. Start here.
2. **Item 4** (comments + triage) is independently valuable for internal use and doesn't need auth to begin.
3. **Items 2 and 3** layer the unified log and chat-editing on top of item 1.
4. **Item 5** is a thin workflow once 1–2 land.
5. **Parked** items wait on the auth decision (P2), which Emory wants to defer.
