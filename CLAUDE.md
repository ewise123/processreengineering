# Claude Code — project guide

A working two-person tool. North star + horizons: `docs/roadmap.md`.

## Work tracking — GitHub Issues are the source of truth
What we're working on lives in **GitHub Issues + the Project board**, not scattered notes.
- Board (living kanban): the repo's **Projects** tab → "POET / Trace — Product Roadmap"
- Roadmap overview: pinned epic **#75**; milestones **Now / Next / Later / Cross-cutting & parallel**
- Before starting, check the relevant issue / board; when you finish or change scope,
  **update the issue** (status, a comment, or close it) and move its board card.
- **Open an issue for new work** (bug, feature, follow-up) rather than tracking only in chat.
  Label it (pillar `P1`–`P4`, `type:*`, `area:*`, `size:*`, `status:*`) and set a milestone.
- `docs/roadmap.md` is the narrative; the issues are its executable form — keep them in sync.
- Agent memory/notes are a scratchpad; the issues win if they disagree.

## gh / git
- **Always pass `--repo ewise123/processreengineering`** to `gh` (this repo's remote is quirky).
- Never commit to `main`; branch + PR. Conventional commits.

## Build / test
- Backend: `cd backend && python -m pytest` (runs against a real Postgres — bring the DB up first).
- Frontend: `npx vitest run` · `npx tsc --noEmit` · `npx next build`.
- Run the app locally: `./run-local.sh` (or the `run-poet-local` workflow).

## Product
- 4 pillars + honest current-state: `docs/roadmap.md`. "POET" is a placeholder name being retired (rebrand: issue #70).
