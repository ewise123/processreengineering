# Change Provenance — Unified Event-Stream Model (North Star)

**Date:** 2026-06-29
**Status:** North-star design. Captures direction and the target model; **not scheduled for immediate implementation.** PR #38 (`fix/suggestion-apply-edit-reason`) is the documented interim state. This document exists so the vision guides future phases and isn't re-derived from scratch.

Supersedes nothing; extends [`2026-06-22-process-map-reasoning-trail-design.md`](./2026-06-22-process-map-reasoning-trail-design.md).

---

## 1. The principle

The process map you see on the canvas is a *snapshot*. The actual deliverable is the **trustworthy story of how it got that way** — every change to every node, edge, and lane, with the intent behind it and the evidence supporting it.

That story must be:

- **Complete** — every change is recorded, human or AI, no exceptions.
- **Uniform** — one record shape answers the same questions for every change, regardless of who or what made it.
- **Provenanced** — each change carries *why* it was made and *how well-grounded* it is (traceable to a source document? validated by stakeholders? merely proposed?).
- **Lossless** — proposals that were *rejected* are kept too, with the reason. *"Why isn't there a step for service X?" — "It was proposed and dismissed because X is deprecated; we replaced it with Y."* That institutional memory is the point of the product, and it's exactly the context a downstream agent needs to reason about the process.

A "validated map" is then just a **filtered view** over this record (show only applied + validated changes). The complete stream — proposals, acceptances, dismissals-with-reasons, validations, contestations — always lives underneath it.

---

## 2. The model: two orthogonal axes

Every change carries two independent dimensions. Conflating them is the root of today's gaps.

### Axis A — Origin / authorship
*Who or what produced this, and through what mechanism.*
Examples: a human editing directly; an AI suggestion a human accepted; a generation pass from source documents; a reconcile pass; an import.

### Axis B — Evidentiary status (a lifecycle, not a label)
*How well-grounded and validated this change is — and this evolves over time.*
States are derived, not stamped once:

- **Proposed** — exists as an idea; not yet applied to the map.
- **Applied** — committed to the map.
- **Grounded** — traceable to source evidence (one or more cited claims → document citations).
- **Validated (canonical)** — a human explicitly signed off *with their own reasoning*, promoting the change into the canonical process (see §2.1). May be the same person who applied it.
- **Dismissed** — proposed and rejected, **with a reason** (kept forever).
- **Contested / stale** — later evidence or a conflict undermines it.

A change can hold any combination across the two axes: *AI-proposed + grounded + not-yet-stakeholder-validated*; *human-authored + ungrounded + validated*; etc. The axes are independent and both belong on the record.

### 2.1 Membership: applied vs. canonical

A change being *on the map* and being *part of the canonical process* are two different things.

- **Applied (working)** — the change is in the working map. A human accepting an AI suggestion in chat reaches this.
- **Canonical** — the change is a blessed part of the real process, included in the validated-map view.

**Rule:** an **AI-authored** change (any kind) is **applied but not canonical** until a human performs an explicit, separate **validation** — recording *who* validated and *their own* reasoning. **Human-direct edits are canonical on apply** (the author supplied intent at creation, and a reason is already required for semantic edits).

**The validator may be the same person who accepted the change.** We deliberately do *not* require a second, different identity. The safeguard is not separation-of-duties but the **deliberate, separately-audited, reasoned act**: AI output can never be *silently* absorbed into the canonical process — a human must explicitly affirm "this belongs" and say why, as a step distinct from the casual chat-accept. This keeps a solo user (building or experimenting with their own process) unblocked while preserving a clean, auditable canonicalization trail.

`canonical(target)` is therefore a **derived rollup**: for an AI-authored change, true iff a `validated` event exists for it and no later `contested` event; human-authored changes are canonical from their applied event. The canvas's existing `aiProposed` node flag is the natural rendering of "applied but not yet canonical."

*Open question (resolve before the D4 status-rollup spec):* contestation is **authorship-agnostic** — a `contested` event can land on a human-authored change too (new evidence invalidates it). D4's precedence then drops it from canonical, but a human edit has no `validated` event to re-establish canonicality. Decide the path back: re-application, or an explicit `validated` event (which would mean even human edits can require validation once contested). Flagged here so D4 closes it rather than inheriting an ambiguous rule.

*Nuance to resolve at build time:* an AI-authored **deletion** has no on-canvas object to flag, so "applied but uncanonical" for a removal means the working map drops it while the canonical view retains it until the deletion is validated. The UX for pending removals needs its own treatment.

---

## 3. Architecture: append-only event stream, derived status

**Decision (confirmed):** status is **not** a mutable column that gets overwritten. It is **derived by rolling up an append-only stream of immutable events** about each target. Nothing is ever lost; the full transition history (who validated when, what was dismissed and why, prior contestations) is always reconstructable.

```text
Event (immutable, append-only)
  ├─ target           (node | edge | lane | map)  + target_id
  ├─ event_kind       proposed | accept | dismiss | applied-change
  │                   | validated | changes_requested | contested | reverted | ...
  │                   (action events are verbs — accept/dismiss — so they never
  │                    read as the resulting `applied-change` they produce)
  ├─ change_kind      relabel | describe | retype | relane | connect | delete | ...   (for change/proposal events)
  ├─ before / after   (the actual data delta, for applied changes)
  ├─ origin           actor_kind (user | ai | system) + actor_id + source (manual | chat | generation | reconcile | import)
  ├─ intent           reason (free text) + reasoning_trace (AI thinking)
  ├─ grounding        cited_claim_ids → claims → document citations
  ├─ links            proposal_id (acceptance/dismissal → the proposal); supersedes_event_id; etc.
  └─ created_at, created_by
```

**Proposals are first-class events**, not a separate staging area:

```text
proposed ─┬─▶ accept   ──▶ (applied-change event carries before/after)
          └─▶ dismiss  (carries dismissal reason; never produces a change)
```

- An **applied AI suggestion** is naturally **two events**: the AI *proposed* it (origin = ai, with reasoning + citations), and a human *accepted* it (origin = user). This is the clean resolution of today's "who is the actor?" ambiguity — and it removes the need for a client-supplied `ai_applied` flag entirely (see §6).
- A **dismissed proposal** is an event with its reason, linked to the proposal. It produces no map change but is fully queryable.
- **Validation** is an event referencing a target (or a specific applied change). Whether it is sourced from the existing `Review` system or recorded natively is an open decision (§5).

**"Current status" is a rollup** over a target's events — e.g., a node's latest applied change is *validated* if the most recent validation event for it is `approved` and no later `contested` event exists.

---

## 4. Relationship to what exists today

The bones are already right; the gaps are specific.

| Capability | Today | Gap |
|---|---|---|
| Append-only per-object change log | `ChangeEvent` table + `record_change` single chokepoint | — (good foundation) |
| What / before-after / who / why / grounding / origin | `target_*`, `before`/`after`, `actor_kind`, `reason`/`reasoning_trace`, `cited_claim_ids`, `source` | — (already captured) |
| Per-object history | `GET /nodes/{id}/history`, `/edges/{id}/history`, model log `?target_id=`; index on `(target_type, target_id, created_at)`; Properties-panel History section | Largely **done** |
| Proposals (recorded, accept/dismiss + reason) | `ProcessSuggestion` (reconcile only; pending/accepted/rejected); chat suggestions are **ephemeral** | Proposals not unified into the stream; chat proposals/dismissals not persisted |
| Stakeholder validation | `Review` / `ReviewComment` (requested/approved/changes_requested); per-node `ReviewState` | Lives in a **separate** system, **not joined** to the change |
| Attribution integrity | `actor_kind`/`source` set by handlers; the **reconcile/ai-proposed-step accept** path already sets them server-side, but the **chat-suggestion PATCH** path takes a client `ai_applied` flag | **Forgeable on the chat-PATCH path** (§6) |

So the work is: (a) bring **proposals** (incl. dismissals + reasons) into the stream, (b) bring **validation** into the stream (or join it), and (c) make **origin** server-authoritative.

---

## 5. Key design decisions (positions for review)

These are the substantive forks. Positions below are recommendations to react to, not commitments.

- **D1 — One table or two?** *Position:* extend the existing event stream (`change_events`) to carry proposal and validation events via an `event_kind`, rather than a parallel proposals table. Rationale: a single append-only stream per target is the whole idea; dismissed proposals are events-without-a-delta, which the schema already tolerates (`before`/`after` nullable). **Resolved:** chat suggestions are persisted as `proposed` events **only when acted on** (accepted or dismissed), **not** at generation time — keeps the stream meaningful and bounded rather than flooding it with every idea the model floats.
- **D2 — Origin is two events, never collapsed, server-derived.** *Resolved:* an applied AI suggestion records *both* `proposed`(actor = ai, with rationale + citations) and `accepted`(actor = the human who applied it) → `applied-change`. Accepting in chat does **not** rewrite authorship to the human — the step stays AI-authored permanently. Origin comes from server-side auth/session context, never a request-body flag. (This is the real fix for CodeRabbit's concern — see §6.)
- **D3 — Validation event = the canonicalization gate.** *Resolved:* an **AI-authored** change becomes canonical only via an explicit `validated` event carrying the validator's `actor_id` and *their own* reasoning (per §2.1); the validator **may be the same person** who accepted it (no separation-of-duties requirement). Human-direct edits are canonical on apply. Emit a canonicalizing `validated` event **only** when a `Review` resolves `approved`; a `changes_requested` resolution emits a distinct **non-canonicalizing** event (or leaves the change unvalidated) — never auto-canonicalize a rejected change. Either way the stream stays the single queryable source while `Review`/`ReviewComment` remain the workflow UI — no second source of truth.
- **D4 — Status derivation rules.** Define the rollup precisely (precedence of contested > validated > applied > proposed; how dismissals and reverts terminate a lineage). Needs its own short spec when built.
- **D5 — Views.** "Validated map" = filter to applied changes whose rollup status is validated and not contested. Per-node history already exists and extends naturally to show proposals/dismissals once they're in the stream.

---

## 6. The interim state (PR #38) and why it's acceptable for now

PR #38 fixed a regression: the reasoning-trail feature made semantic PATCHes require a non-empty `reason`, and the suggestion-apply executor sent none, so applying a relabel/describe/move/relabel-edge/rename-lane suggestion 422'd. The fix threads the suggestion's rationale as the reason and marks the edit `ai_applied` so it records `source=chat` / `actor_kind=ai`.

`ai_applied` is a **client-supplied flag**, so attribution is forgeable — flagged in review. We are **accepting this as interim** because:

- The clean fix is D2 (proposer/accepter as two server-recorded events), which only exists once this model is built. Any hardening inside today's single-PATCH path would be a half-measure likely thrown away.
- Threat is low *on privilege* — authenticated users editing their own maps; no privilege or trust boundary is crossed. But it's **not purely a log-label issue**: because of the applied-vs-canonical distinction (§2.1), a forged `ai_applied=true` on a human-direct edit would mis-defer its canonicalization — hiding it from the validated-map view and forcing an unnecessary validation gate. That's a real functional-correctness impact on map state, which is the stronger reason to make origin server-authoritative (D2) rather than harden the flag.

There is also **no applied-vs-canonical distinction today**: an accepted AI edit is immediately and indistinguishably part of the one working map. When this model lands, the generic PATCH `ai_applied` flag is **removed** in favor of a server-recorded acceptance event, and the applied-vs-canonical gate (§2.1) ensures AI-authored changes aren't canonical until explicitly validated.

---

## 7. Phased path (when scheduled)

- **Phase 0 — done.** `ChangeEvent` + `record_change`; reason required on semantic edits; per-object history endpoints.
- **Phase 0.5 — interim.** PR #38: applied suggestions carry rationale-as-reason + `ai_applied` attribution.
- **Phase 1 — origin integrity + proposals in the stream.** Server-authoritative origin (D2); persist `proposed` / `accepted` / `dismissed`(+reason) events for chat suggestions; remove the client `ai_applied` flag.
- **Phase 2 — validation, canonicalization, derived status.** Validation events as the canonicalization gate (D3) — AI-authored changes need an explicit reasoned `validated` event (validator may equal accepter) to become canonical; human edits canonical on apply. Status rollup (D4); "validated / canonical map" filter (D5).
- **Phase 3 — contestation, staleness, agent queries.** `contested`/`stale` events tied to new conflicting evidence; query surface for agents (*"why was X dismissed?"*).

---

## 8. Out of scope (for now)

The full build above. This document is the destination, not the current sprint. Next concrete action after this doc is **verifying PR #38 end-to-end** (the apply→PATCH round-trip currently has no live test) and merging it.
