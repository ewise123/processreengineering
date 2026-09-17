---
name: browser-screenshots
description: Use when you need to SEE the running app rather than reason about it — screenshotting a page, checking a CSS/layout change, driving a UI flow (click, type, submit), or verifying a frontend change in the real browser. Also use when a change touches visual output and you are tempted to say "this should render correctly". Triggers include "screenshot the app", "what does it look like", "check it in a browser", "click through it", "is the layout right".
---

# Browser screenshots on this box

There is no display and no Chrome on `PATH`, but there **is** a real browser and a
real X server. "Headless" here means no monitor — not "no visual verification".
Never reason about how something renders when you can look at it.

## The one-time setup (already done for `ewise`)

```bash
which Xvfb xvfb-run          # system-wide, no sudo needed
uv tool install playwright   # per-user: browsers live in ~/.cache/ms-playwright
playwright install chromium  # pulls full chromium + headless shell + ffmpeg
```

Verify with `ls ~/.cache/ms-playwright` — you need **`chromium-<n>`**, not just
`chromium_headless_shell-<n>`. Only the full build paints CSS the way a user sees it.

## The pattern

```bash
xvfb-run -a uv run --with playwright python3 - <<'PY'
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(headless=False, args=["--no-sandbox"])
    page = b.new_page(viewport={"width": 1600, "height": 950})
    page.goto("http://localhost:3000/...", wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(2000)          # let the canvas settle
    page.screenshot(path="/tmp/shot.png")
    b.close()
PY
```

Then **Read the PNG** — the Read tool displays images.

Two flags are not optional here:

- `headless=False` launches a real headed browser into Xvfb's virtual display.
  Playwright's own headless mode renders differently; use the real thing.
- `--no-sandbox` — AppArmor on this Ubuntu blocks unprivileged user namespaces,
  and without it Chrome dies with "No usable sandbox" before painting anything.

`uv run --with playwright` borrows the package without touching the project's venv
or `requirements.txt`. Video instead of a still: pass `record_video_dir` to
`new_context()`; ffmpeg is already installed alongside the browsers.

## Driving this app specifically

- Start the stack first — see the `run-poet-local` skill. Docker is unavailable, so
  Postgres runs natively on `:5433`; start `uvicorn` and `npm run dev` directly.
- **Each `new_context()` gets clean `sessionStorage`**, which is how to test anything
  session-scoped (the working note, chat history) in its empty *and* set states —
  one context each, rather than trying to reset in place.
- Selecting a step reveals a chevron at roughly `(1196, 78)`; clicking it opens the
  Properties panel. Double-clicking a node does *not* open it.
- The Properties panel overlaps the bottom toolbar, so set anything you need from
  the toolbar (e.g. the session note) **before** opening Properties, or the click
  gets intercepted by a disabled button underneath.
- Assert on outcomes, not appearance: `page.locator("[role=dialog]").count()` answers
  "did it prompt?" far more reliably than eyeballing a screenshot.

## Prove it with the API, not just the picture

A screenshot shows what rendered; it does not show what was *saved*. For anything
that writes to the change log, follow the UI step by reading the node's history back
from `/api/v2/projects/{pid}/nodes/{id}/history` and checking the `reason` is what
you expect. The picture and the log together are the proof.

## What does not work here

**Claude in Chrome cannot be used from this box.** It pairs a local GUI Chrome to a
session via `/chrome`, and there is no GUI Chrome here. It only makes sense on a
real desktop. Don't spend time trying to port-forward around it.
