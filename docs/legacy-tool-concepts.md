# Legacy Process Engineering Tool Concepts

This document preserves the business logic, prompt engineering, output schemas, and institutional knowledge embedded in the legacy "POET — Process Optimization Engineering Tool" before it is removed from the repository. The legacy tool was a static-HTML + FastAPI app that lived at `public/*.html` and `backend/main.py` (~4,190 lines). It is being decommissioned in favour of the new Next.js + FastAPI v2 application, which currently re-implements only a subset of these deliverables.

The prompts below are the load-bearing IP — Anthropic Claude system messages tuned over many iterations to produce client-ready process maps, SOPs, business cases, scorecards, RACI matrices, change impact assessments, and implementation plans. Future re-implementers should treat the prompts as **verbatim reference material** rather than starting points to be rewritten. Output schemas (BPMN JSON, section taxonomies, ESOAR categories, RACI columns, RAG ratings, PPTX/DOCX heading hierarchies) are equally important — they encode how SSA consultants expect these artefacts to look in front of a client.

---

## Cross-cutting concepts

### Product positioning (from `public/login.html` and `public/index.html`)

- Product name: **POET — Process Optimization Engineering Tool**
- Subtitle / tagline: **"AI-Enabled Process Re-Engineering Platform"**
- Brand block (login): "Process Optimization\nEngineering Tool"
- Six feature bullets shown on the login page:
  > - Generate BPMN process maps at L1–L4 detail levels
  > - Create SOPs and Business Cases from uploaded documents
  > - Identify ESOAR improvement and automation opportunities
  > - Score process health with RAG-rated dimension assessments
  > - Generate RACI matrices with role definitions and findings
  > - Assess change impact across stakeholder groups and workstreams

### Six-phase workflow taxonomy (from `index.html`)

The landing page frames the tools as a six-phase consulting journey. Each phase has a one-paragraph overview that should be preserved as positioning copy:

- **Phase 1 — Understand & Diagnose:** "Establish an evidence-based picture of the process before any changes are made. Map the as-is workflow at multiple levels of detail and score it against LEAN and ESOAR health dimensions — giving you a structured baseline and a quantified view of where inefficiencies, risks, and automation opportunities exist."
- **Phase 2 — Optimize:** "With the baseline in place, identify where and how the process can be improved. The ESOAR assessment systematically evaluates improvement options — from eliminating waste to full robotization — and builds the business case for change, helping prioritise which opportunities deliver the most value."
- **Phase 3 — Design:** "Translate improvement priorities into a structured future-state design. Generate a to-be BPMN process map that reflects the optimised workflow and pair it with a phased implementation roadmap — giving stakeholders a clear picture of the target state and the steps required to get there."
- **Phase 4 — Govern:** "Define who is responsible for each step of the redesigned process. The RACI Matrix Generator produces a clear accountability framework, surfaces ownership gaps, and ensures every task has an assigned role — establishing the governance structure before implementation begins."
- **Phase 5 — Change:** "Prepare the organisation for the transition. The Change Impact Assessment identifies which stakeholder groups are affected, the severity of impact, and the change actions required — enabling targeted communication, readiness planning, and a smoother path to adoption."
- **Phase 6 — Document:** "Lock in the future state with formal documentation. Generate publication-ready SOPs and Business Cases that capture the redesigned process, its rationale, and expected benefits — ready for stakeholder sign-off, staff training, and operational handover."

### BPMN level taxonomy (L1–L4)

The legacy tool exposes four BPMN detail levels. The legacy code uses 1–4 only (not 1–6). Per-level guidance from `LEVEL_INSTRUCTIONS` in `backend/main.py`:

- **Level 1 — Process Landscape** (5–10 major process phases): Executive alignment and scope definition. Show only major end-to-end stages — what happens, not how. No sub-tasks, decision gateways, exception paths, or system interactions. **Empty gateways array** — no decision points at this level. Single broad role (e.g. "Business", "Operations") or no swimlane differentiation. Value chain of simple linear boxes. Audience: steering committees, strategy sessions, executive briefings.

- **Level 2 — End-to-End Cross-Functional Process** (15–25 activities): Understand flow across teams. Full BPMN elements: start/end events, activities, key decision gateways. Show handoffs between functions. Distinct swimlane roles for each function or department (e.g. "Call Center", "Adjuster", "Finance"). Include key decision points but omit low-level task detail. Audience: process owners, operations managers, transformation programmes.

- **Level 3 — Detailed Operational Workflow** (30–50 activities): Diagnose inefficiencies and design improvements. Break each Level 2 activity into granular component tasks. Include detailed decision logic (exclusive, parallel, inclusive gateways), exception paths, rework loops, system interactions. Assign specific roles, departments, or systems to every step. Audience: process improvement teams, Six Sigma, Lean, operational redesign.

- **Level 4 — Work Instruction / System-Level Detail** (50–80 activities): Execution, training, and automation design. Lowest level of detail — step-by-step instructions for individuals or systems. Each step is a single atomic action (opening a screen, entering a field, applying a rule, sending a notification). Include all business rules, validation checks, conditional logic. Precise roles, named systems, or tools assigned to every step (e.g. "Claims System", "RPA Bot", "Senior Adjuster"). Audience: SOPs, RPA development, system configuration, staff training, audit documentation.

### Supported input file types

From `backend/main.py`:

```python
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".doc", ".pptx", ".ppt", ".txt",
                      ".xlsx", ".xls", ".csv", ".png", ".jpg", ".jpeg"}
MAX_FILE_SIZE_MB = 20
```

Parsing logic per extension:

- **PDF** — `pdfplumber`, page-by-page text extraction joined with `\n\n`.
- **DOCX / DOC** — `python-docx`; concatenates paragraph text plus table cells joined by `" | "`.
- **PPTX / PPT** — `python-pptx`; for each slide prepends `[Slide N]` and includes the text of every shape that has text.
- **TXT** — UTF-8 decode with `errors="ignore"`.
- **XLSX / XLS** — `openpyxl` in `read_only=True, data_only=True`; emits `[Sheet: <title>]` headers and joins each row with `" | "`.
- **CSV** — `csv.reader`, joins non-empty cells with `" | "`.
- **PNG / JPG / JPEG** — Claude vision call (`claude-sonnet-4-6`, `max_tokens=4000`) with a hard-coded vision prompt:

> "Extract all text, labels, data, and meaningful content from this image. If it is a process map or diagram, describe the steps, flow, and decisions. Return the content in plain text, preserving structure where possible."

### Reusable framing language baked into every prompt

Almost every generator inherits a common set of formatting rules. They are repeated verbatim across SOP, business case, implementation plan, scorecard, RACI, and CIA prompts and should be lifted into a shared style guide in the new tool:

- "All financial figures, costs, and estimates MUST be expressed in US Dollars (USD, $). Never use GBP, £, EUR, or any other currency."
- "Use American English spelling throughout (e.g., 'analyze' not 'analyse', 'optimize' not 'optimise', 'standardize' not 'standardise', 'color' not 'colour', 'organization' not 'organisation')."
- "Do NOT use strikethrough text (~~text~~) under any circumstances."
- "Do NOT use ALL CAPS text anywhere in the document. Use normal sentence case or title case only."
- "ASSUMPTION REFERENCES: Every quantitative figure in the document … MUST be followed immediately by an inline superscript reference marker in the format `<sup>[A1]</sup>`, `<sup>[A2]</sup>`, `<sup>[A3]</sup>` etc. These markers must correspond exactly to numbered **Assumption [A1]:** entries in the Sources section. Number assumptions sequentially across the entire document."
- "Do NOT use markdown tables" (in narrative deliverables — SOP, business case, implementation plan, scorecard, CIA). RACI is the exception: every section IS a markdown table.

### Model and SDK conventions

- **Model:** `claude-sonnet-4-6` is used for every generator (structure extraction, SOP, business case, scorecard, RACI, CIA, implementation plan, image OCR).
- **Token budget:** `max_tokens=8000` for structured-document generators; `4000` for image OCR.
- **Document truncation:** Generators truncate combined source text to **8,000 characters** (structure extraction, implementation-plan tail call) or **12,000 characters** (SOP, business case, scorecard, RACI). CIA truncates current and future text to **6,000 characters each**.
- **Streaming:** Only the SOP endpoint uses Anthropic streaming (`async_client.messages.stream`). All others are synchronous `messages.create`.

### Identify-processes helper prompt

Before generating a process map, the tool can scan an uploaded document and propose a list of distinct processes for the user to choose from. Verbatim system prompt (`IDENTIFY_PROCESSES_PROMPT`):

```text
Analyze the provided document(s) and identify all distinct business processes described within them.

Return ONLY a valid JSON array — no prose, no markdown fences. Each item must have:
- "name": short process name in Title Case (3–6 words)
- "description": one sentence describing what the process achieves

Rules:
- List only genuine end-to-end processes, not individual tasks or sub-steps
- Typical document contains 1–5 processes
- If the content describes one coherent process, return a single-item array

Example output:
[
  {"name": "Invoice Approval Process", "description": "Manages review and sign-off of vendor invoices before payment is released."},
  {"name": "Vendor Onboarding Process", "description": "Guides new suppliers through registration, compliance checks, and system setup."}
]
```

Exposed at `POST /api/identify-processes` with form field `files: List[UploadFile]`.

---

## Process Map Generator

### Purpose
Generate BPMN 2.0 process maps (current state and/or future state) from uploaded documents at a chosen level of detail (L1–L4), with swimlanes, gateways, and exportable PPTX / DOCX / VSDX deliverables.

### User-facing positioning (from `process-map.html`)

> "Create a BPMN Process Map & Implementation Plan — POET"
>
> "Upload process documentation to generate current and future state BPMN process maps, then produce a structured implementation plan to bridge the gap."

The page is structured as five steps: **(1)** Configure & Upload Documents, **(2)** Select Processes to Map, **(3)** Generation/progress, **(4)** Review Your Process Map(s), **(5)** Implementation Plan. The landing-page card calls this **Step 1 — BPMN Process Map (Current State)** (tags: "Current State", "L1–L4") and also **Step 4 — Future State BPMN + Implementation Plan** (tags: "Future State", "Impl. Plan").

### Inputs
- One or more files (`ALLOWED_EXTENSIONS`, ≤20 MB each)
- `process_title` (free text — overrides the model's inferred process name)
- `bpmn_level` — `"1"` / `"2"` / `"3"` / `"4"` (UI options shown verbatim):
  - "Level 1 — Process Landscape (5–10 major phases, executive view)"
  - "Level 2 — End-to-End Cross-Functional Flow (15–25 activities, swimlanes)"
  - "Level 3 — Detailed Operational Workflow (30–50 steps, exception paths)"
  - "Level 4 — Work Instructions / System Detail (50–80 steps, field-level)"
- `focus_process` — optional process name to focus on if the document covers several
- `map_type` — `""` (default), `"current_state"`, or `"future_state"`

### Prompts

**System prompt (`STRUCTURE_PROMPT`) — verbatim:**

```text
You are a business process analyst. Extract the key process steps from the document and represent them using BPMN 2.0 notation standards.

Return ONLY a valid JSON object in this exact format — no markdown, no explanation:
{
  "process_name": "Short name of the process",
  "steps": [
    {
      "id": "step_1",
      "type": "userTask",
      "name": "Imperative verb + object (max 40 chars)",
      "role": "Actor or department performing this step"
    }
  ],
  "gateways": [
    {
      "id": "gw_1",
      "type": "exclusive",
      "name": "Decision question?",
      "after_step": "step_2",
      "yes_label": "Condition met",
      "no_label": "Condition not met",
      "yes_to": "step_3",
      "no_to": "step_4"
    }
  ]
}

BPMN 2.0 RULES — follow these precisely:

TASK TYPES — choose the most accurate for each step:
  "userTask"         — a human performs the activity (default for most manual steps)
  "serviceTask"      — an automated system or IT service performs the activity with no human intervention
  "manualTask"       — physical or offline work performed by a person without a system (e.g. printing, signing paper)
  "businessRuleTask" — applying a business rule, policy check, or automated decision engine
  "sendTask"         — sending a message, email, or notification to an external party
  "receiveTask"      — waiting to receive a message, document, or trigger from an external party

TASK NAMING — imperative verb + object (the action performed, not a noun phrase):
  CORRECT: "Review application", "Submit claim form", "Approve payment", "Send notification"
  WRONG:   "Application review", "Claim form submission", "Payment approval", "Notification sent"
  Do NOT start the name with the actor/role — the actor is shown in the swimlane header.

GATEWAY TYPES:
  "exclusive"  — exactly one outgoing path is taken based on a condition (XOR — use for most decisions)
  "parallel"   — ALL outgoing paths are taken simultaneously (AND — use when work splits into parallel tracks)
  "inclusive"  — one or more outgoing paths are taken (OR — use when multiple combinations are valid)

GATEWAY NAMING — must be a question that the gateway answers:
  CORRECT: "Application complete?", "Approval granted?", "Risk level acceptable?"
  WRONG:   "Check application", "Decision", "Approval"

GATEWAY CONDITIONS — always use exactly "Yes" and "No" as the yes_label and no_label values.
  Do not use any other text (not "Complete", "Approved", "Accepted" — only "Yes" and "No").
  For parallel gateways, omit yes_label and no_label (all paths are always taken).

GATEWAY ROUTING — critical rules for no_to and yes_to:
- "yes_to" is the step the process continues to on the YES path (the normal forward flow).
  It is ALWAYS the step immediately after the gateway in the sequence — do NOT set it explicitly.
- "no_to" MUST point to a DIFFERENT step than the one immediately after the gateway.
  If Yes continues to step_3, No must go somewhere else (e.g. step_5, or omit to route to End).
  NEVER set "no_to" to the same step ID as the step directly after the gateway.
- If you cannot identify a meaningful No destination, omit "no_to" (the system will route No to the End event).
- A gateway with both Yes and No going to the same step is invalid — use a task instead.

ADDITIONAL RULES:
- The number of steps is defined by the detail level instruction below — follow it precisely
- Step IDs must be unique snake_case strings
- The "role" field is REQUIRED for every step — identify the actor, department, or system. If unspecified, use "Process Team"
- Group related steps under the same role name so swimlanes are meaningful
- Include gateways only where there is a clear decision or split in the process
- If no clear branches exist, return an empty gateways array
```

**Appended at runtime:** the matching `LEVEL_INSTRUCTIONS[bpmn_level]` block (full text of L1–L4 reproduced under "BPMN level taxonomy" above) prefixed with `IMPORTANT — Detail level instruction:`.

**Current-state / future-state suffix (appended to the user message):**

- `current_state`: "MAP TYPE — CURRENT STATE: Document the process EXACTLY AS IT EXISTS TODAY. Show the actual workflow including manual steps, handoffs, delays, and inefficiencies as they currently occur. Do not optimise or idealise — capture reality."
- `future_state`: "MAP TYPE — FUTURE STATE: Design the process AS IT SHOULD WORK after improvement. Show the optimised, streamlined workflow with inefficiencies removed, automation where applicable, and best-practice steps applied. This is the target desired state."

**Focus suffix:** `Focus exclusively on the process named: "{focus_process}". Ignore all other processes described in the document.`

**User message:** `Extract the process structure from this document:{focus_note}\n\n{truncated}` (document truncated to 8,000 chars).

### Output structure

- JSON returned by Claude with: `process_name`, `steps[]` (id, type, name, role), `gateways[]` (id, type, name, after_step, yes_label, no_label, yes_to?, no_to?).
- Backend then converts this JSON into BPMN 2.0 XML with swimlanes via `build_bpmn_xml(structure)` (lines 382–706 of `main.py`).

### Deliverable formats

- **In-browser BPMN diagram** rendered client-side (the response includes the JSON structure and generated BPMN XML).
- **PPTX export** (`_make_pptx`) — embeds a PNG render of the diagram into a slide.
- **DOCX export** (`_make_docx`) — embeds the PNG into a Word document.
- **VSDX export** (`_make_vdx`) — Visio-compatible `.vdx` packaged as `application/vnd.visio`.
- All three are served by `POST /api/export` with form fields `format`, `png_base64`, `process_name`, `bpmn_xml`.

UI-exposed export options (from `process-map.html`): "PowerPoint (.pptx)", "PNG Image (.png)", "Visio (.vsdx)".

### Notable business taxonomy

- **Task element types** (BPMN 2.0): `userTask`, `serviceTask`, `manualTask`, `businessRuleTask`, `sendTask`, `receiveTask`, `scriptTask`, `task`.
- **Gateway types:** `exclusive` (XOR), `parallel` (AND), `inclusive` (OR). Mapped to BPMN element names: `exclusiveGateway`, `parallelGateway`, `inclusiveGateway`.
- **Element sizes** baked into layout: startEvent/endEvent 36×36 px, task 120×80 px, gateway 50×50 px.
- **Layout constants:** pool header 30 px, lane label strip 120 px, horizontal step distance 175 px, lane height 150 px.
- **Default role** when none is identified: `"Process Team"`.
- **Swimlane convention:** roles are collected in document order; each unique role becomes a horizontal swim-lane within a single BPMN pool labelled with the process name.
- **Actor stripping:** `_strip_actor()` removes leading actor prefixes from task labels (e.g. role "Broker" + label "Broker sends quote" → "Sends quote") because the actor is already on the swimlane.

### Endpoints

- `POST /api/identify-processes` → `{processes: [{name, description}, ...]}`
- `POST /api/upload` (multipart: `files`, `process_title`, `bpmn_level`, `focus_process`, `map_type`) → `{process_name, bpmn_xml, structure}`
- `POST /api/export` → file download (PPTX / DOCX / VSDX)

---

## SOP / Process Documentation Generator

### Purpose
Produce a publication-ready Standard Operating Procedure in markdown (rendered to DOCX) from uploaded source documents, with a configurable set of sections.

### User-facing positioning (from `process-document.html`)

> "Create a Standard Operating Procedure (SOP) — POET"
>
> "Upload one or more source documents to automatically generate a structured Standard Operating Procedure."

Streaming UX: the page shows "Writing your SOP…" with an animated indicator while Claude streams text.

### Inputs
- `files: List[UploadFile]` (one or more documents)
- `sop_title: str` (defaults to file-derived title)
- `sections_json` — JSON list of section IDs to include (subset of `SOP_SECTIONS_META`)
- `style_hint: str` — free-text style direction appended to the user message (e.g. "Concise audit-grade tone, UK regulatory voice")

### Prompts

**System prompt (`SOP_SYSTEM_PROMPT`) — verbatim:**

```text
You are a professional business analyst and technical writer specialising in standard operating procedures (SOPs).

Generate a clear, well-structured SOP in markdown format based on the source documents provided.

Formatting rules:
- Use # for the SOP title only (H1)
- Use ## for section headings (H2)
- Use numbered lists (1. 2. 3.) for procedure steps
- Use bullet lists (- ) for non-sequential items
- Use **Bold:** format for key-value pairs (e.g. **Department:** Finance)
- CRITICAL: Each **Bold label:** sub-field within a step MUST start on its own NEW LINE. NEVER write two bold labels on the same line. Every time you write a **Bold label:** it must be preceded by a newline. Example of CORRECT format:
  1. **Trigger:** Description of trigger.
     **Responsible Party:** Name or role.
     **Systems/Tools Required:** List of tools.
     **Step Description:** Full description here.
     **Key Control:** Control point here.
  Example of WRONG format (DO NOT DO THIS):
  1. **Trigger:** text. **Responsible Party:** text. **Systems/Tools Required:** text.
- Do NOT use markdown tables
- NEVER write text in ALL CAPS. Every single word in the document must be in normal mixed case (e.g. "Trigger:", not "TRIGGER:"). This applies to labels, headings, content, and every other part of the document without exception. Use **bold** for emphasis only.
- All financial figures, costs, and estimates MUST be expressed in US Dollars (USD, $). Never use GBP, £, EUR, or any other currency.
- Use American English spelling throughout (e.g., "analyze" not "analyse", "optimize" not "optimise", "standardize" not "standardise", "color" not "colour", "organization" not "organisation").
- ASSUMPTION REFERENCES: Every quantitative figure in the document (cycle times, durations, dollar amounts, FTE counts, error rates, frequencies, etc.) MUST be followed immediately by an inline superscript reference marker in the format <sup>[A1]</sup>, <sup>[A2]</sup>, <sup>[A3]</sup> etc. These markers must correspond exactly to numbered **Assumption [A1]:** entries in the Sources section. Number assumptions sequentially across the entire document.
- Do NOT use strikethrough text (~~text~~). Never cross out, mark out, or use strikethrough formatting anywhere in the document.
- Do NOT use ALL CAPS text anywhere in the document. Use normal sentence case or title case only.
- Do NOT include any explanation or preamble outside the SOP itself — return only the SOP document
```

**Runtime appendix** added by `_build_sop_messages`:

```text
The SOP must start with:
# [SOP Title]
**Version:** 1.0  **Date:** {today (e.g. May 2026)}
---

Then include exactly these sections in this order:

{numbered list of selected sections from SOP_SECTIONS_META, each "## Title" followed by the section instruction}
```

**User message:**

```text
Generate a professional SOP titled "{sop_title}" based on the following source documents:

{combined_text[:12000]}
```

If `style_hint` is non-empty: `\n\nStyle instruction: {style_hint}` is appended.

### Output structure — `SOP_SECTIONS_META` (verbatim section IDs, titles, instructions)

1. **doc_control — Document Control & Governance:** "Include: SOP Title, Unique Document ID (e.g. SOP-001), Version Number, Effective Date, Review Date, Owner (Business Function), Approver(s), Superseded Versions, Change Log with summary of revisions, Distribution List, and Classification (e.g. Confidential/Internal)."
2. **purpose — Purpose & Objective:** "Clearly state why the SOP exists, what risk or business requirement it addresses, and any regulatory or policy drivers."
3. **scope — Scope:** "Define boundaries precisely: business units covered, products/services covered, geographies/jurisdictions, in-scope vs out-of-scope activities, and applicable legal entities."
4. **regulatory_refs — Regulatory & Policy References:** "List applicable laws (e.g. AMLD, SEC, FINRA, FCA), internal policies (Risk, Compliance, Data Privacy), industry standards (ISO, SOC 2, PCI-DSS), and related SOPs."
5. **definitions — Definitions & Acronyms:** "Define technical terms, regulatory definitions, risk categories, and system names. Use **Term:** definition format for each entry."
6. **roles_responsibilities — Roles & Responsibilities (RACI):** "Define accountability for: Process Owner, Business Operators, Compliance, Risk, Internal Audit, and IT/System Support. Use **Role:** responsibility format for each."
7. **process_overview — Process Overview:** "High-level summary before detailed steps: describe inputs and outputs, trigger events, key decision points, and critical control checkpoints."
8. **procedures — Detailed Procedures:** "For each step include: trigger, responsible party, required systems/tools, step description, control/check required, evidence/documentation required, SLA/timeline, and escalation trigger. Separate operational steps from control steps and clearly mark Key Controls. Use numbered list format."
9. **controls_risk — Controls & Risk Management:** "Include: key risks addressed, preventive controls, detective controls, manual vs automated controls, control frequency, and control evidence retention requirements. Use **Risk:** control format for each pair."
10. **exception_handling — Exception Handling & Escalation:** "Define: what qualifies as an exception, approval thresholds, escalation chain, regulatory breach reporting procedures, and documentation requirements."
11. **systems_data — Systems & Data Requirements:** "List systems used, data inputs, data validation checks, access control requirements, data privacy/security requirements, retention requirements, segregation of duties, and access provisioning controls."
12. **documentation_retention — Documentation & Record Retention:** "Specify: what documents must be stored, where (system/location), retention period, and audit trail requirements."
13. **kpis_monitoring — KPIs / Monitoring & Reporting:** "Define: process SLAs, error rates, control failures, regulatory reporting metrics, quality assurance reviews, and dashboard ownership."
14. **training — Training Requirements:** "List: required certifications, mandatory annual training, system training, and evidence of training completion requirements."
15. **business_continuity — Business Continuity & Contingency:** "Include: backup procedures, manual fallback processes, disaster recovery steps, and communication protocols during disruptions."
16. **appendices — Appendices:** "List any relevant appendices: process flowcharts, templates, forms, checklists, sample reports, and control testing scripts."
17. **sources — Sources and Assumptions:** Two-part: (1) source documents listed as `**Source:** description`; (2) numbered metric assumptions matching every `<sup>[Ax]</sup>` marker in the body, each as `**Assumption [Ax]:** description` giving the figure, where it came from, basis/benchmark, and caveats.
18. **glossary — Acronym & Term Dictionary:** Alphabetised dictionary, format `**TERM / ACRONYM:** Full expansion and plain-English definition.` Must include all acronyms, regulatory/compliance terms, system/tool names, and domain jargon.

**Default sections (`DEFAULT_SECTIONS`):** `['purpose', 'scope', 'definitions', 'roles_responsibilities', 'procedures', 'exception_handling', 'documentation_retention']`.

### Deliverable formats

- **Markdown stream** (live to the UI) via `POST /api/generate-sop` (streaming response).
- **DOCX export** via `POST /api/export-sop` using `_make_sop_docx`. The DOCX template (lines 2880+ of `main.py`):
  - Letter paper, 1-inch margins all sides.
  - Normal style: Calibri 11 pt, 6 pt space-after, 14 pt line spacing.
  - **Heading 1:** Calibri 18 pt bold, RGB `#1E40AF` (executive navy), 20 pt before / 6 pt after.
  - **Heading 2:** Calibri 14 pt bold, RGB `#1E293B`, 16 pt before / 4 pt after.
  - **Heading 3:** Calibri 12 pt bold, RGB `#334155`, 12 pt before / 3 pt after.
  - Title page with centred dark-navy block.
  - List styles reset to flush left.
  - Inline `<sup>` superscripts preserved as Word superscript runs; `**bold**` rendered as bold runs (including bold-with-nested-superscript like `**Phase 1<sup>[A1]</sup>:**`).
  - Pre-processing: ALL-CAPS lines auto-converted to title case (preserves `**...**` markers); blockquotes stripped; the Legend section is moved to the very end.
- The same `_make_sop_docx` function is reused to render scorecard, business case, RACI, and CIA markdown into DOCX.

### Notable business taxonomy

- Standard SSA SOP starts with `**Version:** 1.0  **Date:** {Month YYYY}` and a horizontal rule.
- Document ID convention: `SOP-001`.
- RACI section labelled "Roles & Responsibilities (RACI)" — uses `**Role:** responsibility` pairs (not a full RACI table; the RACI Matrix Generator is the dedicated tool for that).

### Endpoints

- `POST /api/generate-sop` (streaming) — fields: `files`, `sop_title`, `sections_json`, `style_hint`.
- `POST /api/export-sop` — fields: `sop_markdown`, `sop_title`, `format` (always `docx`).

---

## Implementation Plan / Automation Options

This is the most complex generator: it builds a two-call implementation plan (main body + isolated "Value Add" / "Sources and Assumptions" tail) and is reachable via two UI entry points:

1. The **future-state arm** of the Process Map page (`Step 5 — Implementation Plan` inside `process-map.html`).
2. The standalone **"Assess Process Optimization Options"** page (`automation-options.html`), which the landing page calls **Step 3 — Assess Optimization Options (ESOAR)** (tags: "ESOAR", "Business Case").

### Purpose
Generate a phased markdown implementation plan to transition from a named current-state process to a named future-state process, with optional "Value Add by Dimension" appendix and required "Sources and Assumptions" appendix.

### User-facing positioning (from `automation-options.html`)

> "Assess Process Optimization Options — POET"
>
> "Upload process documents and generate targeted improvement recommendations using the Eliminate, Standardize, Optimize, Automate, Robotize (ESOAR) framework — delivered as a professional Process Optimization Business Case."

### Inputs
- `files: List[UploadFile]`
- `current_process: str` (free-text name of the as-is process)
- `future_process: str` (free-text name of the to-be process)
- `sections_json` — subset of `IMPL_PLAN_SECTIONS` IDs
- `parameters_json` — subset of `IMPL_PARAMETERS` IDs (implementation-design constraints to weave through the plan)

### Prompts

**Main-body system prompt (`IMPLEMENTATION_PLAN_PROMPT_BASE`) — verbatim:**

```text
You are a business transformation consultant. Based on the source documents and the process names provided, generate a structured implementation plan to transition from the Current State process to the Future State process.

Format the plan in markdown with ONLY the sections listed below (in the order given). Do not add any extra sections.

{sections_block}

Rules:
- Use ## for section headings, **Bold:** for sub-field labels
- Use numbered lists for sequential steps, bullet lists for non-sequential items
- Be specific and actionable — avoid generic filler
- Be concise: 4–8 bullet points or sentences per section maximum
- Do NOT use ALL CAPS
- Do NOT use markdown tables — use bullet lists or numbered lists instead
- Do NOT add a title or preamble — start directly with the first ## section heading
- All financial figures, costs, savings, and estimates MUST be expressed in US Dollars (USD, $). Never use GBP, £, EUR, or any other currency.
- Use American English spelling throughout (e.g., "analyze" not "analyse", "optimize" not "optimise", "standardize" not "standardise", "color" not "colour", "organization" not "organisation").
- ASSUMPTION REFERENCES: Every quantitative figure (timelines, durations, cost estimates, FTE counts, percentages, effort hours, etc.) MUST be followed immediately by an inline superscript reference marker: <sup>[A1]</sup>, <sup>[A2]</sup>, etc. Number sequentially across the document.
- CRITICAL: Do NOT generate a Sources and Assumptions section. Do NOT add any section not listed above. The Sources and Assumptions section is produced separately and must not appear here.
- Return only the implementation plan document
```

**Tail-call system prompt (`IMPL_PLAN_TAIL_PROMPT_BASE`) — verbatim:** Used for the isolated second Claude call that generates only `value_add` and/or `sources`:

```text
You are a business transformation consultant. Generate the following sections of an implementation plan in markdown format.

Format rules:
- Use ## for section headings
- Use ### for subsection headings within a section
- Use bullet lists (- ) for non-sequential items, numbered lists for sequential items
- Do NOT add a title, preamble, or any text before the first ## heading
- Start your response directly with the first ## heading
- Do NOT use markdown tables
- Do NOT use ALL CAPS
- All financial figures, costs, and estimates MUST be expressed in US Dollars (USD, $). Never use GBP, £, EUR, or any other currency.
- Use American English spelling throughout (e.g., "analyze" not "analyse", "optimize" not "optimise", "standardize" not "standardise", "color" not "colour", "organization" not "organisation").

{sections_block}
```

**Main-call user message:**

```text
Generate an implementation plan to transition from the current state to the future state for the following process:

- Current State Process: {current_process}
- Future State Process: {future_process}

Source documents:

{document_text[:12000]}

{params_block — see below if implementation parameters were selected}
```

If implementation parameters were chosen, this `params_block` is appended:

```text
The plan must specifically address the following implementation parameters throughout the content — weave them into every relevant section:
- **{Param Label}:** {Param description}
- **{Param Label}:** {Param description}
...
```

**Tail-call user message:**

```text
Generate the sections listed in your instructions for this process:

- Current State Process: {current_process}
- Future State Process: {future_process}

Source documents:

{document_text[:8000]}

Implementation plan already written (use for assumption cross-referencing only):

{first_3000_chars_of_main_body}
```

### Output structure — `IMPL_PLAN_SECTIONS` (verbatim)

1. **executive_summary — Executive Summary:** "Brief overview of the transformation and expected benefits."
2. **gap_analysis — Gap Analysis:** "Key differences between current state and future state — what needs to change."
3. **implementation_phases — Implementation Phases:** "Break the transition into clear phases (e.g. Phase 1: Discovery, Phase 2: Design, Phase 3: Implementation, Phase 4: Testing, Phase 5: Go-Live & Stabilisation). For each phase include: **Objective:** What this phase achieves, **Key Activities:** Bullet list of tasks, **Deliverables:** Tangible outputs, **Timeline:** Suggested duration (weeks), **Owner / Responsible Party:** Who leads this phase."
4. **resource_requirements — Resource Requirements:** "People, tools, systems, and budget considerations."
5. **risks_mitigations — Risks & Mitigations:** "Top risks with likelihood, impact, and mitigation actions."
6. **success_metrics — Success Metrics & KPIs:** "How to measure a successful transition."
7. **change_management — Change Management:** "Stakeholder communication, training needs, and adoption strategy."
8. **value_add — Value Add from Current State to Future State** (rendered in the **tail call**, not the main body): The model is told to produce this exact sub-structure verbatim:

   ```text
   ### Executive Summary
   One paragraph summarising the overall business value created by the future state.

   ### Value Add by Dimension
   For each relevant dimension below provide three items: Current State Issue, Future State Improvement, and Business Value Created. Cover all that apply:
   1. Efficiency and Cycle Time
   2. Process Simplification
   3. Standardization
   4. Controls and Risk Management
   5. Data Quality and Transparency
   6. Roles and Accountability
   7. Technology Enablement / Automation Readiness
   8. Customer / Stakeholder Impact

   ### Key Value Add Themes
   Top 5–7 value themes in bullet form.

   ### Suggested Wording for Implementation Plan
   5 concise, executive-ready statements that can be inserted directly into an implementation plan or steering committee deck.

   Rules for this section:
   - Do not make unsupported numerical claims. Where quantitative evidence is not provided, use directional language: "expected to reduce", "likely to improve", "creates the foundation for", "enables more consistent"
   - Be specific and structured; avoid vague buzzwords
   - Do not repeat the same point in different words
   - Write in a concise, polished consulting tone as if preparing client-facing transformation material
   - Express value in terms of: cycle time reduction, reduced rework, fewer handoffs, improved standardisation, better control environment, improved data quality, higher operational efficiency, lower cost to serve, reduced risk / compliance exposure, improved employee experience, improved customer experience, scalability / readiness for automation or AI
   ```

9. **sources — Sources and Assumptions** (always produced in the tail call): Two-part: source documents (with `**Source:** description` format) and metric assumptions (`**Assumption [Ax]:** description` matching every inline `<sup>[Ax]</sup>` marker).

After both calls, `_impl_sources_to_end()` collapses every `## Sources and Assumptions` block to a single one at the end of the document (the last/most-complete one is kept).

### Notable business taxonomy — `IMPL_PARAMETERS` (verbatim implementation parameters that can be selected to bias the plan)

| ID | Label | Description |
|---|---|---|
| `business_continuity` | Business Continuity | "Ensure no disruption to operations, with parallel systems and rollback options." |
| `customer_experience` | Customer Experience | "Maintain or improve speed, transparency, and satisfaction throughout the transition." |
| `phased_delivery` | Phased Delivery | "Implement in waves, prioritising high-volume, low-complexity use cases to deliver quick wins." |
| `human_in_the_loop` | Human-in-the-Loop | "Augment staff with automation/AI while retaining human oversight and escalation for complex decisions." |
| `data_governance` | Data & Governance | "Establish high-quality data foundations and strong governance (accuracy, fairness, auditability)." |
| `technology_flexibility` | Technology Flexibility | "Use modular, API-driven architecture that integrates with legacy systems." |
| `regulatory_compliance` | Regulatory Compliance | "Ensure explainability, audit trails, and alignment with applicable regulations." |
| `change_management` | Change Management | "Redesign roles, train employees, and drive adoption through clear communication and incentives." |
| `financial_accountability` | Financial Accountability | "Track ROI with clear metrics and tie investment to measurable outcomes." |
| `performance_measurement` | Performance Measurement | "Define and monitor KPIs (e.g. cycle time, cost per unit, error rate, customer satisfaction)." |
| `scalability` | Scalability | "Build solutions that can expand across products, regions, and volumes over time." |
| `governance_leadership` | Governance & Leadership | "Establish clear ownership, decision rights, and strong executive sponsorship." |

### Deliverable formats

- Markdown returned by `POST /api/generate-implementation-plan` (used in-browser inside the process-map page and the automation-options page).
- No dedicated DOCX/PPTX export endpoint for the implementation plan markdown — the new tool should add this. (The old tool surfaces this markdown inline and lets the user copy/paste, or it is exported via the Business Case PPTX path if the user is in the Business Case flow.)

### Endpoints

- `POST /api/generate-implementation-plan` — fields: `files`, `current_process`, `future_process`, `sections_json`, `parameters_json`. Always force-appends `'sources'` to the selected sections if missing.

---

## Business Case Generator

### Purpose
Produce a "Process Optimisation Business Case" markdown document (rendered to DOCX or wide-screen PPTX) covering current state, target state, financial impact, risks, ROI, and implementation plan — with ESOAR improvement focus selectable.

### User-facing positioning

The Business Case generator shares the `process-document.html` page (the SOP/Business Case toggle) and is positioned on the landing page as part of **Step 7 — SOP & Business Case Generator** (tags: "SOP", "Business Case"). The card copy:

> "Produce structured SOPs and Business Cases to lock in and communicate the future state."

### Inputs
- `files: List[UploadFile]`
- `process_name: str`
- `focuses_json` — subset of ESOAR focus IDs (`eliminate`, `standardize`, `optimize`, `automate`, `robotize`)
- `sections_json` — subset of `BC_SECTIONS_META` IDs

### Prompts

**System prompt (`BC_SYSTEM_PROMPT`) — verbatim:**

```text
You are a senior management consultant specialising in process optimisation and automation.

Generate a professional Process Optimisation Business Case in markdown format based on the source documents provided.

Formatting rules:
- Use # for the document title only (H1)
- Use ## for section headings (H2)
- Use numbered lists (1. 2. 3.) for sequential items such as steps and phases
- Use bullet lists (- ) for non-sequential items
- Use **Bold:** format for key-value pairs and financial figures
- All financial figures, costs, savings, ROI, and estimates MUST be expressed in US Dollars (USD, $). Never use GBP, £, EUR, or any other currency.
- Use American English spelling throughout (e.g., "analyze" not "analyse", "optimize" not "optimise", "standardize" not "standardise", "color" not "colour", "organization" not "organisation").
- ASSUMPTION REFERENCES: Every quantitative figure in the document (dollar amounts, cost savings, ROI, FTE counts, cycle times, processing times, error rates, payback periods, percentages, etc.) MUST be followed immediately by an inline superscript reference marker in the format <sup>[A1]</sup>, <sup>[A2]</sup>, <sup>[A3]</sup> etc. These markers must correspond exactly to numbered **Assumption [A1]:** entries in the Sources section. Number assumptions sequentially across the entire document.
- Do NOT use strikethrough text (~~text~~). Never cross out, mark out, or use strikethrough formatting anywhere in the document.
- Do NOT use ALL CAPS text anywhere in the document. Use normal sentence case or title case only.
- Do NOT use markdown tables
- Do NOT include any explanation outside the document itself — return only the business case
```

**Runtime appendix:**

```text
The document must start with:
# Process Optimisation Business Case: [Process Name]
**Prepared by:** POET  **Date:** {today}
---

Improvement focus areas to analyse:
{focus_block — bullet list of selected ESOAR focuses with their full descriptions}

Then include exactly these sections in this order:

{numbered list of selected sections from BC_SECTIONS_META}
```

**User message:**

```text
Generate a business case for the "{process_name}" process. Focus areas: {comma-separated focus IDs}. Based on the following source documents:

{combined_text[:12000]}
```

### Output structure — `BC_SECTIONS_META` (verbatim)

1. **executive_summary — Executive Summary:** "A concise standalone overview (2-3 paragraphs) for senior stakeholders covering: the current process, proposed improvements, expected benefits, investment required, and recommendation."
2. **current_state — Current State:** "Describe the current process in detail: manual steps, pain points, inefficiencies, error rates, cycle times, FTE effort, and cost of poor quality. Reference specifics from the uploaded documents."
3. **target_state — Target State:** "Describe the proposed future-state process after implementing improvements. Cover: redesigned process flow, automation touchpoints, changes to roles, and key differences from current state."
4. **risk_control — Risk & Control Impact:** "Analyse how the proposed improvements affect existing controls. Identify controls that will be automated or enhanced, any new risks introduced, and residual manual controls required."
5. **regulatory — Regulatory Considerations:** "Identify regulatory, compliance, or legal implications. Reference applicable regulations, internal policies, and any approval or notification requirements before implementation."
6. **financial_impact — Financial Impact:** "Provide a quantified ROI analysis including: estimated annual cost savings, FTE reduction or redeployment, one-off implementation costs, ongoing operational savings, and payback period. Use **Label:** value format for key figures."
7. **implementation_plan — Implementation Plan:** "Outline a phased implementation approach with: key phases, milestones, indicative timeline, resource requirements, dependencies, and change management considerations. Use numbered list format."
8. **technology_requirements — Technology Requirements:** "List the systems, tools, platforms, and integrations required. Include infrastructure changes, licensing considerations, vendor options, and build vs buy assessment."
9. **governance — Governance & Ownership:** "Define the governance structure: process owner, project sponsor, steering committee, and ongoing operational ownership post-implementation."
10. **risks_mitigations — Risks & Mitigations:** "Identify the top risks to the initiative with mitigations. Cover: delivery risks, adoption risks, regulatory risks, and operational risks. Use **Risk:** mitigation format for each pair."
11. **sources — Sources and Assumptions:** Same two-part format as SOP/impl plan: `**Source:**` entries and `**Assumption [Ax]:**` entries matching inline `<sup>[Ax]</sup>` markers.
12. **glossary — Acronym & Term Dictionary:** Alphabetised `**TERM / ACRONYM:** definition` entries.

**Defaults (`BC_DEFAULT_SECTIONS`):** `['executive_summary', 'current_state', 'target_state', 'financial_impact', 'implementation_plan', 'risks_mitigations', 'sources']`.

### ESOAR taxonomy — `IMPROVEMENT_FOCUS_META` (verbatim improvement focus framing)

The ESOAR framework is the central improvement taxonomy. Each focus is described to Claude verbatim:

- **eliminate** — "Eliminate (ESOAR): Identify and remove non-value-adding steps, redundant activities, unnecessary approvals, and process waste. Apply value stream analysis to surface steps that add cost or delay without delivering customer or business value."
- **standardize** — "Standardize (ESOAR): Establish consistent, repeatable process templates and controls. Identify process variations, inconsistencies across teams or locations, and opportunities to introduce standard operating procedures, checklists, and governance frameworks."
- **optimize** — "Optimize (ESOAR): Improve throughput, quality, and efficiency within the existing process. Identify bottlenecks, SLA breaches, handoff delays, rework loops, and opportunities for LEAN continuous improvement, workload balancing, and skill-to-task alignment."
- **automate** — "Automate (ESOAR): Apply rules-based workflow automation, business rules engines, and system-triggered actions to reduce manual intervention. Identify decision points, approvals, notifications, and data routing that can be handled by digital workflows."
- **robotize** — "Robotize (ESOAR): Apply Robotic Process Automation (RPA) or AI-driven intelligent automation to high-volume, repetitive tasks. Identify candidates for software bots, document processing AI, NLP, predictive analytics, and cognitive automation."

### Deliverable formats

- **Markdown** via `POST /api/generate-business-case`.
- **DOCX export** via `POST /api/export-business-case` (re-uses `_make_sop_docx`).
- **PPTX export** via `_make_bc_pptx` (lines 3396+). Slide layout:
  - 16:9 widescreen (13.33 × 7.5 in).
  - **Cover slide:** dark navy background (`#0F172A`), full-width blue accent bars top and bottom (`#1E40AF`, 0.12 in tall), process name in 36 pt bold white at y≈2.5 in, today's date (long-form) in 14 pt light blue (`#93C5FD`) at y≈4.2 in.
  - **Content slides:** light-grey (`#F8FAFC`) background, 0.07-in navy accent bar on the left, slide title in 16 pt bold dark navy (`#0F172A`), thin blue divider line.
  - Each `##` section becomes a table on its own slide (or paginated across slides). Header row 0.38 in tall, data rows 0.28 in tall, hard cap of **12 rows per slide** to guarantee fit; if a section has more rows, slides are titled "Section (1/3)", "Section (2/3)", etc.
  - Column-width algorithm: narrow first column (~28%) when the first header is ≤ 3 chars (e.g. `#`, `Ref`); otherwise weight columns by header length (≤3 chars = weight 1, ≤8 chars = weight 3, else weight 6).
  - Legend is always moved to be the final slide.

### Endpoints

- `POST /api/generate-business-case` — fields: `files`, `process_name`, `focuses_json`, `sections_json`.
- `POST /api/export-business-case` — fields: `bc_markdown`, `process_name`, `format` (`docx` or `pptx`).

---

## Process Health Scorecard

### Purpose
Produce a RAG-rated (Red/Amber/Green) health assessment of a single process across a selectable subset of LEAN and ESOAR dimensions, with priority improvement opportunities.

### User-facing positioning (from `process-health-scorecard.html`)

> "Process Health Scorecard — POET"
>
> "Upload process documents to receive a RAG-rated health assessment across ESOAR and LEAN dimensions — identifying waste, inefficiency, automation potential, and rework."

Landing-page card description: "RAG-rated assessment to quantify inefficiencies, risk exposure, and automation potential." Tags: "RAG Rating", "LEAN / ESOAR".

### Inputs
- `files: List[UploadFile]`
- `process_name: str` (required)
- `industry: str` (optional — drives an industry note in the user message)
- `dimensions_json` — subset of dimension keys (default: all eight)
- `include_glossary: str` ("true"/"false") — appends an acronym dictionary section

### Prompts

**System prompt (`SCORECARD_PROMPT`) — verbatim:**

```text
You are a senior process excellence consultant. Analyse the uploaded process documentation and produce a Process Health Scorecard.

FORMAT RULES — follow exactly:
- Use markdown with ## for section headings, ### for sub-headings, **bold** for labels
- Do NOT use strikethrough text (~~text~~) under any circumstances
- Do NOT use ALL CAPS text anywhere in the document. Use normal sentence case or title case only.
- Do NOT include a title or preamble — start directly with the first section
- All financial figures must be in US Dollars (USD, $). Never use GBP, £, EUR, or any other currency.
- Use American English spelling throughout (e.g., "analyze" not "analyse", "optimize" not "optimise", "standardize" not "standardise", "color" not "colour", "organization" not "organisation").
- For every metric cited, add a superscript reference marker inline: value<sup>[A1]</sup>
- The Legend section MUST appear as the very last section in the document, after Sources and Assumptions

STRUCTURE — include only the selected dimensions:
1. ## Executive Health Summary — overall RAG rating (Red / Amber / Green), 3–5 sentence narrative
2. ## Scorecard by Dimension — for each selected dimension:
   ### [Dimension Name] — Rating: [RED / AMBER / GREEN]
   - Current state observation
   - Key issues identified
   - Recommended improvement action
3. ## Priority Improvement Opportunities — top 3–5 ranked opportunities with estimated impact and priority (HIGH / MEDIUM / LOW)
4. ## Sources and Assumptions — numbered list [A1], [A2]... with derivation detail
5. ## Legend — ALWAYS include this as the very last section. Do NOT use bullet points or list markers for legend items — write each as a plain paragraph line:
**RED** — Significant problems identified. Urgent attention and remediation required. Process is materially inefficient, high-risk, or broken in this area.
**AMBER** — Notable issues present. Improvement is recommended. Process functions but has clear gaps, inefficiencies, or risks that should be addressed.
**GREEN** — Performing well. Minor improvements may be beneficial but no urgent action required.
**High / Medium / Low** (where used) — Indicates the priority or severity of an improvement opportunity: High = address immediately, Medium = plan within current cycle, Low = monitor or address when capacity allows.
All ratings are based on evidence from the uploaded source documents and consultant judgement where document data is limited.

RATING CRITERIA:
- GREEN: performing well, minor improvements only
- AMBER: notable issues, improvement recommended
- RED: significant problems, urgent attention required

Be specific and evidence-based — reference actual content from the uploaded documents.
```

**User message template:**

```text
Process name: {process_name}.{industry_note}

Assess the following dimensions only:
- {Dimension 1 label}
- {Dimension 2 label}
...

Source documents:

{combined_text[:12000]}

{glossary_note if include_glossary}
```

Where `industry_note` is `" The process operates in the {industry} sector."` (or empty), and the optional glossary note instructs the model to add a final `## Acronym & Term Dictionary` section alphabetically formatted as `**TERM / ACRONYM:** plain-English definition.`

### Output structure (rigid section order)

1. **## Executive Health Summary** — overall RAG rating + 3–5 sentence narrative.
2. **## Scorecard by Dimension** — one `### [Dimension] — Rating: [RED/AMBER/GREEN]` block per selected dimension, with `Current state observation`, `Key issues identified`, `Recommended improvement action` bullets.
3. **## Priority Improvement Opportunities** — top 3–5 ranked with HIGH/MEDIUM/LOW priority + estimated impact.
4. **## Sources and Assumptions** — numbered `[A1], [A2]…`
5. **## Legend** — must be the very last section. Plain-paragraph definitions of RED, AMBER, GREEN, and High/Medium/Low.
6. (Optional) **## Acronym & Term Dictionary** — only when glossary requested.

### Notable business taxonomy — eight LEAN/ESOAR dimensions

```python
dim_labels = {
    'waste':           'Waste & Non-Value-Adding Activity (LEAN)',
    'handoffs':        'Handoffs & Waiting Time',
    'automation':      'Automation Potential (ESOAR)',
    'rework':          'Rework & Exception Rate',
    'standardisation': 'Standardisation & Consistency',
    'controls':        'Controls & Risk Exposure',
    'data_quality':    'Data Quality & Availability',
    'customer':        'Customer / Stakeholder Impact',
}
```

**Default selection** when none provided: all eight dimensions.

**RAG rating scale:**
- **RED:** Significant problems identified. Urgent attention and remediation required. Materially inefficient, high-risk, or broken in this area.
- **AMBER:** Notable issues present. Improvement is recommended. Functions but has clear gaps.
- **GREEN:** Performing well. Minor improvements may be beneficial but no urgent action required.

**Priority scale:**
- **HIGH** — address immediately.
- **MEDIUM** — plan within current cycle.
- **LOW** — monitor or address when capacity allows.

### Deliverable formats

- Markdown via `POST /api/generate-scorecard` (response key `sc_markdown`).
- **DOCX export** via `POST /api/export-scorecard` using `_make_sop_docx` (heading/colour palette identical to the SOP DOCX template).
- **PPTX export** via the same `_make_bc_pptx` table-renderer used by the Business Case (so each `##` section becomes a clean table slide; Legend slide is forced to last).

### Endpoints

- `POST /api/generate-scorecard` — fields: `files`, `process_name`, `industry`, `dimensions_json`, `include_glossary`.
- `POST /api/export-scorecard` — fields: `sc_markdown`, `process_name`, `format` (`docx` / `pptx`).

---

## RACI Matrix Generator

### Purpose
Produce a Responsible / Accountable / Consulted / Informed matrix for a process, plus a role glossary, key findings (accountability gaps), recommendations, sources/assumptions, and optional acronym dictionary. Every section is rendered as a markdown table — this is the only generator where tables are mandatory.

### User-facing positioning (from `raci-matrix.html`)

> "RACI Matrix Generator — POET"
>
> "Upload a process map, SOP, or workflow document to automatically generate a Responsible, Accountable, Consulted, Informed (RACI) matrix by role and activity."

Landing-page card description: "Define roles, accountability, and ownership across the redesigned process with gap analysis." Tags: "RACI Table", "Gap Analysis".

### Inputs
- `files: List[UploadFile]`
- `process_name: str` (required)
- `granularity: str` (default `"detailed"`) — one of `high`, `detailed`, `task`
- `sections_json` — list of sections to include (raci_matrix, role_glossary, key_findings, recommendations, sources, glossary)

### Prompts

**System prompt (`RACI_PROMPT`) — verbatim:**

```text
You are a senior business analyst and process governance expert. Analyse the uploaded process documentation and produce a professional RACI Matrix document.

FORMAT RULES — follow exactly:
- Use markdown with ## for section headings
- Do NOT use strikethrough text (~~text~~) under any circumstances
- Do NOT use ALL CAPS text anywhere in the document. Use normal sentence case or title case only.
- Do NOT include a title or preamble — start directly with the first section
- All financial figures must be in US Dollars (USD, $). Never use GBP, £, EUR, or any other currency.
- Use American English spelling throughout (e.g., "analyze" not "analyse", "optimize" not "optimise", "standardize" not "standardise", "color" not "colour", "organization" not "organisation").
- ALL sections must be formatted as markdown tables — no prose paragraphs, no bullet lists
- Do NOT output any unstructured text blocks anywhere in the document

RACI MATRIX FORMAT:
| Activity | Role 1 | Role 2 | Role 3 | ... |
|---|---|---|---|---|
| **Section Name** | | | | |
| Activity name | R | A | C | ... |

Use only: R (Responsible), A (Accountable), C (Consulted), I (Informed). Each row must have exactly one A.
Group activities under bold section-header rows (all non-Activity cells empty).

ROLE GLOSSARY FORMAT — render as a markdown table:
| Role | Description | Typical Job Titles |
|---|---|---|
| Role name | One-sentence description of responsibilities | Title 1, Title 2 |

KEY FINDINGS FORMAT — render as a markdown table:
| Finding | Affected Role(s) | Recommended Action |
|---|---|---|
| Issue description | Role name | Action to take |

RECOMMENDATIONS FORMAT — render as a markdown table:
| # | Recommendation | Priority | Rationale |
|---|---|---|---|
| 1 | Action to take | High / Medium / Low | Why this matters |

SOURCES AND ASSUMPTIONS FORMAT — render as a markdown table:
| Ref | Assumption / Source | Basis |
|---|---|---|
| A1 | Statement of assumption | Where it came from |

ACRONYM DICTIONARY FORMAT — render as a markdown table:
| Term / Acronym | Definition |
|---|---|
| TERM | Plain-English definition |

STRUCTURE (include only selected sections):
- ## RACI Matrix
- ## Role Glossary
- ## Key Findings & Accountability Gaps
- ## Recommendations
- ## Sources and Assumptions
- ## Acronym & Term Dictionary — only if "glossary" is in the sections list

GRANULARITY GUIDANCE:
- high: 5–12 major activities (phase-level)
- detailed: 15–30 activities (function-level)
- task: 30–60 activities (individual task-level)

Be specific — use role names and activity names drawn directly from the uploaded documents.
```

**User message:**

```text
Process name: {process_name}
Activity granularity: {granularity}
Sections to include: {comma-separated section names}

Source documents:

{combined_text[:12000]}
```

### Output structure (markdown tables, one per section)

1. **## RACI Matrix** — columns: `Activity | Role 1 | Role 2 | Role 3 | …`. Activities grouped under bold section-header rows. Cells use only `R`, `A`, `C`, `I`. Exactly one `A` per row.
2. **## Role Glossary** — `Role | Description | Typical Job Titles`.
3. **## Key Findings & Accountability Gaps** — `Finding | Affected Role(s) | Recommended Action`.
4. **## Recommendations** — `# | Recommendation | Priority (High/Medium/Low) | Rationale`.
5. **## Sources and Assumptions** — `Ref | Assumption / Source | Basis`.
6. **## Acronym & Term Dictionary** (optional) — `Term / Acronym | Definition`.

### Notable business taxonomy

- **Granularity scale:**
  - `high` — 5–12 major activities (phase-level).
  - `detailed` — 15–30 activities (function-level).
  - `task` — 30–60 activities (individual task-level).
- **RACI letters:** Only `R`, `A`, `C`, `I` permitted. Each activity row must have **exactly one A**.
- **Priority scale on recommendations:** High / Medium / Low.

### Deliverable formats

- Markdown via `POST /api/generate-raci` (response key `raci_markdown`).
- **DOCX export** via `POST /api/export-raci` (re-uses `_make_sop_docx`, which renders markdown tables as Word tables).
- **PPTX export** via `_make_bc_pptx` (each table → its own slide, paginated to 12 rows per slide).

### Endpoints

- `POST /api/generate-raci` — fields: `files`, `process_name`, `granularity`, `sections_json`.
- `POST /api/export-raci` — fields: `raci_markdown`, `process_name`, `format` (`docx` / `pptx`).

---

## Change Impact Assessment

### Purpose
Compare current-state and future-state process documentation and produce a structured Change Impact Assessment by stakeholder group, with people/skills, technology/systems, change-risk, and recommended-action sections.

### User-facing positioning (from `change-impact-assessment.html`)

> "Change Impact Assessment — POET"
>
> "Upload current and future state process documents to generate a structured Change Impact Assessment — analysing what changes, who is affected, and how significantly, by stakeholder group."

Landing-page card description: "Assess stakeholder impact, readiness, and recommended change actions across the transition." Tags: "Stakeholder Impact", "Change Actions".

### Inputs
- `current_files: List[UploadFile]` (at least one)
- `future_files: List[UploadFile]` (at least one)
- `process_name: str` (required)
- `depth: str` (default `"standard"`) — `summary` / `standard` / `detailed`
- `sections_json` — defaults to `['executive_summary', 'change_overview', 'stakeholder_impact', 'sources']`. `'sources'` is force-appended if missing.

### Prompts

**System prompt (`CIA_PROMPT`) — verbatim:**

```text
You are a senior change management and process transformation consultant. Analyse the current state and future state process documents provided and produce a structured Change Impact Assessment.

FORMAT RULES — follow exactly:
- Use markdown with ## for section headings, ### for sub-headings, **bold** for labels
- Do NOT use strikethrough text (~~text~~) under any circumstances
- Do NOT use ALL CAPS text anywhere in the document. Use normal sentence case or title case only.
- Do NOT include a title or preamble — start directly with the first section
- All financial figures must be in US Dollars (USD, $). Never use GBP, £, EUR, or any other currency.
- Use American English spelling throughout (e.g., "analyze" not "analyse", "optimize" not "optimise", "standardize" not "standardise", "color" not "colour", "organization" not "organisation").
- For every metric or assumption cited, add a superscript reference marker: value<sup>[A1]</sup>
- At the end, include a "## Sources and Assumptions" section listing every [A1], [A2]... marker with derivation, source, and caveats

STRUCTURE (include only selected sections):
- ## Executive Summary — 3–5 sentences: what is changing, overall impact magnitude, key recommendation
- ## Change Overview — what is driving the change, scope, timeline if known
- ## Stakeholder Impact by Group — for each stakeholder group:
  ### [Group Name] — Impact Level: [HIGH / MEDIUM / LOW]
  - What changes for them, skills/behaviour changes required, recommended engagement approach
- ## Process Delta (What Changes) — comparison of key process steps: what is removed, added, or modified
- ## People & Skills Impact — FTE changes, new skills required, training needs
- ## Technology & Systems Impact — systems added, retired, or changed; data migration considerations
- ## Risk & Change Readiness — top 3–5 change risks with likelihood, impact, and mitigation
- ## Recommended Change Actions — prioritised action plan: communication, training, transition management
- ## Sources and Assumptions — numbered [A1], [A2]... with derivation detail
- ## Acronym & Term Dictionary — if "glossary" is in the sections list, include an alphabetical dictionary of all acronyms, abbreviations, and industry-specific terms used in the document. Format each entry as **TERM / ACRONYM:** plain-English definition.

DEPTH GUIDANCE:
- summary: 2–3 bullets per section, high-level only
- standard: 4–6 bullets per section, balanced detail
- detailed: 8–12 bullets per section, comprehensive analysis

Base all findings on the actual content of the uploaded documents. Highlight gaps where information is limited.
```

**User message:**

```text
Process name: {process_name}
Analysis depth: {depth}
Sections to include: {comma-separated section names}

=== CURRENT STATE DOCUMENTS ===
{current_text[:6000]}

=== FUTURE STATE DOCUMENTS ===
{future_text[:6000]}
```

### Output structure (in this rigid order)

1. **## Executive Summary** — 3–5 sentences (what's changing, overall magnitude, key recommendation).
2. **## Change Overview** — drivers, scope, timeline if known.
3. **## Stakeholder Impact by Group** — for each group: `### [Group Name] — Impact Level: [HIGH / MEDIUM / LOW]` plus what changes, skills/behaviour change required, recommended engagement approach.
4. **## Process Delta (What Changes)** — added / removed / modified steps.
5. **## People & Skills Impact** — FTE changes, new skills, training needs.
6. **## Technology & Systems Impact** — systems added/retired/changed, data migration.
7. **## Risk & Change Readiness** — top 3–5 change risks with likelihood, impact, mitigation.
8. **## Recommended Change Actions** — prioritised action plan: communication, training, transition management.
9. **## Sources and Assumptions** — `[A1], [A2]…` numbered list with derivation detail.
10. **## Acronym & Term Dictionary** (optional, only when `glossary` is in sections).

### Notable business taxonomy

- **Impact level scale (per stakeholder group):** HIGH / MEDIUM / LOW.
- **Analysis depth scale:**
  - `summary` — 2–3 bullets per section, high-level only.
  - `standard` — 4–6 bullets per section, balanced detail.
  - `detailed` — 8–12 bullets per section, comprehensive analysis.
- Always splits source corpus into two named blocks (current vs future) so the model can reason about deltas.

### Deliverable formats

- Markdown via `POST /api/generate-cia` (response key `cia_markdown`).
- **DOCX export** via `POST /api/export-cia` using `_make_sop_docx`.
- No native PPTX exporter is wired up for CIA in the legacy code (TODO if needed — `_make_bc_pptx` could be reused).

### Endpoints

- `POST /api/generate-cia` — fields: `current_files`, `future_files`, `process_name`, `depth`, `sections_json`.
- `POST /api/export-cia` — fields: `cia_markdown`, `process_name`, `format` (currently only `docx`).

---

## Appendix — Markers of unfinished / draft work

Items the legacy code reveals as incomplete or rough; future re-implementers should treat these as known TODOs rather than polished decisions:

- **CIA PPTX export is absent.** Other deliverables export to both DOCX and PPTX; CIA only ships DOCX.
- **Implementation Plan has no dedicated export endpoint** — the markdown is rendered inline in the process-map page or piggybacked through the Business Case PPTX renderer if reached from the Business Case flow.
- **BPMN levels stop at L4** in the legacy implementation. The product positioning copy on the landing page also refers to "L1–L4", so the canonical taxonomy is 4 levels deep — not 6. If a 5- or 6-level taxonomy is desired, it must be designed from scratch.
- **PNG export is referenced in the Process Map UI** ("PowerPoint (.pptx) / PNG Image (.png) / Visio (.vsdx)") but the backend `/api/export` only handles `pptx`, `docx`, and `vsdx`. PNG is generated client-side from the BPMN renderer and downloaded from the browser, not by the backend.
- **`_make_sop_docx` is reused as the catch-all DOCX renderer** for SOP, Business Case, Scorecard, RACI, and CIA. Section-specific table styling for RACI may not render perfectly through this generic path — the RACI tables work because the renderer happens to detect markdown tables, but no RACI-specific table styling exists.
- **Anglicized spelling appears in code despite "American English" rule.** Several places in the prompts and section descriptions use British spellings in instructions even while telling the model to output American spelling. The model handles this fine, but a cleanup pass is warranted for consistency. **When re-implementing, audit every prompt — system instructions, section descriptions, and inline examples — not just the output-formatting rules.** Suggested find-and-replace list:
    - `optimise` → `optimize` (also `optimisation`, `optimised`, `optimising`)
    - `standardise` → `standardize` (also `standardisation`, `standardised`)
    - `analyse` → `analyze` (also `analysis` already American — no change)
    - `organisation` → `organization` (also `organisational`, `organisations`)
    - `summarising` → `summarizing` (also `summarise`, `summarised`)
    - `colour` → `color` (also `coloured`, `colouring`)
    - `centralise` → `centralize`, `prioritise` → `prioritize`, `categorise` → `categorize`, `realise` → `realize`, `recognise` → `recognize`
  Run a final spellcheck with an American-English dictionary on the prompt corpus before shipping.
- **"POET" branding** is hard-coded into prompts ("**Prepared by:** POET"). New tool will need to either preserve POET branding or template-ize it.
- **No persistence of generation history** — every call is stateless; the legacy tool never stored prior generations, drafts, or versions. The new tool's versioning features (per recent commits `7e52746`, `a5b7d61`, `660c7f9`) are net-new and have no legacy counterpart.
- **Document truncation is silent.** The 8K / 12K / 6K character caps will drop content from long source documents without warning the user. A re-implementation should at minimum surface a "source truncated at N chars" notice.
- **Single hard-coded model** (`claude-sonnet-4-6`) with no per-tool model override. The new tool should make the model configurable per generator.

This document, plus the prompts and taxonomies above, is the canonical reference. The legacy `backend/main.py` and `public/*.html` can be safely deleted once the new tool re-implements (or knowingly drops) each of the seven deliverables above.
