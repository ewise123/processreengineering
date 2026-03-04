import os
import io
import re
import json
import math
import base64
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import List
from datetime import date

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from dotenv import load_dotenv
import anthropic

# Document parsers
import pdfplumber
from docx import Document as DocxDocument
from pptx import Presentation

load_dotenv()

app = FastAPI(title="POET API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".doc", ".pptx", ".ppt", ".txt"}
MAX_FILE_SIZE_MB = 20


# ── Document parsers ──────────────────────────────────────────────────────────

def extract_text_from_pdf(file_bytes: bytes) -> str:
    text_parts = []
    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)
    return "\n\n".join(text_parts)


def extract_text_from_docx(file_bytes: bytes) -> str:
    doc = DocxDocument(io.BytesIO(file_bytes))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    for table in doc.tables:
        for row in table.rows:
            row_text = " | ".join(cell.text.strip() for cell in row.cells if cell.text.strip())
            if row_text:
                paragraphs.append(row_text)
    return "\n".join(paragraphs)


def extract_text_from_pptx(file_bytes: bytes) -> str:
    prs = Presentation(io.BytesIO(file_bytes))
    slide_texts = []
    for i, slide in enumerate(prs.slides, 1):
        parts = [f"[Slide {i}]"]
        for shape in slide.shapes:
            if hasattr(shape, "text") and shape.text.strip():
                parts.append(shape.text.strip())
        if len(parts) > 1:
            slide_texts.append("\n".join(parts))
    return "\n\n".join(slide_texts)


def extract_text(file_bytes: bytes, filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext == ".pdf":
        return extract_text_from_pdf(file_bytes)
    elif ext in (".docx", ".doc"):
        return extract_text_from_docx(file_bytes)
    elif ext in (".pptx", ".ppt"):
        return extract_text_from_pptx(file_bytes)
    elif ext == ".txt":
        return file_bytes.decode("utf-8", errors="ignore")
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")


# ── Process structure extraction via Claude ───────────────────────────────────

STRUCTURE_PROMPT = """You are a business process analyst. Extract the key process steps from the document and represent them using BPMN 2.0 notation standards.

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
- Maximum 10 steps total
- Step IDs must be unique snake_case strings
- The "role" field is REQUIRED for every step — identify the actor, department, or system. If unspecified, use "Process Team"
- Group related steps under the same role name so swimlanes are meaningful
- Include gateways only where there is a clear decision or split in the process
- If no clear branches exist, return an empty gateways array"""


LEVEL_INSTRUCTIONS = {
    "1": (
        "This is a LEVEL 1 process map — high-level overview only. "
        "Extract only the major phases or stages (aim for 4–6 steps). "
        "Do not include sub-tasks, detailed decisions, or system interactions. "
        "Use broad role names (e.g. 'Business', 'Management')."
    ),
    "2": (
        "This is a LEVEL 2 process map — key activities within each phase. "
        "Extract the main activities (aim for 6–8 steps). "
        "Include significant decision points but omit low-level sub-tasks. "
        "Assign roles to each step."
    ),
    "3": (
        "This is a LEVEL 3 process map — detailed steps and decision points. "
        "Extract all meaningful steps and decisions (up to 10 steps). "
        "Include all decision gateways where the process branches. "
        "Assign specific roles or departments to each step."
    ),
    "4": (
        "This is a LEVEL 4 process map — task-level detail with system interactions. "
        "Extract every individual task and system interaction (up to 10 steps, prioritise the most important). "
        "Include all decision points. "
        "Assign precise roles, systems, or tools to each step (e.g. 'ERP System', 'Finance Analyst')."
    ),
}


def extract_process_structure(client: anthropic.Anthropic, document_text: str, bpmn_level: str = "2") -> dict:
    level_note = LEVEL_INSTRUCTIONS.get(bpmn_level, LEVEL_INSTRUCTIONS["2"])
    system_prompt = STRUCTURE_PROMPT + f"\n\nIMPORTANT — Detail level instruction:\n{level_note}"
    truncated = document_text[:8000] if len(document_text) > 8000 else document_text
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        system=system_prompt,
        messages=[{
            "role": "user",
            "content": f"Extract the process structure from this document:\n\n{truncated}"
        }]
    )
    raw = message.content[0].text.strip()
    # Strip any accidental markdown fences
    raw = re.sub(r"^```[a-zA-Z]*\n?", "", raw)
    raw = re.sub(r"\n?```$", "", raw).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"Could not parse process structure from Claude response: {e}")


# ── Programmatic BPMN XML generation with swimlanes ──────────────────────────

def _strip_actor(name: str, role: str) -> str:
    """Remove a leading actor/role prefix from a task label.

    The actor is already shown in the swimlane header so prefixing it in the
    task name is redundant.  Handles exact role match as well as individual
    words within the role (e.g. role='Risk Engineering / Actuarial' strips
    leading 'Risk', 'Engineering', or 'Actuarial').
    """
    if not name or not role:
        return name
    # Try full role string first (e.g. "Broker sends…" when role="Broker")
    for candidate in [role] + role.replace('/', ' ').split():
        candidate = candidate.strip()
        if len(candidate) < 3:
            continue
        if name.lower().startswith(candidate.lower()):
            remainder = name[len(candidate):].lstrip(' \t-–:,')
            if remainder:
                return remainder[0].upper() + remainder[1:]
    return name


def build_bpmn_xml(structure: dict) -> str:
    process_name = structure.get("process_name", "Process")
    steps        = structure.get("steps", [])
    gateways     = structure.get("gateways", [])

    # ── Collect unique roles in document order ────────────────────────────────
    role_order: list[str] = []
    _seen: set[str] = set()
    for step in steps:
        r = (step.get("role") or "Process Team").strip()
        if r not in _seen:
            role_order.append(r)
            _seen.add(r)
    if not role_order:
        role_order = ["Process Team"]

    def lane_of(role: str) -> int:
        r = (role or "Process Team").strip()
        return role_order.index(r) if r in _seen else 0

    # ── Layout constants ──────────────────────────────────────────────────────
    POOL_HDR_W  = 30    # pool name strip width (vertical label on far left)
    CONTENT_OFF = 100   # x-offset from P_X to the first element centre
    H_STEP      = 175   # horizontal distance between element centres
    LANE_H      = 150   # height of each swim lane
    P_X         = 50    # participant left x
    P_Y         = 50    # participant top y
    MARGIN_R    = 100   # right padding after last element

    # Canonical BPMN 2.0 task element names — all task variants share the same size
    TASK_TYPES = {"userTask", "serviceTask", "manualTask", "businessRuleTask",
                  "sendTask", "receiveTask", "scriptTask", "task"}
    GATEWAY_TYPES = {"exclusive", "parallel", "inclusive"}
    # Map gateway type strings from Claude → BPMN 2.0 element names
    GATEWAY_ELEMENT = {
        "exclusive": "exclusiveGateway",
        "parallel":  "parallelGateway",
        "inclusive": "inclusiveGateway",
    }

    SIZES: dict[str, tuple[int, int]] = {
        "startEvent": (36, 36),
        "endEvent":   (36, 36),
        "task":       (120, 80),   # 80 px tall: 24 px icon zone + 56 px for text
        "gateway":    (50, 50),
    }

    # ── Build ordered element list ────────────────────────────────────────────
    gateway_map = {gw["after_step"]: gw for gw in gateways}
    first_role  = (steps[0].get("role") or "Process Team").strip() if steps else "Process Team"
    last_role   = (steps[-1].get("role") or "Process Team").strip() if steps else "Process Team"

    elements: list[dict] = []
    elements.append({"id": "Start_1", "type": "startEvent", "name": "Start", "role": first_role})
    for step in steps:
        role = (step.get("role") or "Process Team").strip()
        task_name = _strip_actor(step.get("name", ""), role)
        # Honour the step type from Claude; fall back to userTask if absent/unknown
        raw_type = (step.get("type") or "userTask").strip()
        step_type = raw_type if raw_type in TASK_TYPES else "userTask"
        elements.append({"id": step["id"], "type": step_type, "name": task_name, "role": role})
        if step["id"] in gateway_map:
            gw = gateway_map[step["id"]]
            gw_type = GATEWAY_ELEMENT.get((gw.get("type") or "exclusive").strip(), "exclusiveGateway")
            elements.append({"id": gw["id"], "type": gw_type,
                             "name": gw.get("name", "Decision?"),
                             "yes_label": gw.get("yes_label", "Yes"),
                             "no_label":  gw.get("no_label",  "No"),
                             "role": role})
    elements.append({"id": "End_1", "type": "endEvent", "name": "End", "role": last_role})

    # ── Assign positions (all elements share same centre-Y within their lane) ──
    for col, el in enumerate(elements):
        li   = lane_of(el["role"])
        # All task variants share the task size; gateways share the gateway size
        size_key = (el["type"] if el["type"] in SIZES
                    else "task" if el["type"] in TASK_TYPES
                    else "gateway" if "Gateway" in el["type"]
                    else "task")
        w, h = SIZES[size_key]
        cx   = P_X + CONTENT_OFF + col * H_STEP
        cy   = P_Y + li * LANE_H + LANE_H // 2
        el.update({
            "col": col, "lane_idx": li, "w": w, "h": h,
            "cx": cx, "cy": cy,
            "x": cx - w // 2, "y": cy - h // 2,
        })
        el["right_x"] = cx + w // 2
        el["left_x"]  = cx - w // 2
        el["top_y"]   = cy - h // 2
        el["bot_y"]   = cy + h // 2

    el_by_id = {el["id"]: el for el in elements}

    # Participant bounding box
    last_cx = max(el["cx"] for el in elements)
    P_W     = (last_cx - P_X) + SIZES["task"][0] // 2 + MARGIN_R
    P_H     = len(role_order) * LANE_H

    # ── Build sequence flows ──────────────────────────────────────────────────
    flows: list[dict] = []
    fc = [1]
    # Use .get() + `or` so that None / missing no_to both fall back to "End_1"
    gateway_no = {gw["id"]: (gw.get("no_to") or "") for gw in gateways}

    def add_flow(src_id: str, tgt_id: str, name: str = "") -> None:
        fid = f"Flow_{fc[0]}"; fc[0] += 1
        src = el_by_id.get(src_id)
        tgt = el_by_id.get(tgt_id)
        if not (src and tgt):
            return
        forward   = tgt["col"] > src["col"]
        adjacent  = abs(tgt["col"] - src["col"]) == 1
        same_lane = src["lane_idx"] == tgt["lane_idx"]

        # ── Corridor calculation ─────────────────────────────────────────────
        # For skip/loop routing we must use the corridor of whichever lane is
        # furthest in the routing direction, so the final vertical segment always
        # approaches the target from OUTSIDE its bounding box (never through it).
        #
        # Skip-forward → route via the BOTTOM corridor of the lowest lane
        #   (highest lane_idx) involved.  The arrow descends into the corridor,
        #   travels horizontally, then rises to the target's bottom edge.
        #
        # Backward loop → route via the TOP corridor of the highest lane
        #   (lowest lane_idx) involved.  The arrow rises into the corridor,
        #   travels horizontally, then descends to the target's top edge.
        max_lane = max(src["lane_idx"], tgt["lane_idx"])
        min_lane = min(src["lane_idx"], tgt["lane_idx"])
        bot_corridor = P_Y + (max_lane + 1) * LANE_H - 15   # below all elements in max_lane
        top_corridor = P_Y + min_lane * LANE_H + 15          # above all elements in min_lane

        if forward and adjacent and same_lane:
            # Straight horizontal arrow within same lane
            wps = [(src["right_x"], src["cy"]),
                   (tgt["left_x"],  tgt["cy"])]
        elif forward and adjacent:
            # Adjacent elements in different lanes: L-shape at midpoint x
            mid_x = (src["right_x"] + tgt["left_x"]) // 2
            wps = [(src["right_x"], src["cy"]),
                   (mid_x,          src["cy"]),
                   (mid_x,          tgt["cy"]),
                   (tgt["left_x"],  tgt["cy"])]
        elif forward:
            # Skip-forward: descend to bottom corridor of the lowest lane,
            # travel right, then rise to the target's bottom edge — never
            # enters the target task from inside
            wps = [(src["cx"], src["bot_y"]),
                   (src["cx"], bot_corridor),
                   (tgt["cx"], bot_corridor),
                   (tgt["cx"], tgt["bot_y"])]
        else:
            # Backward loop: rise to top corridor of the highest lane,
            # travel left, then descend to the target's top edge — never
            # enters the target task from inside
            wps = [(src["cx"], src["top_y"]),
                   (src["cx"], top_corridor),
                   (tgt["cx"], top_corridor),
                   (tgt["cx"], tgt["top_y"])]

        # Pin Yes/No label at the actual exit vertex of the arrow.
        # The first waypoint (wps[0]) tells us which vertex the flow leaves from:
        #   right vertex  → (right_x, cy)   — forward flows
        #   bottom vertex → (cx, bot_y)     — skip-forward flows
        #   top vertex    → (cx, top_y)     — backward-loop flows
        # We match with a 2 px tolerance and place the label just outside that vertex.
        label_bounds = None
        if name and "Gateway" in src["type"] and src["type"] != "parallelGateway":
            ex, ey = wps[0]
            if abs(ex - src["right_x"]) <= 2:          # exits RIGHT → label above the line
                label_bounds = (ex + 4,  ey - 18, 30, 14)
            elif abs(ey - src["bot_y"]) <= 2:           # exits BOTTOM → label right of line
                label_bounds = (ex + 4,  ey + 4,  30, 14)
            elif abs(ey - src["top_y"]) <= 2:           # exits TOP (backward loop) → above
                label_bounds = (ex + 4,  ey - 18, 30, 14)
            else:                                        # fallback
                label_bounds = (ex + 4,  ey - 14, 30, 14)

        flows.append({"id": fid, "source": src_id, "target": tgt_id,
                      "name": name, "waypoints": wps, "label_bounds": label_bounds})

    for i in range(len(elements) - 1):
        src = elements[i]
        nxt = elements[i + 1]
        if "Gateway" in src["type"]:
            is_parallel = src["type"] == "parallelGateway"
            # Always use "Yes"/"No" — short labels that never overlap adjacent shapes
            add_flow(src["id"], nxt["id"], "" if is_parallel else "Yes")
            no_tgt = gateway_no.get(src["id"]) or "End_1"
            # Fallback 1: LLM gave a non-existent step ID — use End_1.
            if no_tgt not in el_by_id:
                no_tgt = "End_1"
            # Fallback 2: LLM set no_to == the Yes-path target (same element).
            # Both connectors would share an identical route and render as ONE
            # overlapping arrow with both labels on it.  Force No to End_1.
            if no_tgt == nxt["id"]:
                no_tgt = "End_1"
            # Only emit the No flow when it genuinely reaches a different element
            # (edge-case guard: if the gateway sits right before End_1, skip to
            # avoid two identical arrows — the diamond degrades to one exit).
            if no_tgt != nxt["id"]:
                add_flow(src["id"], no_tgt, "" if is_parallel else "No")
        else:
            add_flow(src["id"], nxt["id"])

    # ── Build XML ─────────────────────────────────────────────────────────────
    lines: list[str] = []
    lines.append('<?xml version="1.0" encoding="UTF-8"?>')
    lines.append('<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"')
    lines.append('             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"')
    lines.append('             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"')
    lines.append('             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"')
    lines.append('             id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">')

    # Collaboration wrapper (required for BPMN 2.0 pools with lanes)
    lines.append('  <collaboration id="Collab_1">')
    lines.append(f'    <participant id="Part_1" name="{_esc(process_name)}" processRef="Process_1"/>')
    lines.append('  </collaboration>')

    # Process
    lines.append(f'  <process id="Process_1" name="{_esc(process_name)}" isExecutable="false">')

    # Lane set — one lane per unique role
    lines.append('    <laneSet id="LaneSet_1">')
    for li, role in enumerate(role_order):
        lid = f"Lane_{li + 1}"
        lines.append(f'      <lane id="{lid}" name="{_esc(role)}">')
        for el in elements:
            if el["lane_idx"] == li:
                lines.append(f'        <flowNodeRef>{el["id"]}</flowNodeRef>')
        lines.append(f'      </lane>')
    lines.append('    </laneSet>')

    # Flow nodes — emit typed BPMN 2.0 elements
    for el in elements:
        eid, ename, etype = el["id"], _esc(el["name"]), el["type"]
        if etype == "startEvent":
            lines.append(f'    <startEvent id="{eid}" name="{ename}"/>')
        elif etype == "endEvent":
            lines.append(f'    <endEvent id="{eid}" name="{ename}"/>')
        elif "Gateway" in etype:
            lines.append(f'    <{etype} id="{eid}" name="{ename}"/>')
        elif etype in TASK_TYPES:
            lines.append(f'    <{etype} id="{eid}" name="{ename}"/>')
        else:
            lines.append(f'    <userTask id="{eid}" name="{ename}"/>')

    # Sequence flows
    for fl in flows:
        na = f' name="{_esc(fl["name"])}"' if fl["name"] else ""
        lines.append(f'    <sequenceFlow id="{fl["id"]}" sourceRef="{fl["source"]}" targetRef="{fl["target"]}"{na}/>')

    lines.append('  </process>')

    # ── Diagram section ───────────────────────────────────────────────────────
    lines.append('  <bpmndi:BPMNDiagram id="BPMNDiagram_1">')
    lines.append('    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Collab_1">')

    # Participant (pool) shape
    lines.append(f'      <bpmndi:BPMNShape id="Shape_Part_1" bpmnElement="Part_1" isHorizontal="true">')
    lines.append(f'        <dc:Bounds x="{P_X}" y="{P_Y}" width="{P_W}" height="{P_H}"/>')
    lines.append(f'      </bpmndi:BPMNShape>')

    # Lane shapes
    for li, role in enumerate(role_order):
        lid = f"Lane_{li + 1}"
        lines.append(f'      <bpmndi:BPMNShape id="Shape_{lid}" bpmnElement="{lid}" isHorizontal="true">')
        lines.append(f'        <dc:Bounds x="{P_X + POOL_HDR_W}" y="{P_Y + li * LANE_H}" width="{P_W - POOL_HDR_W}" height="{LANE_H}"/>')
        lines.append(f'      </bpmndi:BPMNShape>')

    # Element shapes
    _TYPED_TASKS = {"userTask", "serviceTask", "manualTask", "businessRuleTask",
                    "sendTask", "receiveTask", "scriptTask"}
    for el in elements:
        lines.append(f'      <bpmndi:BPMNShape id="Shape_{el["id"]}" bpmnElement="{el["id"]}">')
        lines.append(f'        <dc:Bounds x="{el["x"]}" y="{el["y"]}" width="{el["w"]}" height="{el["h"]}"/>')
        if "Gateway" in el["type"]:
            # Place the question label to the TOP-LEFT of the diamond so it
            # never overlaps the Yes label (right exit) or No label (bottom exit).
            # Right-align the label box at the diamond centre — text stays
            # entirely left of the Yes arrow which exits from the right vertex.
            # With H_STEP=175 and task_w=120 there is ~90 px of clear space
            # between the incoming task's right edge and the diamond centre,
            # so lx = cx - GW_LBL_W lands safely in that gap.
            GW_LBL_W = 90
            GW_LBL_H = 40
            GAP       = 6
            lx = el["cx"] - GW_LBL_W   # right edge at diamond centre
            ly = el["top_y"] - GW_LBL_H - GAP
            lines.append(f'        <bpmndi:BPMNLabel>')
            lines.append(f'          <dc:Bounds x="{lx}" y="{ly}" width="{GW_LBL_W}" height="{GW_LBL_H}"/>')
            lines.append(f'        </bpmndi:BPMNLabel>')
        elif el["type"] in _TYPED_TASKS:
            # bpmn-js renders the task-type marker icon at the top-left corner of
            # the shape (5 px inset, ~15 px tall → bottom edge ≈ shape.y + 20).
            # Set explicit label bounds that start BELOW the icon so the text
            # never overlaps it.  Height is reduced accordingly.
            ICON_H = 24
            lines.append(f'        <bpmndi:BPMNLabel>')
            lines.append(f'          <dc:Bounds x="{el["x"]}" y="{el["y"] + ICON_H}" width="{el["w"]}" height="{el["h"] - ICON_H}"/>')
            lines.append(f'        </bpmndi:BPMNLabel>')
        lines.append(f'      </bpmndi:BPMNShape>')

    # Edge shapes
    for fl in flows:
        if not fl["waypoints"]:
            continue
        lines.append(f'      <bpmndi:BPMNEdge id="Edge_{fl["id"]}" bpmnElement="{fl["id"]}">')
        for wx, wy in fl["waypoints"]:
            lines.append(f'        <di:waypoint x="{wx}" y="{wy}"/>')
        if fl.get("label_bounds"):
            lx, ly, lw, lh = fl["label_bounds"]
            lines.append(f'        <bpmndi:BPMNLabel>')
            lines.append(f'          <dc:Bounds x="{lx}" y="{ly}" width="{lw}" height="{lh}"/>')
            lines.append(f'        </bpmndi:BPMNLabel>')
        lines.append(f'      </bpmndi:BPMNEdge>')

    lines.append('    </bpmndi:BPMNPlane>')
    lines.append('  </bpmndi:BPMNDiagram>')
    lines.append('</definitions>')

    return "\n".join(lines)


def _esc(text: str) -> str:
    """Escape XML special characters in attribute values."""
    return (text
            .replace("&", "&amp;")
            .replace('"', "&quot;")
            .replace("<", "&lt;")
            .replace(">", "&gt;"))


def validate_xml(xml_str: str) -> tuple[bool, str]:
    try:
        ET.fromstring(xml_str.encode("utf-8"))
        return True, ""
    except ET.ParseError as e:
        return False, str(e)


# ── BPMN parser ───────────────────────────────────────────────────────────────

def _parse_bpmn(bpmn_xml: str):
    """Parse BPMN 2.0 XML from bpmn-js.

    Returns (proc_shapes, cont_shapes, connections) where:
      proc_shapes  = process elements (tasks/events/gateways):
                     [{'id','type','name','x','y','w','h'}, ...]  pixels
      cont_shapes  = container elements (participants/lanes):
                     [{'id','type','name','x','y','w','h'}, ...]  pixels
      connections  = sequence flows:
                     [{'id','source','target','wps','name'}, ...]

    Returns ([], [], []) on any error so callers can fall back to PNG.

    NOTE: cont_shapes are ordered participants-first so renderers can draw
    the pool border before the individual lane backgrounds.
    """
    if not bpmn_xml:
        return [], [], []
    # Types that are pool/lane containers — NOT rendered as process shapes
    CONTAINER_TYPES = {'participant', 'lane', 'collaboration', 'process', 'laneset'}
    try:
        root = ET.fromstring(bpmn_xml)
        BPMNDI = 'http://www.omg.org/spec/BPMN/20100524/DI'
        DC     = 'http://www.omg.org/spec/DD/20100524/DC'
        DI     = 'http://www.omg.org/spec/DD/20100524/DI'

        sem: dict = {}
        for el in root.iter():
            eid = el.get('id')
            if eid:
                tag = el.tag.split('}')[-1] if '}' in el.tag else el.tag
                sem[eid] = {
                    'type':   tag,
                    'name':   el.get('name', ''),
                    'source': el.get('sourceRef', ''),
                    'target': el.get('targetRef', ''),
                }

        proc_shapes: list = []
        cont_shapes: list = []
        for s in root.iter(f'{{{BPMNDI}}}BPMNShape'):
            eid    = s.get('bpmnElement', '')
            bounds = s.find(f'{{{DC}}}Bounds')
            if bounds is None:
                continue
            info = sem.get(eid, {'type': 'task', 'name': ''})
            entry = {
                'id':   eid,
                'type': info['type'],
                'name': info['name'],
                'x':    float(bounds.get('x', 0)),
                'y':    float(bounds.get('y', 0)),
                'w':    float(bounds.get('width',  100)),
                'h':    float(bounds.get('height',  80)),
            }
            if info['type'].lower() in CONTAINER_TYPES:
                cont_shapes.append(entry)
            else:
                proc_shapes.append(entry)

        # Participants first so renderers draw pool border before lane fills
        cont_shapes.sort(key=lambda s: (0 if s['type'].lower() == 'participant' else 1,
                                        s['y'], s['x']))

        connections: list = []
        for e in root.iter(f'{{{BPMNDI}}}BPMNEdge'):
            eid  = e.get('bpmnElement', '')
            info = sem.get(eid, {})
            wps  = [(float(wp.get('x', 0)), float(wp.get('y', 0)))
                    for wp in e.iter(f'{{{DI}}}waypoint')]
            connections.append({
                'id':     eid,
                'source': info.get('source', ''),
                'target': info.get('target', ''),
                'wps':    wps,
                'name':   info.get('name', ''),
            })
        return proc_shapes, cont_shapes, connections
    except Exception:
        return [], [], []


# ── Export helpers ────────────────────────────────────────────────────────────

def _make_pptx(png_bytes: bytes, process_name: str, bpmn_xml: str = '') -> bytes:
    from pptx import Presentation as PRS
    from pptx.util import Inches, Pt, Emu
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_AUTO_SHAPE_TYPE, MSO_CONNECTOR_TYPE
    from pptx.enum.text import PP_ALIGN, MSO_AUTO_SIZE

    prs = PRS()
    proc_shapes, cont_shapes, connections = _parse_bpmn(bpmn_xml)

    if proc_shapes:
        # ── coordinate mapping ───────────────────────────────────────────────
        # Use the full extent (including lane/pool containers) so shape positions
        # are consistent with the container backgrounds.
        all_shp = proc_shapes + cont_shapes
        min_x = min(s['x']           for s in all_shp)
        min_y = min(s['y']           for s in all_shp)
        max_x = max(s['x'] + s['w'] for s in all_shp)
        max_y = max(s['y'] + s['h'] for s in all_shp)

        MARGIN  = 304800          # 1/3" in EMU
        TITLE_H = 457200          # 0.5" in EMU
        src_w   = max(max_x - min_x, 1)
        src_h   = max(max_y - min_y, 1)

        # Natural scale: 1 BPMN pixel = 1/96 inch = 9525 EMU.
        # This keeps shapes at their natural readable size (tasks ~1.25" wide).
        # The slide expands to fit the diagram rather than squishing it.
        SCALE = 914400 // 96   # 9525 EMU/px

        # Set slide dimensions to fit the full diagram at natural scale
        prs.slide_width  = int(src_w * SCALE + 2 * MARGIN)
        prs.slide_height = int(src_h * SCALE + TITLE_H + 2 * MARGIN)
        slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank

        def bx(px): return MARGIN + int((px - min_x) * SCALE)
        def by(py): return MARGIN + TITLE_H + int((py - min_y) * SCALE)
        def bw(pw): return max(int(pw * SCALE), 1)

        # ── title ─────────────────────────────────────────────────────────────
        title_w = int(src_w * SCALE)  # span full diagram width
        tb = slide.shapes.add_textbox(MARGIN, int(MARGIN * 0.4), title_w, TITLE_H)
        tf = tb.text_frame
        tf.text = process_name
        run = tf.paragraphs[0].runs[0]
        run.font.size  = Pt(16)
        run.font.bold  = True
        run.font.color.rgb = RGBColor(0x1F, 0x2D, 0x3D)

        # ── 1. Lane / pool backgrounds (drawn first → bottom of z-stack) ─────
        LANE_FILLS   = [RGBColor(0xDA, 0xE8, 0xFC), RGBColor(0xEB, 0xF3, 0xFF)]
        LANE_BORDER  = RGBColor(0x6C, 0x8E, 0xBF)
        PART_BORDER  = RGBColor(0x4A, 0x6E, 0x9A)
        lanes = [s for s in cont_shapes if s['type'].lower() == 'lane']
        parts = [s for s in cont_shapes if s['type'].lower() == 'participant']

        for s in parts:
            sx, sy, sw, sh = bx(s['x']), by(s['y']), bw(s['w']), bw(s['h'])
            rect = slide.shapes.add_shape(MSO_AUTO_SHAPE_TYPE.RECTANGLE, sx, sy, sw, sh)
            rect.fill.background()              # transparent interior
            rect.line.color.rgb = PART_BORDER
            rect.line.width     = Emu(19050)    # 1.5 pt

        for li, s in enumerate(lanes):
            sx, sy, sw, sh = bx(s['x']), by(s['y']), bw(s['w']), bw(s['h'])
            rect = slide.shapes.add_shape(MSO_AUTO_SHAPE_TYPE.RECTANGLE, sx, sy, sw, sh)
            rect.fill.solid()
            rect.fill.fore_color.rgb = LANE_FILLS[li % 2]
            rect.line.color.rgb      = LANE_BORDER
            rect.line.width          = Emu(9525)
            # No text in the lane rectangle itself — use a separate label text box
            # so the lane name stays in a controlled area at the left of the lane.
            if s['name']:
                # narrow label band at the left edge of the lane
                lbl_w = max(bw(90), 457200)         # ≥ 90 bpmn-px or 0.5"
                lbl   = slide.shapes.add_textbox(sx, sy, lbl_w, sh)
                lf    = lbl.text_frame
                lf.word_wrap = True
                lf.auto_size = MSO_AUTO_SIZE.NONE   # fixed size, text wraps inside
                lf.text = s['name']
                for para in lf.paragraphs:
                    para.alignment = PP_ALIGN.LEFT
                    for r2 in para.runs:
                        r2.font.size      = Pt(8)
                        r2.font.bold      = True
                        r2.font.color.rgb = RGBColor(0x2C, 0x3E, 0x50)

        # ── 2. Connectors (behind process shapes) ─────────────────────────────
        from pptx.oxml import parse_xml as _pptx_parse_xml
        _TAIL_ARROW = (
            '<a:tailEnd xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
            ' type="arrow" w="med" len="med"/>'
        )
        for conn in connections:
            wps        = conn['wps']
            flow_label = conn.get('name', '')
            if len(wps) < 2:
                continue
            # Draw each waypoint segment so bent/multi-hop paths render correctly.
            # Only the LAST segment gets the arrowhead (pointing at the target shape).
            for seg_i in range(len(wps) - 1):
                x0, y0 = bx(wps[seg_i][0]),     by(wps[seg_i][1])
                x1, y1 = bx(wps[seg_i + 1][0]), by(wps[seg_i + 1][1])
                cxn = slide.shapes.add_connector(MSO_CONNECTOR_TYPE.STRAIGHT, x0, y0, x1, y1)
                cxn.line.color.rgb = RGBColor(0x44, 0x44, 0x44)
                cxn.line.width     = Emu(12700)    # 1 pt
                if seg_i == len(wps) - 2:          # last segment → add arrowhead
                    cxn.line._ln.append(_pptx_parse_xml(_TAIL_ARROW))

            # ── Yes / No (or other flow name) label near source exit point ──────
            # Position depends on whether the flow exits horizontally (→ label
            # above the line) or vertically (→ label to the right of the line).
            if flow_label:
                ex_px, ey_px = wps[0]
                d_x = wps[1][0] - wps[0][0]
                d_y = wps[1][1] - wps[0][1]
                if abs(d_x) >= abs(d_y):    # horizontal exit: label above
                    lx_px, ly_px = ex_px + 4, ey_px - 16
                else:                        # vertical exit: label right of line
                    lx_px, ly_px = ex_px + 4, ey_px + 4
                flbl = slide.shapes.add_textbox(
                    bx(lx_px), by(ly_px), bw(35), bw(14))
                flf  = flbl.text_frame
                flf.word_wrap = False
                flf.text      = flow_label
                for para in flf.paragraphs:
                    para.alignment = PP_ALIGN.LEFT
                    for run in para.runs:
                        run.font.size      = Pt(7)
                        run.font.italic    = True
                        run.font.color.rgb = RGBColor(0x44, 0x44, 0x44)

        # ── 3. Process shapes (top of z-stack) ────────────────────────────────
        # Matching bpmn-js rendering exactly:
        #   • Tasks/subprocesses → text INSIDE the shape (auto-shrink to fit)
        #   • Events             → oval with no text, label text box BELOW
        #   • Gateways           → diamond with no text, label text box ABOVE
        SHAPE_CFG = {
            'startevent':        (MSO_AUTO_SHAPE_TYPE.OVAL,            RGBColor(0x67, 0xAB, 0x9F)),
            'endevent':          (MSO_AUTO_SHAPE_TYPE.OVAL,            RGBColor(0xC0, 0x39, 0x2B)),
            'intermediateevent': (MSO_AUTO_SHAPE_TYPE.OVAL,            RGBColor(0xF3, 0x9C, 0x12)),
            'exclusivegateway':  (MSO_AUTO_SHAPE_TYPE.DIAMOND,         RGBColor(0xF5, 0xCB, 0x5C)),
            'inclusivegateway':  (MSO_AUTO_SHAPE_TYPE.DIAMOND,         RGBColor(0xF5, 0xCB, 0x5C)),
            'parallelgateway':   (MSO_AUTO_SHAPE_TYPE.DIAMOND,         RGBColor(0xF5, 0xCB, 0x5C)),
            'subprocess':        (MSO_AUTO_SHAPE_TYPE.RECTANGLE,       RGBColor(0xAF, 0xC1, 0xD6)),
        }
        DEFAULT_CFG = (MSO_AUTO_SHAPE_TYPE.ROUNDED_RECTANGLE, RGBColor(0xDA, 0xE8, 0xFC))

        # Label box dimensions matching build_bpmn_xml gateway label bounds.
        # Width=90 px, Height=50 px (fits 3 lines). Anchored so the box BOTTOM
        # is 4 px above the diamond top — same logic as the BPMN XML label.
        LBL_W_PX = 90
        LBL_H_PX = 50   # increased from 28 so multi-line labels don't overflow
        GAP_PX   = 4

        for s in proc_shapes:
            typ = s['type'].lower()
            key = next((k for k in SHAPE_CFG if k in typ), None)
            stype, colour = SHAPE_CFG[key] if key else DEFAULT_CFG

            sx, sy, sw, sh = bx(s['x']), by(s['y']), bw(s['w']), bw(s['h'])
            pshape = slide.shapes.add_shape(stype, sx, sy, sw, sh)
            pshape.fill.solid()
            pshape.fill.fore_color.rgb = colour
            pshape.line.color.rgb      = RGBColor(0x55, 0x55, 0x55)
            pshape.line.width          = Emu(9525)

            is_event   = 'event'   in typ
            is_gateway = 'gateway' in typ

            if is_event or is_gateway:
                # Shape has no text — label goes in a separate text box
                pshape.text_frame.text = ''
                if s['name']:
                    # Events: label below the shape;  Gateways: label above.
                    # Gateway bottom-anchored: box bottom = shape top - GAP_PX
                    lbl_cx = s['x'] + s['w'] / 2 - LBL_W_PX / 2
                    if is_gateway:
                        lbl_y = s['y'] - LBL_H_PX - GAP_PX  # bottom edge = shape top - gap
                    else:
                        lbl_y = s['y'] + s['h'] + 2           # below event
                    lbl_sx = bx(lbl_cx)
                    lbl_sy = max(by(lbl_y), MARGIN + TITLE_H)
                    lbl_sw = bw(LBL_W_PX)
                    lbl_sh = bw(LBL_H_PX)
                    lbl = slide.shapes.add_textbox(lbl_sx, lbl_sy, lbl_sw, lbl_sh)
                    lf  = lbl.text_frame
                    lf.word_wrap = True
                    # Let the text box grow to fit the label text
                    lf.text = s['name']
                    for para in lf.paragraphs:
                        para.alignment = PP_ALIGN.CENTER
                        for r2 in para.runs:
                            r2.font.size      = Pt(7)
                            r2.font.color.rgb = RGBColor(0x1A, 0x1A, 0x1A)
            else:
                # Tasks / subprocesses: text inside, auto-shrink to fit shape
                tf = pshape.text_frame
                tf.word_wrap = True
                tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
                if s['name']:
                    tf.text = s['name']
                    for para in tf.paragraphs:
                        para.alignment = PP_ALIGN.CENTER
                        for r2 in para.runs:
                            r2.font.size      = Pt(8)
                            r2.font.color.rgb = RGBColor(0x1A, 0x1A, 0x1A)

    else:
        # ── fallback: PNG image ────────────────────────────────────────────────
        prs.slide_width  = Emu(12192000)   # 13.33"
        prs.slide_height = Emu(6858000)    # 7.5"
        slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank
        tb = slide.shapes.add_textbox(Inches(0.4), Inches(0.15), Inches(12.5), Inches(0.6))
        tf = tb.text_frame
        tf.text = process_name
        run = tf.paragraphs[0].runs[0]
        run.font.size = Pt(20); run.font.bold = True
        slide.shapes.add_picture(io.BytesIO(png_bytes),
                                 Inches(0.4), Inches(0.9), Inches(12.5), Inches(6.3))

    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()


def _make_docx(png_bytes: bytes, process_name: str, bpmn_xml: str = '') -> bytes:
    from docx import Document
    from docx.shared import Inches, Pt
    from lxml import etree

    doc = Document()
    sec = doc.sections[0]

    proc_shapes, cont_shapes, connections = _parse_bpmn(bpmn_xml)

    if proc_shapes:
        DPI       = 96.0
        EMU_IN    = 914400        # EMU per inch
        MARGIN_IN = 0.5
        TITLE_IN  = 0.45

        all_shp = proc_shapes + cont_shapes
        min_x = min(s['x']           for s in all_shp)
        min_y = min(s['y']           for s in all_shp)
        max_x = max(s['x'] + s['w'] for s in all_shp)
        max_y = max(s['y'] + s['h'] for s in all_shp)

        # OOXML page size limit: 31 680 twips = 22 inches per dimension.
        # If the diagram at natural 1px=1/96" scale exceeds 22" wide, scale
        # it down proportionally so everything fits horizontally.
        # Page height is fixed to landscape-letter (11"); content taller than
        # that spills naturally to subsequent pages via the floating-shape y-offset.
        OOXML_MAX_IN  = 22.0    # Word/OOXML hard cap per axis
        PAGE_H_IN     = 11.0    # landscape-letter height (standard print size)

        src_w_in = max((max_x - min_x) / DPI, 0.1)
        src_h_in = max((max_y - min_y) / DPI, 0.1)

        usable_w_in = OOXML_MAX_IN - 2 * MARGIN_IN
        # Scale = 1.0 (natural) unless diagram is wider than the max usable width
        scale = min(usable_w_in / src_w_in, 1.0)

        page_w_in = src_w_in * scale + 2 * MARGIN_IN   # always ≤ OOXML_MAX_IN
        # Height: use the standard page height; tall diagrams overflow to page 2+
        page_h_in = PAGE_H_IN

        sec.page_width   = int(page_w_in * EMU_IN)
        sec.page_height  = int(page_h_in * EMU_IN)
        sec.left_margin  = sec.right_margin  = int(MARGIN_IN * EMU_IN)
        sec.top_margin   = sec.bottom_margin = int(MARGIN_IN * EMU_IN)

        def ex(px): return int((MARGIN_IN + (px - min_x) / DPI * scale) * EMU_IN)
        def ey(py): return int((MARGIN_IN + TITLE_IN + (py - min_y) / DPI * scale) * EMU_IN)
        def ew(pw): return max(int(pw / DPI * scale * EMU_IN), 91440)

        FILL = {
            'startevent': '67AB9F', 'endevent': 'C0392B',
            'intermediateevent': 'F39C12',
            'exclusivegateway': 'F5CB5C', 'inclusivegateway': 'F5CB5C',
            'parallelgateway': 'F5CB5C', 'subprocess': 'AFC1D6',
        }
        DEFAULT_FILL = 'DAE8FC'
        LANE_FILLS   = ['DAE8FC', 'EBF3FF']
        GEOM = {'event': 'ellipse', 'gateway': 'diamond'}

        W   = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
        WP  = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
        A   = 'http://schemas.openxmlformats.org/drawingml/2006/main'
        WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape'

        # Use a single empty paragraph as the anchor for all floating shapes.
        # The title is rendered as a floating text box so the custom page
        # dimensions fully control layout without the heading paragraph
        # causing Word to extend the visible area.
        float_para = doc.add_paragraph()
        run = float_para.add_run()
        sid = 1

        # ── 0. Title floating text box ─────────────────────────────────────
        title_x = int(MARGIN_IN * EMU_IN)
        title_y = int(MARGIN_IN * 0.3 * EMU_IN)
        title_w = int(src_w_in * scale * EMU_IN)
        title_h = int(TITLE_IN * EMU_IN)
        title_xml = (
            f'<w:drawing xmlns:w="{W}">'
            f'<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0"'
            f' relativeHeight="500" behindDoc="0" locked="0"'
            f' layoutInCell="1" allowOverlap="1" xmlns:wp="{WP}">'
            f'<wp:simplePos x="0" y="0"/>'
            f'<wp:positionH relativeFrom="page"><wp:posOffset>{title_x}</wp:posOffset></wp:positionH>'
            f'<wp:positionV relativeFrom="page"><wp:posOffset>{title_y}</wp:posOffset></wp:positionV>'
            f'<wp:extent cx="{title_w}" cy="{title_h}"/>'
            f'<wp:effectExtent l="0" t="0" r="0" b="0"/>'
            f'<wp:wrapNone/>'
            f'<wp:docPr id="0" name="Title"/>'
            f'<wp:cNvGraphicFramePr/>'
            f'<a:graphic xmlns:a="{A}">'
            f'<a:graphicData uri="{WPS}">'
            f'<wps:wsp xmlns:wps="{WPS}">'
            f'<wps:cNvSpPr><a:spLocks noChangeArrowheads="1"/></wps:cNvSpPr>'
            f'<wps:spPr>'
            f'<a:xfrm><a:off x="0" y="0"/><a:ext cx="{title_w}" cy="{title_h}"/></a:xfrm>'
            f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
            f'<a:noFill/><a:ln><a:noFill/></a:ln>'
            f'</wps:spPr>'
            f'<wps:txbx>'
            f'<w:txbxContent>'
            f'<w:p><w:pPr><w:jc w:val="left"/></w:pPr>'
            f'<w:r><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/>'
            f'<w:color w:val="1F2D3D"/></w:rPr>'
            f'<w:t xml:space="preserve">{_esc(process_name)}</w:t></w:r></w:p>'
            f'</w:txbxContent>'
            f'</wps:txbx>'
            f'<wps:bodyPr anchor="ctr"/>'
            f'</wps:wsp>'
            f'</a:graphicData>'
            f'</a:graphic>'
            f'</wp:anchor>'
            f'</w:drawing>'
        )
        run._r.append(etree.fromstring(title_xml.encode('utf-8')))

        def _anchor(sid, x_e, y_e, w_e, h_e, prst, fill_hex, label,
                    behind=False, rh=20000, text_align='center',
                    is_line=False, fh='0', fv='0', arrow=False,
                    no_fill=False):
            """Build a <w:drawing><wp:anchor> XML string for a floating shape.

            no_fill=True → transparent background and no border (used for
            external label text boxes placed above/below events and gateways).
            """
            bd  = '1' if behind else '0'
            if is_line:
                tail_xml = ('<a:tailEnd type="arrow" w="sm" len="sm"/>'
                            if arrow else '')
                spPr = (
                    f'<a:xfrm flipH="{fh}" flipV="{fv}">'
                    f'<a:off x="0" y="0"/><a:ext cx="{w_e}" cy="{h_e}"/></a:xfrm>'
                    f'<a:prstGeom prst="line"><a:avLst/></a:prstGeom>'
                    f'<a:noFill/>'
                    f'<a:ln w="9525"><a:solidFill><a:srgbClr val="444444"/></a:solidFill>'
                    f'{tail_xml}</a:ln>'
                )
                body   = '<wps:bodyPr/>'
                txbx   = ''
                cNvSp  = f'<wps:cNvSpPr isConnector="1"><a:spLocks noChangeArrowheads="1"/></wps:cNvSpPr>'
            else:
                if no_fill:
                    fill_ln = '<a:noFill/><a:ln><a:noFill/></a:ln>'
                else:
                    lnFill   = '6C8EBF' if fill_hex in (LANE_FILLS + ['FFFFFF']) else '555555'
                    fill_ln  = (f'<a:solidFill><a:srgbClr val="{fill_hex}"/></a:solidFill>'
                                f'<a:ln w="9525"><a:solidFill><a:srgbClr val="{lnFill}"/></a:solidFill></a:ln>')
                spPr = (
                    f'<a:xfrm><a:off x="0" y="0"/><a:ext cx="{w_e}" cy="{h_e}"/></a:xfrm>'
                    f'<a:prstGeom prst="{prst}"><a:avLst/></a:prstGeom>'
                    f'{fill_ln}'
                )
                esc_label = _esc(label) if label else ''
                txbx = (
                    f'<wps:txbx>'
                    f'<w:txbxContent>'
                    f'<w:p><w:pPr><w:jc w:val="{text_align}"/></w:pPr>'
                    f'<w:r><w:rPr><w:sz w:val="14"/><w:szCs w:val="14"/></w:rPr>'
                    f'<w:t xml:space="preserve">{esc_label}</w:t></w:r></w:p>'
                    f'</w:txbxContent>'
                    f'</wps:txbx>'
                )
                # normAutofit = "shrink text on overflow" (prevents text escaping shape)
                body  = '<wps:bodyPr anchor="ctr" lIns="45720" rIns="45720" tIns="36000" bIns="36000"><a:normAutofit xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/></wps:bodyPr>'
                cNvSp = f'<wps:cNvSpPr><a:spLocks noChangeArrowheads="1"/></wps:cNvSpPr>'
            return (
                f'<w:drawing xmlns:w="{W}">'
                f'<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0"'
                f' relativeHeight="{rh + sid}" behindDoc="{bd}" locked="0"'
                f' layoutInCell="1" allowOverlap="1" xmlns:wp="{WP}">'
                f'<wp:simplePos x="0" y="0"/>'
                f'<wp:positionH relativeFrom="page"><wp:posOffset>{x_e}</wp:posOffset></wp:positionH>'
                f'<wp:positionV relativeFrom="page"><wp:posOffset>{y_e}</wp:posOffset></wp:positionV>'
                f'<wp:extent cx="{w_e}" cy="{h_e}"/>'
                f'<wp:effectExtent l="0" t="0" r="0" b="0"/>'
                f'<wp:wrapNone/>'
                f'<wp:docPr id="{sid}" name="S{sid}"/>'
                f'<wp:cNvGraphicFramePr/>'
                f'<a:graphic xmlns:a="{A}">'
                f'<a:graphicData uri="{WPS}">'
                f'<wps:wsp xmlns:wps="{WPS}">'
                f'{cNvSp}'
                f'<wps:spPr>{spPr}</wps:spPr>'
                f'{txbx}{body}'
                f'</wps:wsp>'
                f'</a:graphicData>'
                f'</a:graphic>'
                f'</wp:anchor>'
                f'</w:drawing>'
            )

        # ── 1. Lane / pool backgrounds (behindDoc=1, low relativeHeight) ──────
        lanes_ordered = [s for s in cont_shapes if s['type'].lower() == 'lane']
        for s in cont_shapes:
            typ = s['type'].lower()
            x_e = ex(s['x']); y_e = ey(s['y'])
            w_e = ew(s['w']); h_e = ew(s['h'])
            if typ == 'participant':
                fill_hex = 'FFFFFF'
                rh       = 1000
            else:
                li       = lanes_ordered.index(s) if s in lanes_ordered else 0
                fill_hex = LANE_FILLS[li % 2]
                rh       = 2000 + li
            xml = _anchor(sid, x_e, y_e, w_e, h_e, 'rect', fill_hex,
                          s['name'], behind=True, rh=rh, text_align='left')
            run._r.append(etree.fromstring(xml.encode('utf-8')))
            sid += 1

        # ── 2. Connectors — one shape per waypoint segment ────────────────────
        # Drawing each segment individually ensures bent/routed BPMN paths
        # (L-shapes, corridor routes) render exactly as on the webpage.
        # Only the final segment carries the arrowhead.
        HALF_LW = 4763   # half of 9525 EMU (1 pt line) — used to centre
                         # near-zero-height/width shapes on the line axis
        for conn in connections:
            wps_pts = conn['wps']
            if len(wps_pts) < 2:
                continue
            n_segs = len(wps_pts) - 1
            for seg_i in range(n_segs):
                px1, py1 = wps_pts[seg_i]
                px2, py2 = wps_pts[seg_i + 1]
                x1, y1 = ex(px1), ey(py1)
                x2, y2 = ex(px2), ey(py2)
                dx, dy = x2 - x1, y2 - y1

                fh = '1' if dx < 0 else '0'
                fv = '1' if dy < 0 else '0'

                if abs(dx) < 100:          # essentially vertical segment
                    left_e = x1 - HALF_LW
                    top_e  = min(y1, y2)
                    w_seg  = 9525
                    h_seg  = max(abs(dy), 9525)
                elif abs(dy) < 100:        # essentially horizontal segment
                    left_e = min(x1, x2)
                    top_e  = y1 - HALF_LW
                    w_seg  = max(abs(dx), 9525)
                    h_seg  = 9525
                else:                      # diagonal segment
                    left_e = min(x1, x2)
                    top_e  = min(y1, y2)
                    w_seg  = abs(dx)
                    h_seg  = abs(dy)

                is_last = (seg_i == n_segs - 1)
                xml = _anchor(sid, left_e, top_e, w_seg, h_seg,
                              'line', '444444', '',
                              behind=False, rh=10000,
                              is_line=True, fh=fh, fv=fv, arrow=is_last)
                run._r.append(etree.fromstring(xml.encode('utf-8')))
                sid += 1

            # ── Yes / No (or other flow name) label near source exit ──────────
            flow_label = conn.get('name', '')
            if flow_label and len(wps_pts) >= 2:
                ex_px, ey_px = wps_pts[0]
                d_x = wps_pts[1][0] - wps_pts[0][0]
                d_y = wps_pts[1][1] - wps_pts[0][1]
                LBL_FW_PX = 30   # flow label box width (px)
                LBL_FH_PX = 14   # flow label box height (px)
                if abs(d_x) >= abs(d_y):   # horizontal exit → label above line
                    lx_px = ex_px + 4
                    ly_px = ey_px - 16
                else:                       # vertical exit → label right of line
                    lx_px = ex_px + 4
                    ly_px = ey_px + 4
                fl_x_e = ex(lx_px)
                fl_y_e = ey(ly_px)
                fl_w_e = ew(LBL_FW_PX)
                fl_h_e = ew(LBL_FH_PX)
                fl_xml = (
                    f'<w:drawing xmlns:w="{W}">'
                    f'<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0"'
                    f' relativeHeight="{10500 + sid}" behindDoc="0" locked="0"'
                    f' layoutInCell="1" allowOverlap="1" xmlns:wp="{WP}">'
                    f'<wp:simplePos x="0" y="0"/>'
                    f'<wp:positionH relativeFrom="page"><wp:posOffset>{fl_x_e}</wp:posOffset></wp:positionH>'
                    f'<wp:positionV relativeFrom="page"><wp:posOffset>{fl_y_e}</wp:posOffset></wp:positionV>'
                    f'<wp:extent cx="{fl_w_e}" cy="{fl_h_e}"/>'
                    f'<wp:effectExtent l="0" t="0" r="0" b="0"/>'
                    f'<wp:wrapNone/>'
                    f'<wp:docPr id="{sid}" name="FL{sid}"/>'
                    f'<wp:cNvGraphicFramePr/>'
                    f'<a:graphic xmlns:a="{A}">'
                    f'<a:graphicData uri="{WPS}">'
                    f'<wps:wsp xmlns:wps="{WPS}">'
                    f'<wps:cNvSpPr><a:spLocks noChangeArrowheads="1"/></wps:cNvSpPr>'
                    f'<wps:spPr>'
                    f'<a:xfrm><a:off x="0" y="0"/><a:ext cx="{fl_w_e}" cy="{fl_h_e}"/></a:xfrm>'
                    f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
                    f'<a:noFill/><a:ln><a:noFill/></a:ln>'
                    f'</wps:spPr>'
                    f'<wps:txbx>'
                    f'<w:txbxContent>'
                    f'<w:p><w:pPr><w:jc w:val="left"/></w:pPr>'
                    f'<w:r><w:rPr><w:i/><w:sz w:val="12"/><w:szCs w:val="12"/>'
                    f'<w:color w:val="444444"/></w:rPr>'
                    f'<w:t xml:space="preserve">{_esc(flow_label)}</w:t></w:r></w:p>'
                    f'</w:txbxContent>'
                    f'</wps:txbx>'
                    f'<wps:bodyPr anchor="ctr"/>'
                    f'</wps:wsp>'
                    f'</a:graphicData>'
                    f'</a:graphic>'
                    f'</wp:anchor>'
                    f'</w:drawing>'
                )
                run._r.append(etree.fromstring(fl_xml.encode('utf-8')))
                sid += 1

        # ── 3. Process shapes (foreground) ────────────────────────────────────
        # Gateways and events follow the BPMN convention: the shape carries
        # NO text; instead a separate transparent text box is placed outside
        # (above gateway, below event) — matching the bpmn-js webpage rendering.
        # Label box: 90 px wide, 50 px tall (3-line capacity).
        # Gateway: bottom-anchored so box bottom = shape top - GAP_PX.
        # Event:   top-anchored just below the event circle.
        LBL_W_PX = 90
        LBL_H_PX = 50
        GAP_PX   = 4

        for s in proc_shapes:
            typ  = s['type'].lower()
            fkey = next((k for k in FILL if k in typ), None)
            fill = FILL[fkey] if fkey else DEFAULT_FILL
            gkey = next((k for k in GEOM if k in typ), None)
            prst = GEOM[gkey] if gkey else 'roundRect'
            x_e = ex(s['x']); y_e = ey(s['y'])
            w_e = ew(s['w']); h_e = ew(s['h'])

            is_event   = 'event'   in typ
            is_gateway = 'gateway' in typ

            # Shape itself — no text for events/gateways
            shape_label = '' if (is_event or is_gateway) else s['name']
            xml = _anchor(sid, x_e, y_e, w_e, h_e, prst, fill, shape_label,
                          behind=False, rh=20000)
            run._r.append(etree.fromstring(xml.encode('utf-8')))
            sid += 1

            # External label text box for events and gateways
            if (is_event or is_gateway) and s['name']:
                lbl_cx_px = s['x'] + s['w'] / 2 - LBL_W_PX / 2
                if is_gateway:
                    lbl_y_px = s['y'] - LBL_H_PX - GAP_PX  # bottom = shape top - gap
                else:
                    lbl_y_px = s['y'] + s['h'] + 2           # below event circle
                lbl_x_e = ex(lbl_cx_px)
                lbl_y_e = ey(lbl_y_px)
                lbl_w_e = ew(LBL_W_PX)
                lbl_h_e = ew(LBL_H_PX)
                xml = _anchor(sid, lbl_x_e, lbl_y_e, lbl_w_e, lbl_h_e,
                              'rect', None, s['name'],
                              behind=False, rh=20001, no_fill=True)
                run._r.append(etree.fromstring(xml.encode('utf-8')))
                sid += 1

    else:
        # ── fallback: embedded PNG ─────────────────────────────────────────
        sec.page_width   = Inches(11)
        sec.page_height  = Inches(8.5)
        sec.left_margin  = sec.right_margin  = Inches(0.5)
        sec.top_margin   = sec.bottom_margin = Inches(0.5)
        doc.add_heading(process_name, 0)
        doc.add_picture(io.BytesIO(png_bytes), width=Inches(9.5))

    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


def _make_vdx(png_bytes: bytes, process_name: str, bpmn_xml: str = '') -> bytes:
    """Generate a .vdx (Visio Drawing XML) with native, fully-editable shapes.

    Parses the BPMN XML to extract every shape's position, size, type and label,
    then emits proper VDX 2D shapes (rectangles, diamonds, ellipses) and 1D
    connector arrows with arrowheads and Yes/No labels.  Falls back to an
    embedded-image VDX if the XML cannot be parsed.
    """
    import xml.etree.ElementTree as ET
    esc = _esc

    BPMN_NS   = 'http://www.omg.org/spec/BPMN/20100524/MODEL'
    BPMNDI_NS = 'http://www.omg.org/spec/BPMN/20100524/DI'
    DC_NS     = 'http://www.omg.org/spec/DD/20100524/DC'
    DI_NS     = 'http://www.omg.org/spec/DD/20100524/DI'

    # ── Fallback: embedded BMP image ─────────────────────────────────────────
    def _img_vdx() -> bytes:
        from PIL import Image as _Image
        img = _Image.open(io.BytesIO(png_bytes)).convert("RGB")
        px_w, px_h = img.size
        buf = io.BytesIO(); img.save(buf, "BMP")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        FDPI = 192.0; M = 0.25
        iw = px_w / FDPI; ih = px_h / FDPI
        pw = iw + 2*M;    ph = ih + 2*M
        return (
            '<?xml version="1.0" encoding="utf-8" standalone="yes"?>'
            '<VisioDocument xmlns="urn:schemas-microsoft-com:office:visio" xml:space="preserve">'
            '<StyleSheets><StyleSheet ID="0" NameU="Normal" Name="Normal"/></StyleSheets>'
            f'<DocumentSheet NameU="TheDoc"><PageProps>'
            f'<PageWidth>{pw:.4f}</PageWidth><PageHeight>{ph:.4f}</PageHeight>'
            '<PageScale>1</PageScale><DrawingScale>1</DrawingScale></PageProps></DocumentSheet>'
            '<Pages><Page ID="1" NameU="Page-1" Name="Page-1">'
            f'<PageSheet NameU="Page-1"><PageProps>'
            f'<PageWidth>{pw:.4f}</PageWidth><PageHeight>{ph:.4f}</PageHeight>'
            '<PageScale>1</PageScale><DrawingScale>1</DrawingScale></PageProps></PageSheet>'
            '<Shapes><Shape ID="1" Type="Foreign" LineStyle="0" FillStyle="0" TextStyle="0">'
            f'<XForm><PinX>{pw/2:.4f}</PinX><PinY>{ph/2:.4f}</PinY>'
            f'<Width>{iw:.4f}</Width><Height>{ih:.4f}</Height>'
            f'<LocPinX F="Width*0.5">{iw/2:.4f}</LocPinX>'
            f'<LocPinY F="Height*0.5">{ih/2:.4f}</LocPinY></XForm>'
            f'<Foreign><ImgOffsetX>0</ImgOffsetX><ImgOffsetY>0</ImgOffsetY>'
            f'<ImgWidth>{iw:.4f}</ImgWidth><ImgHeight>{ih:.4f}</ImgHeight></Foreign>'
            f'<ForeignData ForeignType="Bitmap">{b64}</ForeignData>'
            '</Shape></Shapes></Page></Pages></VisioDocument>'
        ).encode('utf-8')

    if not bpmn_xml:
        return _img_vdx()
    try:
        root = ET.fromstring(bpmn_xml)
    except ET.ParseError:
        return _img_vdx()

    # ── Collect element metadata (name + type) ────────────────────────────────
    node_info: dict[str, dict] = {}   # id → {name, type}
    flow_info: dict[str, dict] = {}   # id → {name, source, target}

    collab = root.find(f'{{{BPMN_NS}}}collaboration')
    if collab is not None:
        for el in collab:
            eid = el.get('id', '')
            if eid:
                node_info[eid] = {
                    'name': el.get('name', ''),
                    'type': el.tag.split('}')[1] if '}' in el.tag else el.tag,
                }

    proc = root.find(f'{{{BPMN_NS}}}process')
    if proc is not None:
        for el in proc.iter():
            eid = el.get('id', '')
            if not eid:
                continue
            tag = el.tag.split('}')[1] if '}' in el.tag else el.tag
            node_info[eid] = {'name': el.get('name', ''), 'type': tag}
            if tag == 'sequenceFlow':
                flow_info[eid] = {
                    'name':   el.get('name', ''),
                    'source': el.get('sourceRef', ''),
                    'target': el.get('targetRef', ''),
                }

    # ── Collect diagram bounds, edge waypoints and explicit label positions ──────
    shape_bounds:   dict[str, dict] = {}   # bpmnElement id → {x,y,w,h}
    edge_waypoints: dict[str, list] = {}   # sequenceFlow id → [(x,y), ...]
    label_bounds:   dict[str, dict] = {}   # bpmnElement id → explicit label {x,y,w,h}

    plane = root.find(f'.//{{{BPMNDI_NS}}}BPMNPlane')
    if plane is None:
        return _img_vdx()

    for child in plane:
        ctag  = child.tag.split('}')[1] if '}' in child.tag else child.tag
        bel   = child.get('bpmnElement', '')
        if ctag == 'BPMNShape':
            b = child.find(f'{{{DC_NS}}}Bounds')
            if b is not None:
                shape_bounds[bel] = {
                    'x': float(b.get('x', 0)), 'y': float(b.get('y', 0)),
                    'w': float(b.get('width',  0)), 'h': float(b.get('height', 0)),
                }
            # BPMNLabel carries the explicit position for gateway labels
            lbl_el = child.find(f'{{{BPMNDI_NS}}}BPMNLabel')
            if lbl_el is not None:
                lb = lbl_el.find(f'{{{DC_NS}}}Bounds')
                if lb is not None:
                    label_bounds[bel] = {
                        'x': float(lb.get('x', 0)), 'y': float(lb.get('y', 0)),
                        'w': float(lb.get('width',  0)), 'h': float(lb.get('height', 0)),
                    }
        elif ctag == 'BPMNEdge':
            wps = [(float(w.get('x', 0)), float(w.get('y', 0)))
                   for w in child.findall(f'{{{DI_NS}}}waypoint')]
            if len(wps) >= 2:
                edge_waypoints[bel] = wps
            # Capture explicit label position for Yes/No (and other) flow labels
            lbl_el = child.find(f'{{{BPMNDI_NS}}}BPMNLabel')
            if lbl_el is not None:
                lb = lbl_el.find(f'{{{DC_NS}}}Bounds')
                if lb is not None:
                    label_bounds[bel] = {
                        'x': float(lb.get('x', 0)), 'y': float(lb.get('y', 0)),
                        'w': float(lb.get('width',  0)), 'h': float(lb.get('height', 0)),
                    }

    if not shape_bounds:
        return _img_vdx()

    # ── Page geometry ─────────────────────────────────────────────────────────
    DPI    = 96.0    # BPMN coords are at screen 96 DPI
    MARGIN = 0.3     # inches padding

    min_x = min(b['x']           for b in shape_bounds.values())
    min_y = min(b['y']           for b in shape_bounds.values())
    max_x = max(b['x'] + b['w'] for b in shape_bounds.values())
    max_y = max(b['y'] + b['h'] for b in shape_bounds.values())

    page_w = (max_x - min_x) / DPI + 2 * MARGIN
    page_h = (max_y - min_y) / DPI + 2 * MARGIN

    def ix(px: float) -> float:   # BPMN px  →  VDX x inches
        return MARGIN + (px - min_x) / DPI

    def iy(py: float) -> float:   # BPMN px  →  VDX y inches (Y-axis flipped)
        return page_h - MARGIN - (py - min_y) / DPI

    # ── Colour palette (#RRGGBB hex — safest VDX colour format) ──────────────
    # Lanes use a distinctly tinted fill so dividing lines are always visible.
    FILL = {
        'startEvent':  '#4AA366',
        'endEvent':    '#DC3545',
        'task':        '#AFC1D6',
        'gateway':     '#F5CB5C',
        'lane':        '#E3ECF5',   # light blue-grey — clearly different from page white
        'participant': '#C8D8E8',   # slightly darker blue-grey for the outer pool
    }
    BORDER = {
        'startEvent':  '#2D7846',
        'endEvent':    '#A01E28',
        'task':        '#6482A0',
        'gateway':     '#B48C28',
        'lane':        '#7890AA',   # medium blue — clearly visible dividers
        'participant': '#5070A0',   # darker blue — strong outer pool border
    }

    def _ckey(typ: str) -> str:
        t = typ.lower()
        if t.startswith('start'): return 'startEvent'   # avoids 'sendTask' false match
        if t.startswith('end'):   return 'endEvent'     # avoids 'sendTask' false match
        if 'gateway'     in t:    return 'gateway'
        if t == 'lane':           return 'lane'
        if 'participant' in t:    return 'participant'
        return 'task'

    # ── Pre-assign integer VDX shape IDs (needed for <Connects>) ─────────────
    id_map: dict[str, int] = {}
    _ctr = [1]

    def vid(key: str) -> int:
        if key not in id_map:
            id_map[key] = _ctr[0]; _ctr[0] += 1
        return id_map[key]

    # Render order: participant → lane → tasks/events/gateways (back to front)
    def _z(eid: str) -> int:
        t = (node_info.get(eid) or {}).get('type', '').lower()
        if 'participant' in t: return 0
        if 'lane'        in t: return 1
        return 2

    sorted_ids = sorted(shape_bounds.keys(), key=_z)
    for eid in sorted_ids:
        vid(eid)
    # Pre-assign IDs for external gateway label text boxes
    for eid in label_bounds:
        if 'gateway' in (node_info.get(eid) or {}).get('type', '').lower():
            vid(f'lbl_{eid}')
    # Pre-assign IDs for edge label text boxes (Yes/No labels on flows)
    for fid in edge_waypoints:
        if flow_info.get(fid, {}).get('name') and fid in label_bounds:
            vid(f'elbl_{fid}')

    # ── Build VDX XML ─────────────────────────────────────────────────────────
    out: list[str] = []
    w = out.append

    def _xform(pin_x_in: float, pin_y_in: float, w_in: float, h_in: float) -> None:
        w('<XForm>')
        w(f'<PinX>{pin_x_in:.4f}</PinX><PinY>{pin_y_in:.4f}</PinY>')
        w(f'<Width>{w_in:.4f}</Width><Height>{h_in:.4f}</Height>')
        w(f'<LocPinX F="Width*0.5">{w_in/2:.4f}</LocPinX>')
        w(f'<LocPinY F="Height*0.5">{h_in/2:.4f}</LocPinY>')
        w('<Angle>0</Angle><FlipX>0</FlipX><FlipY>0</FlipY>')
        w('</XForm>')

    w('<?xml version="1.0" encoding="utf-8" standalone="yes"?>')
    w('<VisioDocument xmlns="urn:schemas-microsoft-com:office:visio" xml:space="preserve">')
    w(f'<DocumentProperties><Creator>POET</Creator><Title>{esc(process_name)}</Title></DocumentProperties>')
    w('<StyleSheets><StyleSheet ID="0" NameU="Normal" Name="Normal"/></StyleSheets>')
    w('<DocumentSheet NameU="TheDoc"><PageProps>')
    w(f'<PageWidth>{page_w:.4f}</PageWidth><PageHeight>{page_h:.4f}</PageHeight>')
    w('<PageScale>1</PageScale><DrawingScale>1</DrawingScale>')
    w('</PageProps></DocumentSheet>')
    w('<Pages><Page ID="1" NameU="Page-1" Name="Page-1">')
    w('<PageSheet NameU="Page-1"><PageProps>')
    w(f'<PageWidth>{page_w:.4f}</PageWidth><PageHeight>{page_h:.4f}</PageHeight>')
    w('<PageScale>1</PageScale><DrawingScale>1</DrawingScale>')
    w('</PageProps></PageSheet>')
    w('<Shapes>')

    # ── 2D shapes ─────────────────────────────────────────────────────────────
    for el_id in sorted_ids:
        b    = shape_bounds[el_id]
        info = node_info.get(el_id, {'name': el_id, 'type': ''})
        typ  = info.get('type', '')
        name = info.get('name', '')
        sid  = vid(el_id)
        ck   = _ckey(typ)
        fc   = FILL[ck]; lc = BORDER[ck]

        bx, by, bw, bh = b['x'], b['y'], b['w'], b['h']
        pin_xi = ix(bx + bw / 2)
        pin_yi = iy(by + bh / 2)
        w_in   = bw / DPI
        h_in   = bh / DPI
        lhalf  = w_in / 2
        hhalf  = h_in / 2
        t      = typ.lower()

        # Gateways and participants carry their label in a separate text box
        # so the shape itself stays clean (no text inside the diamond / pool rect).
        suppress_text = 'gateway' in t or 'participant' in t

        w(f'<Shape ID="{sid}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">')
        _xform(pin_xi, pin_yi, w_in, h_in)
        w(f'<Fill><FillForegnd>{fc}</FillForegnd><FillBkgnd>{fc}</FillBkgnd>')
        w('<FillPattern>1</FillPattern></Fill>')

        if 'event' in t:
            lw = '0.02' if 'end' in t else '0.01'
            w(f'<Line><LineWeight>{lw}</LineWeight><LineColor>{lc}</LineColor></Line>')
            w('<Geom IX="0"><Ellipse IX="1">')
            w(f'<X F="Width*0.5">{lhalf:.4f}</X><Y F="Height*0.5">{hhalf:.4f}</Y>')
            w(f'<A F="Width*0.5">{lhalf:.4f}</A><B F="0">0</B>')
            w(f'<C F="Width">{w_in:.4f}</C><D F="Height*0.5">{hhalf:.4f}</D>')
            w('</Ellipse></Geom>')

        elif 'gateway' in t:
            w(f'<Line><LineWeight>0.015</LineWeight><LineColor>{lc}</LineColor></Line>')
            w('<Geom IX="0">')
            w(f'<MoveTo IX="1"><X F="Width*0.5">{lhalf:.4f}</X><Y F="0">0</Y></MoveTo>')
            w(f'<LineTo IX="2"><X F="Width">{w_in:.4f}</X><Y F="Height*0.5">{hhalf:.4f}</Y></LineTo>')
            w(f'<LineTo IX="3"><X F="Width*0.5">{lhalf:.4f}</X><Y F="Height">{h_in:.4f}</Y></LineTo>')
            w(f'<LineTo IX="4"><X F="0">0</X><Y F="Height*0.5">{hhalf:.4f}</Y></LineTo>')
            w(f'<LineTo IX="5"><X F="Width*0.5">{lhalf:.4f}</X><Y F="0">0</Y></LineTo>')
            w('</Geom>')

        elif 'participant' in t:
            # Outer pool border — thicker line
            w(f'<Line><LineWeight>0.02</LineWeight><LineColor>{lc}</LineColor></Line>')
            # Explicit closed-rectangle geometry (required for fill/border to render in VDX)
            w('<Geom IX="0">')
            w(f'<MoveTo IX="1"><X F="0">0</X><Y F="0">0</Y></MoveTo>')
            w(f'<LineTo IX="2"><X F="Width">{w_in:.4f}</X><Y F="0">0</Y></LineTo>')
            w(f'<LineTo IX="3"><X F="Width">{w_in:.4f}</X><Y F="Height">{h_in:.4f}</Y></LineTo>')
            w(f'<LineTo IX="4"><X F="0">0</X><Y F="Height">{h_in:.4f}</Y></LineTo>')
            w(f'<LineTo IX="5"><X F="0">0</X><Y F="0">0</Y></LineTo>')
            w('</Geom>')

        elif 'lane' in t:
            # Lane rectangle — visible dividing lines between swim lanes
            w(f'<Line><LineWeight>0.015</LineWeight><LineColor>{lc}</LineColor></Line>')
            w('<Geom IX="0">')
            w(f'<MoveTo IX="1"><X F="0">0</X><Y F="0">0</Y></MoveTo>')
            w(f'<LineTo IX="2"><X F="Width">{w_in:.4f}</X><Y F="0">0</Y></LineTo>')
            w(f'<LineTo IX="3"><X F="Width">{w_in:.4f}</X><Y F="Height">{h_in:.4f}</Y></LineTo>')
            w(f'<LineTo IX="4"><X F="0">0</X><Y F="Height">{h_in:.4f}</Y></LineTo>')
            w(f'<LineTo IX="5"><X F="0">0</X><Y F="0">0</Y></LineTo>')
            w('</Geom>')

        else:
            # Task rectangle
            w(f'<Line><LineWeight>0.01</LineWeight><LineColor>{lc}</LineColor></Line>')
            w('<Geom IX="0">')
            w(f'<MoveTo IX="1"><X F="0">0</X><Y F="0">0</Y></MoveTo>')
            w(f'<LineTo IX="2"><X F="Width">{w_in:.4f}</X><Y F="0">0</Y></LineTo>')
            w(f'<LineTo IX="3"><X F="Width">{w_in:.4f}</X><Y F="Height">{h_in:.4f}</Y></LineTo>')
            w(f'<LineTo IX="4"><X F="0">0</X><Y F="Height">{h_in:.4f}</Y></LineTo>')
            w(f'<LineTo IX="5"><X F="0">0</X><Y F="0">0</Y></LineTo>')
            w('</Geom>')

        if name and not suppress_text:
            # VDX Size is in INCHES: 10 pt = 10/72 ≈ 0.1389 in
            if 'lane' in t:
                # Left-align + top-justify so actor name sits in the top-left corner
                # of the lane band rather than floating in the centre.
                w('<Para IX="0"><HorzAlign>0</HorzAlign><VerticalAlign>0</VerticalAlign></Para>')
            else:
                w('<Para IX="0"><HorzAlign>1</HorzAlign><VerticalAlign>1</VerticalAlign></Para>')
            w('<Char IX="0"><Size>0.1389</Size><Color>#222222</Color></Char>')
            w(f'<Text>{esc(name)}</Text>')
        w('</Shape>')

    # ── External text labels for gateways (separate shape, no border/fill) ────
    # Uses the BPMNLabel bounds that build_bpmn_xml already places top-left of
    # each diamond so the question text never overlaps the shape or Yes/No arrows.
    for el_id, lb in label_bounds.items():
        info = node_info.get(el_id, {})
        if 'gateway' not in info.get('type', '').lower():
            continue
        name = info.get('name', '')
        if not name:
            continue
        lsid = id_map.get(f'lbl_{el_id}')
        if lsid is None:
            continue
        lx, ly, lw_px, lh_px = lb['x'], lb['y'], lb['w'], lb['h']
        lpin_x = ix(lx + lw_px / 2)
        lpin_y = iy(ly + lh_px / 2)
        lw_in  = max(lw_px / DPI, 0.05)
        lh_in  = max(lh_px / DPI, 0.05)
        w(f'<Shape ID="{lsid}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">')
        _xform(lpin_x, lpin_y, lw_in, lh_in)
        w('<Fill><FillPattern>0</FillPattern></Fill>')   # transparent fill
        w('<Line><LinePattern>0</LinePattern></Line>')   # no border
        w('<Para IX="0"><HorzAlign>0</HorzAlign><VerticalAlign>0</VerticalAlign></Para>')
        w('<Char IX="0"><Size>0.1389</Size><Color>#222222</Color></Char>')
        w(f'<Text>{esc(name)}</Text>')
        w('</Shape>')

    # ── Connector shapes (2D polyline body + explicit triangle arrowhead) ────
    # VDX EndArrow is only honoured on XForm1D (1D) shapes, but XForm1D shapes
    # require a Geom whose local-space coords collapse to zero for certain
    # segment orientations, making the shape invisible.
    # Solution: render each flow as TWO 2D shapes (confirmed to render correctly):
    #   1. A 2D polyline for the full orthogonal route.
    #   2. A small filled-triangle at the last waypoint, rotated to match the
    #      last segment direction, to act as the arrowhead.
    AW = 0.10    # arrowhead base→tip length, inches
    AH = 0.065   # arrowhead base total width, inches

    for flow_id, wps in edge_waypoints.items():
        if len(wps) < 2:
            continue

        vdx_wps = [(ix(p[0]), iy(p[1])) for p in wps]
        ox, oy  = vdx_wps[0]

        xs   = [p[0] for p in vdx_wps];  ys = [p[1] for p in vdx_wps]
        bb_w = max(max(xs) - min(xs), 0.01)
        bb_h = max(max(ys) - min(ys), 0.01)

        csid = vid(f'conn_{flow_id}')

        # 1. Polyline body ──────────────────────────────────────────────────
        w(f'<Shape ID="{csid}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">')
        w('<XForm>')
        w(f'<PinX>{ox:.4f}</PinX><PinY>{oy:.4f}</PinY>')
        w(f'<Width>{bb_w:.4f}</Width><Height>{bb_h:.4f}</Height>')
        w('<LocPinX>0</LocPinX><LocPinY>0</LocPinY>')
        w('<Angle>0</Angle><FlipX>0</FlipX><FlipY>0</FlipY>')
        w('</XForm>')
        w('<Fill><FillPattern>0</FillPattern></Fill>')
        w('<Line><LinePattern>1</LinePattern>'
          '<LineWeight>0.015</LineWeight><LineColor>#505050</LineColor></Line>')
        w('<Geom IX="0">')
        w('<MoveTo IX="1"><X>0</X><Y>0</Y></MoveTo>')
        for seg_i, (px, py) in enumerate(vdx_wps[1:], start=2):
            w(f'<LineTo IX="{seg_i}"><X>{px-ox:.4f}</X><Y>{py-oy:.4f}</Y></LineTo>')
        w('</Geom>')
        w('</Shape>')

        # 2. Filled-triangle arrowhead ──────────────────────────────────────
        # LocPinX=AW places the local tip corner (AW, AH/2) at PinX/PinY
        # so the tip lands exactly on the last waypoint after rotation.
        end_x,  end_y  = vdx_wps[-1]
        prev_x, prev_y = vdx_wps[-2]
        arrow_angle    = math.atan2(end_y - prev_y, end_x - prev_x)

        arrow_sid = vid(f'arrowhead_{flow_id}')
        w(f'<Shape ID="{arrow_sid}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">')
        w('<XForm>')
        w(f'<PinX>{end_x:.4f}</PinX><PinY>{end_y:.4f}</PinY>')
        w(f'<Width>{AW:.4f}</Width><Height>{AH:.4f}</Height>')
        w(f'<LocPinX>{AW:.4f}</LocPinX><LocPinY>{AH/2:.4f}</LocPinY>')
        w(f'<Angle>{arrow_angle:.6f}</Angle>')
        w('<FlipX>0</FlipX><FlipY>0</FlipY>')
        w('</XForm>')
        w('<Fill><FillForegnd>#505050</FillForegnd>'
          '<FillBkgnd>#505050</FillBkgnd><FillPattern>1</FillPattern></Fill>')
        w('<Line><LinePattern>0</LinePattern></Line>')
        # Triangle: base-bottom(0,0) → base-top(0,AH) → tip(AW,AH/2) → close
        w('<Geom IX="0">')
        w('<MoveTo IX="1"><X>0</X><Y>0</Y></MoveTo>')
        w(f'<LineTo IX="2"><X>0</X><Y>{AH:.4f}</Y></LineTo>')
        w(f'<LineTo IX="3"><X>{AW:.4f}</X><Y>{AH/2:.4f}</Y></LineTo>')
        w('<LineTo IX="4"><X>0</X><Y>0</Y></LineTo>')
        w('</Geom>')
        w('</Shape>')

    # ── Edge label text boxes (Yes / No and other flow names) ────────────────
    # Rendered as transparent shapes at the BPMNLabel bounds computed by
    # build_bpmn_xml so they always sit right beside the exiting arrow segment.
    for fid, lb in label_bounds.items():
        fi = flow_info.get(fid, {})
        if not fi:          # not a flow — skip (gateway labels handled above)
            continue
        flabel = fi.get('name', '')
        if not flabel:
            continue
        lsid = id_map.get(f'elbl_{fid}')
        if lsid is None:
            continue
        lx, ly   = lb['x'], lb['y']
        lw_px    = max(lb['w'], 20)
        lh_px    = max(lb['h'], 14)
        lpin_x   = ix(lx + lw_px / 2)
        lpin_y   = iy(ly + lh_px / 2)
        lw_in    = lw_px / DPI
        lh_in    = lh_px / DPI
        w(f'<Shape ID="{lsid}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">')
        _xform(lpin_x, lpin_y, lw_in, lh_in)
        w('<Fill><FillPattern>0</FillPattern></Fill>')
        w('<Line><LinePattern>0</LinePattern></Line>')
        w('<Para IX="0"><HorzAlign>0</HorzAlign><VerticalAlign>1</VerticalAlign></Para>')
        w('<Char IX="0"><Size>0.1250</Size><Color>#444444</Color></Char>')
        w(f'<Text>{esc(flabel)}</Text>')
        w('</Shape>')

    w('</Shapes>')
    w('</Page></Pages></VisioDocument>')
    return ''.join(out).encode('utf-8')


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "service": "POET API"}


@app.post("/api/upload")
async def upload_document(files: List[UploadFile] = File(...), process_title: str = Form(""), bpmn_level: str = Form("2")):
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded.")

    text_parts = []
    for file in files:
        ext = Path(file.filename).suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type '{ext}' in '{file.filename}'. Accepted: {', '.join(ALLOWED_EXTENSIONS)}"
            )

        file_bytes = await file.read()
        size_mb = len(file_bytes) / (1024 * 1024)
        if size_mb > MAX_FILE_SIZE_MB:
            raise HTTPException(
                status_code=413,
                detail=f"File '{file.filename}' is too large ({size_mb:.1f} MB). Maximum is {MAX_FILE_SIZE_MB} MB."
            )

        try:
            text = extract_text(file_bytes, file.filename)
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Could not parse '{file.filename}': {str(e)}")

        if text.strip():
            text_parts.append(f"[Document: {file.filename}]\n{text}")

    if not text_parts:
        raise HTTPException(status_code=422, detail="No text could be extracted from the uploaded documents.")

    document_text = "\n\n---\n\n".join(text_parts)

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY is not configured in backend/.env")

    try:
        client = anthropic.Anthropic(api_key=api_key)
        structure = extract_process_structure(client, document_text, bpmn_level)
        if process_title.strip():
            structure["process_name"] = process_title.strip()
        bpmn_xml = build_bpmn_xml(structure)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"BPMN generation failed: {str(e)}")

    valid, err = validate_xml(bpmn_xml)
    if not valid:
        raise HTTPException(status_code=500, detail=f"Generated XML failed validation: {err}")

    filenames = ", ".join(f.filename for f in files)
    return JSONResponse({
        "status": "success",
        "filename": filenames,
        "process_name": structure.get("process_name", ""),
        "step_count": len(structure.get("steps", [])),
        "bpmn_xml": bpmn_xml
    })


@app.post("/api/export")
async def export_diagram(
    format:       str = Form(...),
    png_base64:   str = Form(...),
    process_name: str = Form("Process Map"),
    bpmn_xml:     str = Form(""),
):
    try:
        png_bytes = base64.b64decode(png_base64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid PNG data — could not decode base64.")

    fmt = format.lower().strip()
    if fmt == "pptx":
        content  = _make_pptx(png_bytes, process_name, bpmn_xml)
        media    = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        filename = "process-map.pptx"
    elif fmt == "docx":
        content  = _make_docx(png_bytes, process_name, bpmn_xml)
        media    = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        filename = "process-map.docx"
    elif fmt == "vsdx":
        content  = _make_vdx(png_bytes, process_name, bpmn_xml)
        media    = "application/vnd.visio"
        filename = "process-map.vdx"
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported export format: {fmt}")

    return Response(
        content=content,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── SOP Generation ────────────────────────────────────────────────────────────

SOP_SYSTEM_PROMPT = """You are a professional business analyst and technical writer specialising in standard operating procedures (SOPs).

Generate a clear, well-structured SOP in markdown format based on the source documents provided.

Formatting rules:
- Use # for the SOP title only (H1)
- Use ## for section headings (H2)
- Use numbered lists (1. 2. 3.) for procedure steps
- Use bullet lists (- ) for non-sequential items
- Use **Bold:** format for key-value pairs (e.g. **Department:** Finance)
- Do NOT use markdown tables
- Do NOT include any explanation or preamble outside the SOP itself — return only the SOP document"""

# Ordered list of all supported SOP sections
SOP_SECTIONS_META = [
    ("doc_control",             "Document Control & Governance",
     "Include: SOP Title, Unique Document ID (e.g. SOP-001), Version Number, Effective Date, Review Date, "
     "Owner (Business Function), Approver(s), Superseded Versions, Change Log with summary of revisions, "
     "Distribution List, and Classification (e.g. Confidential/Internal)."),
    ("purpose",                 "Purpose & Objective",
     "Clearly state why the SOP exists, what risk or business requirement it addresses, "
     "and any regulatory or policy drivers."),
    ("scope",                   "Scope",
     "Define boundaries precisely: business units covered, products/services covered, "
     "geographies/jurisdictions, in-scope vs out-of-scope activities, and applicable legal entities."),
    ("regulatory_refs",         "Regulatory & Policy References",
     "List applicable laws (e.g. AMLD, SEC, FINRA, FCA), internal policies (Risk, Compliance, Data Privacy), "
     "industry standards (ISO, SOC 2, PCI-DSS), and related SOPs."),
    ("definitions",             "Definitions & Acronyms",
     "Define technical terms, regulatory definitions, risk categories, and system names. "
     "Use **Term:** definition format for each entry."),
    ("roles_responsibilities",  "Roles & Responsibilities (RACI)",
     "Define accountability for: Process Owner, Business Operators, Compliance, Risk, "
     "Internal Audit, and IT/System Support. Use **Role:** responsibility format for each."),
    ("process_overview",        "Process Overview",
     "High-level summary before detailed steps: describe inputs and outputs, trigger events, "
     "key decision points, and critical control checkpoints."),
    ("procedures",              "Detailed Procedures",
     "For each step include: trigger, responsible party, required systems/tools, step description, "
     "control/check required, evidence/documentation required, SLA/timeline, and escalation trigger. "
     "Separate operational steps from control steps and clearly mark Key Controls. Use numbered list format."),
    ("controls_risk",           "Controls & Risk Management",
     "Include: key risks addressed, preventive controls, detective controls, manual vs automated controls, "
     "control frequency, and control evidence retention requirements. "
     "Use **Risk:** control format for each pair."),
    ("exception_handling",      "Exception Handling & Escalation",
     "Define: what qualifies as an exception, approval thresholds, escalation chain, "
     "regulatory breach reporting procedures, and documentation requirements."),
    ("systems_data",            "Systems & Data Requirements",
     "List systems used, data inputs, data validation checks, access control requirements, "
     "data privacy/security requirements, retention requirements, "
     "segregation of duties, and access provisioning controls."),
    ("documentation_retention", "Documentation & Record Retention",
     "Specify: what documents must be stored, where (system/location), "
     "retention period, and audit trail requirements."),
    ("kpis_monitoring",         "KPIs / Monitoring & Reporting",
     "Define: process SLAs, error rates, control failures, regulatory reporting metrics, "
     "quality assurance reviews, and dashboard ownership."),
    ("training",                "Training Requirements",
     "List: required certifications, mandatory annual training, system training, "
     "and evidence of training completion requirements."),
    ("business_continuity",     "Business Continuity & Contingency",
     "Include: backup procedures, manual fallback processes, disaster recovery steps, "
     "and communication protocols during disruptions."),
    ("appendices",              "Appendices",
     "List any relevant appendices: process flowcharts, templates, forms, checklists, "
     "sample reports, and control testing scripts."),
]

# Map from id → (title, instructions) for quick lookup
SOP_SECTIONS_MAP = {sid: (title, instr) for sid, title, instr in SOP_SECTIONS_META}

DEFAULT_SECTIONS = ['purpose', 'scope', 'definitions', 'roles_responsibilities',
                    'procedures', 'exception_handling', 'documentation_retention']


def _generate_sop(client: anthropic.Anthropic, combined_text: str,
                  sop_title: str, department: str, selected_sections: list) -> str:
    today = date.today().strftime("%B %Y")

    # Build ordered section instructions from selected ids
    ordered = [item for item in SOP_SECTIONS_META if item[0] in selected_sections]
    section_lines = []
    for i, (sid, title, instr) in enumerate(ordered, 1):
        section_lines.append(f"{i}. ## {title}\n   {instr}")
    sections_block = "\n\n".join(section_lines)

    system = (
        SOP_SYSTEM_PROMPT
        + f"\n\nThe SOP must start with:\n# [SOP Title]\n"
          f"**Department:** [value]  **Version:** 1.0  **Date:** {today}\n---\n\n"
          f"Then include exactly these sections in this order:\n\n{sections_block}"
    )

    dept_note = f" for the {department} department" if department.strip() else ""
    user_msg  = (
        f'Generate a professional SOP titled "{sop_title}"{dept_note} '
        f"based on the following source documents:\n\n{combined_text[:12000]}"
    )

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4000,
        system=system,
        messages=[{"role": "user", "content": user_msg}]
    )
    return message.content[0].text


def _add_runs(paragraph, text: str):
    """Add a paragraph's text, converting **bold** spans to bold runs."""
    parts = re.split(r'\*\*(.+?)\*\*', text)
    for i, part in enumerate(parts):
        if part:
            run = paragraph.add_run(part)
            if i % 2 == 1:
                run.bold = True


def _make_sop_docx(sop_markdown: str, sop_title: str) -> bytes:
    from docx import Document as DocxDocument
    from docx.shared import Pt, RGBColor

    doc = DocxDocument()

    # Default Normal style
    normal = doc.styles['Normal']
    normal.font.name = 'Calibri'
    normal.font.size = Pt(11)

    for line in sop_markdown.split('\n'):
        s = line.strip()

        if not s:
            continue

        if s == '---':
            doc.add_paragraph()
            continue

        # H1: # Title
        if s.startswith('# ') and not s.startswith('## '):
            doc.add_heading(s[2:], level=1)

        # H2: ## Section
        elif s.startswith('## '):
            doc.add_heading(s[3:], level=2)

        # Numbered list: 1. item
        elif re.match(r'^\d+\.\s', s):
            text = re.sub(r'^\d+\.\s+', '', s)
            p = doc.add_paragraph(style='List Number')
            _add_runs(p, text)

        # Bullet list: - item
        elif s.startswith('- '):
            p = doc.add_paragraph(style='List Bullet')
            _add_runs(p, s[2:])

        # Normal paragraph (may contain inline bold)
        else:
            p = doc.add_paragraph()
            _add_runs(p, s)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


@app.post("/api/generate-sop")
async def generate_sop_endpoint(
    files:      List[UploadFile] = File(...),
    sop_title:     str = Form(...),
    department:    str = Form(""),
    sections_json: str = Form("[]"),
):
    if not files:
        raise HTTPException(status_code=400, detail="At least one file is required.")

    all_texts = []
    for f in files:
        ext = Path(f.filename).suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type '{ext}' in {f.filename}. Accepted: {', '.join(ALLOWED_EXTENSIONS)}"
            )
        file_bytes = await f.read()
        size_mb    = len(file_bytes) / (1024 * 1024)
        if size_mb > MAX_FILE_SIZE_MB:
            raise HTTPException(
                status_code=413,
                detail=f"File '{f.filename}' is too large ({size_mb:.1f} MB). Maximum is {MAX_FILE_SIZE_MB} MB."
            )
        try:
            text = extract_text(file_bytes, f.filename)
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Could not parse '{f.filename}': {str(e)}")
        if text.strip():
            all_texts.append(f"=== Source: {f.filename} ===\n{text.strip()}")

    if not all_texts:
        raise HTTPException(status_code=422, detail="No text could be extracted from the uploaded documents.")

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY is not configured in backend/.env")

    try:
        client            = anthropic.Anthropic(api_key=api_key)
        combined          = "\n\n".join(all_texts)
        selected_sections = json.loads(sections_json) if sections_json.strip() else DEFAULT_SECTIONS
        if not selected_sections:
            selected_sections = DEFAULT_SECTIONS
        sop_markdown = _generate_sop(client, combined, sop_title, department, selected_sections)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"SOP generation failed: {str(e)}")

    return JSONResponse({"status": "success", "sop_markdown": sop_markdown})


@app.post("/api/export-sop")
async def export_sop(
    sop_markdown: str = Form(...),
    sop_title:    str = Form("SOP"),
):
    try:
        content = _make_sop_docx(sop_markdown, sop_title)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Word export failed: {str(e)}")

    safe_name = re.sub(r'[^a-z0-9_\-]', '_', sop_title.lower()) or 'sop'
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.docx"'},
    )


# ── Business Case Generation ──────────────────────────────────────────────────

BC_SECTIONS_META = [
    ("executive_summary",       "Executive Summary",
     "A concise standalone overview (2-3 paragraphs) for senior stakeholders covering: the current process, "
     "proposed improvements, expected benefits, investment required, and recommendation."),
    ("current_state",           "Current State",
     "Describe the current process in detail: manual steps, pain points, inefficiencies, error rates, "
     "cycle times, FTE effort, and cost of poor quality. Reference specifics from the uploaded documents."),
    ("target_state",            "Target State",
     "Describe the proposed future-state process after implementing improvements. Cover: redesigned process flow, "
     "automation touchpoints, changes to roles, and key differences from current state."),
    ("risk_control",            "Risk & Control Impact",
     "Analyse how the proposed improvements affect existing controls. Identify controls that will be "
     "automated or enhanced, any new risks introduced, and residual manual controls required."),
    ("regulatory",              "Regulatory Considerations",
     "Identify regulatory, compliance, or legal implications. Reference applicable regulations, "
     "internal policies, and any approval or notification requirements before implementation."),
    ("financial_impact",        "Financial Impact",
     "Provide a quantified ROI analysis including: estimated annual cost savings, FTE reduction or "
     "redeployment, one-off implementation costs, ongoing operational savings, and payback period. "
     "Use **Label:** value format for key figures."),
    ("implementation_plan",     "Implementation Plan",
     "Outline a phased implementation approach with: key phases, milestones, indicative timeline, "
     "resource requirements, dependencies, and change management considerations. Use numbered list format."),
    ("technology_requirements", "Technology Requirements",
     "List the systems, tools, platforms, and integrations required. Include infrastructure changes, "
     "licensing considerations, vendor options, and build vs buy assessment."),
    ("governance",              "Governance & Ownership",
     "Define the governance structure: process owner, project sponsor, steering committee, "
     "and ongoing operational ownership post-implementation."),
    ("risks_mitigations",       "Risks & Mitigations",
     "Identify the top risks to the initiative with mitigations. Cover: delivery risks, adoption risks, "
     "regulatory risks, and operational risks. Use **Risk:** mitigation format for each pair."),
]

BC_SECTIONS_MAP = {sid: (title, instr) for sid, title, instr in BC_SECTIONS_META}

BC_DEFAULT_SECTIONS = ['executive_summary', 'current_state', 'target_state',
                       'financial_impact', 'implementation_plan', 'risks_mitigations']

IMPROVEMENT_FOCUS_META = {
    "lean":               "Apply LEAN methodology: identify waste (muda), value stream mapping insights, "
                          "elimination of non-value-add steps, and process simplification opportunities.",
    "rpa":                "Identify RPA automation candidates: repetitive rule-based tasks, high-volume "
                          "data entry, system re-keying, and reconciliation activities suitable for bots.",
    "ai":                 "Identify AI/Intelligent Automation opportunities: document processing, decision "
                          "support, anomaly detection, NLP, and predictive analytics use cases.",
    "system_integration": "Identify system integration opportunities to eliminate manual handoffs, "
                          "leverage APIs, and synchronise data across disparate platforms.",
    "digitisation":       "Identify workflow digitisation opportunities: paper-based processes, manual "
                          "approvals, and email workflows that can be moved to digital platforms.",
    "offshoring":         "Assess offshoring/outsourcing opportunities: tasks suitable for low-cost "
                          "location delivery or third-party outsourcing based on complexity and risk.",
}

BC_SYSTEM_PROMPT = """You are a senior management consultant specialising in process optimisation and automation.

Generate a professional Process Optimisation Business Case in markdown format based on the source documents provided.

Formatting rules:
- Use # for the document title only (H1)
- Use ## for section headings (H2)
- Use numbered lists (1. 2. 3.) for sequential items such as steps and phases
- Use bullet lists (- ) for non-sequential items
- Use **Bold:** format for key-value pairs and financial figures
- Do NOT use markdown tables
- Do NOT include any explanation outside the document itself — return only the business case"""


def _generate_business_case(client: anthropic.Anthropic, combined_text: str,
                             process_name: str, department: str,
                             selected_focuses: list, selected_sections: list) -> str:
    today = date.today().strftime("%B %Y")

    # Build focus instructions
    focus_lines = []
    for fid in selected_focuses:
        if fid in IMPROVEMENT_FOCUS_META:
            focus_lines.append(f"- {IMPROVEMENT_FOCUS_META[fid]}")
    focus_block = "\n".join(focus_lines)

    # Build ordered section instructions
    ordered = [item for item in BC_SECTIONS_META if item[0] in selected_sections]
    section_lines = []
    for i, (sid, title, instr) in enumerate(ordered, 1):
        section_lines.append(f"{i}. ## {title}\n   {instr}")
    sections_block = "\n\n".join(section_lines)

    system = (
        BC_SYSTEM_PROMPT
        + f"\n\nThe document must start with:\n# Process Optimisation Business Case: [Process Name]\n"
          f"**Prepared by:** POET  **Department:** {department or 'N/A'}  **Date:** {today}\n---\n\n"
          f"Improvement focus areas to analyse:\n{focus_block}\n\n"
          f"Then include exactly these sections in this order:\n\n{sections_block}"
    )

    dept_note = f" owned by the {department} team" if department.strip() else ""
    focus_names = [IMPROVEMENT_FOCUS_META.get(f, f).split(':')[0] for f in selected_focuses]
    user_msg = (
        f'Generate a business case for the "{process_name}" process{dept_note}. '
        f"Focus areas: {', '.join(selected_focuses)}. "
        f"Based on the following source documents:\n\n{combined_text[:12000]}"
    )

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4000,
        system=system,
        messages=[{"role": "user", "content": user_msg}]
    )
    return message.content[0].text


def _make_bc_pptx(bc_markdown: str, process_name: str) -> bytes:
    from pptx import Presentation as PptxPresentation
    from pptx.util import Inches, Pt
    from pptx.dml.color import RGBColor as PptxRGB

    prs = PptxPresentation()
    prs.slide_width  = Inches(13.33)
    prs.slide_height = Inches(7.5)

    blank_layout = prs.slide_layouts[6]  # blank
    title_layout = prs.slide_layouts[0]  # title slide

    lines   = bc_markdown.split('\n')
    current_title   = None
    current_content = []

    def flush_slide():
        if current_title is None:
            return
        slide = prs.slides.add_slide(blank_layout)
        # Title box
        tx = slide.shapes.add_textbox(Inches(0.5), Inches(0.3), Inches(12.3), Inches(0.9))
        tf = tx.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        run = p.add_run()
        run.text = current_title
        run.font.bold = True
        run.font.size = Pt(22)
        run.font.color.rgb = PptxRGB(0x0f, 0x17, 0x2a)
        # Divider line (thin rectangle)
        slide.shapes.add_shape(1, Inches(0.5), Inches(1.1), Inches(12.3), Inches(0.03))
        # Content box
        cx = slide.shapes.add_textbox(Inches(0.5), Inches(1.25), Inches(12.3), Inches(5.8))
        cf = cx.text_frame
        cf.word_wrap = True
        first = True
        for line in current_content:
            s = line.strip()
            if not s:
                continue
            if first:
                para = cf.paragraphs[0]
                first = False
            else:
                para = cf.add_paragraph()
            # Bullet point
            if s.startswith('- '):
                s = '• ' + s[2:]
            elif re.match(r'^\d+\.\s', s):
                pass  # keep numbered
            run2 = para.add_run()
            run2.text = re.sub(r'\*\*(.+?)\*\*', r'\1', s)  # strip bold markers
            run2.font.size = Pt(13)
            run2.font.color.rgb = PptxRGB(0x33, 0x41, 0x55)

    for line in lines:
        s = line.strip()
        if s.startswith('# ') and not s.startswith('## '):
            # Cover slide
            slide = prs.slides.add_slide(title_layout)
            slide.shapes.title.text = s[2:]
            if slide.placeholders[1]:
                slide.placeholders[1].text = f"Process Optimisation Business Case\n{date.today().strftime('%B %Y')}"
        elif s.startswith('## '):
            flush_slide()
            current_title   = s[3:]
            current_content = []
        elif s == '---':
            continue
        else:
            if current_title is not None:
                current_content.append(s)

    flush_slide()

    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()


@app.post("/api/generate-business-case")
async def generate_business_case_endpoint(
    files:         List[UploadFile] = File(...),
    process_name:  str = Form(...),
    department:    str = Form(""),
    focuses_json:  str = Form("[]"),
    sections_json: str = Form("[]"),
):
    if not files:
        raise HTTPException(status_code=400, detail="At least one file is required.")

    all_texts = []
    for f in files:
        ext = Path(f.filename).suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type '{ext}' in {f.filename}."
            )
        file_bytes = await f.read()
        size_mb    = len(file_bytes) / (1024 * 1024)
        if size_mb > MAX_FILE_SIZE_MB:
            raise HTTPException(
                status_code=413,
                detail=f"File '{f.filename}' is too large ({size_mb:.1f} MB)."
            )
        try:
            text = extract_text(file_bytes, f.filename)
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Could not parse '{f.filename}': {str(e)}")
        if text.strip():
            all_texts.append(f"=== Source: {f.filename} ===\n{text.strip()}")

    if not all_texts:
        raise HTTPException(status_code=422, detail="No text could be extracted from the uploaded documents.")

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY is not configured in backend/.env")

    selected_focuses  = json.loads(focuses_json)  if focuses_json.strip()  else []
    selected_sections = json.loads(sections_json) if sections_json.strip() else BC_DEFAULT_SECTIONS
    if not selected_sections:
        selected_sections = BC_DEFAULT_SECTIONS

    try:
        client      = anthropic.Anthropic(api_key=api_key)
        combined    = "\n\n".join(all_texts)
        bc_markdown = _generate_business_case(
            client, combined, process_name, department, selected_focuses, selected_sections
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Business case generation failed: {str(e)}")

    return JSONResponse({"status": "success", "bc_markdown": bc_markdown})


@app.post("/api/export-business-case")
async def export_business_case(
    bc_markdown:  str = Form(...),
    process_name: str = Form("Business Case"),
    format:       str = Form("docx"),
):
    safe_name = re.sub(r'[^a-z0-9_\-]', '_', process_name.lower()) or 'business_case'
    fmt = format.lower().strip()
    try:
        if fmt == "pptx":
            content   = _make_bc_pptx(bc_markdown, process_name)
            media     = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            filename  = f"{safe_name}.pptx"
        else:
            content   = _make_sop_docx(bc_markdown, process_name)
            media     = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            filename  = f"{safe_name}.docx"
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")

    return Response(
        content=content,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
