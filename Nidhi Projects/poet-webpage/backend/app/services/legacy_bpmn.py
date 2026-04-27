"""BPMN 2.0 XML construction.

The body of `build_bpmn_xml`, `_strip_actor`, `_esc`, and `validate_xml` is
reused verbatim from the legacy `main.py` (still in production for the static
HTML tools). When `main.py` is eventually retired, the duplication can be
removed.
"""
import xml.etree.ElementTree as ET


def _strip_actor(name: str, role: str) -> str:
    """Remove a leading actor/role prefix from a task label."""
    if not name or not role:
        return name
    for candidate in [role] + role.replace("/", " ").split():
        candidate = candidate.strip()
        if len(candidate) < 3:
            continue
        if name.lower().startswith(candidate.lower()):
            remainder = name[len(candidate):].lstrip(" \t-–:,")
            if remainder:
                return remainder[0].upper() + remainder[1:]
    return name


def _esc(text: str) -> str:
    """Escape XML special characters in attribute values."""
    return (
        text.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def build_bpmn_xml(structure: dict) -> str:
    process_name = structure.get("process_name", "Process")
    steps = structure.get("steps", [])
    gateways = structure.get("gateways", [])

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

    POOL_HDR_W = 30
    LANE_LBL_W = 120
    CONTENT_OFF = POOL_HDR_W + LANE_LBL_W + 60
    H_STEP = 175
    LANE_H = 150
    P_X = 50
    P_Y = 50
    MARGIN_R = 100

    TASK_TYPES = {
        "userTask",
        "serviceTask",
        "manualTask",
        "businessRuleTask",
        "sendTask",
        "receiveTask",
        "scriptTask",
        "task",
    }
    GATEWAY_ELEMENT = {
        "exclusive": "exclusiveGateway",
        "parallel": "parallelGateway",
        "inclusive": "inclusiveGateway",
    }

    SIZES: dict[str, tuple[int, int]] = {
        "startEvent": (36, 36),
        "endEvent": (36, 36),
        "task": (120, 80),
        "gateway": (50, 50),
    }

    gateway_map = {gw["after_step"]: gw for gw in gateways}
    first_role = (steps[0].get("role") or "Process Team").strip() if steps else "Process Team"
    last_role = (steps[-1].get("role") or "Process Team").strip() if steps else "Process Team"

    elements: list[dict] = []
    elements.append({"id": "Start_1", "type": "startEvent", "name": "Start", "role": first_role})
    for step in steps:
        role = (step.get("role") or "Process Team").strip()
        task_name = _strip_actor(step.get("name", ""), role)
        raw_type = (step.get("type") or "userTask").strip()
        step_type = raw_type if raw_type in TASK_TYPES else "userTask"
        elements.append({"id": step["id"], "type": step_type, "name": task_name, "role": role})
        if step["id"] in gateway_map:
            gw = gateway_map[step["id"]]
            gw_type = GATEWAY_ELEMENT.get((gw.get("type") or "exclusive").strip(), "exclusiveGateway")
            elements.append(
                {
                    "id": gw["id"],
                    "type": gw_type,
                    "name": gw.get("name", "Decision?"),
                    "yes_label": gw.get("yes_label", "Yes"),
                    "no_label": gw.get("no_label", "No"),
                    "role": role,
                }
            )
    elements.append({"id": "End_1", "type": "endEvent", "name": "End", "role": last_role})

    for col, el in enumerate(elements):
        li = lane_of(el["role"])
        size_key = (
            el["type"]
            if el["type"] in SIZES
            else "task"
            if el["type"] in TASK_TYPES
            else "gateway"
            if "Gateway" in el["type"]
            else "task"
        )
        w, h = SIZES[size_key]
        cx = P_X + CONTENT_OFF + col * H_STEP
        cy = P_Y + li * LANE_H + LANE_H // 2
        el.update(
            {
                "col": col,
                "lane_idx": li,
                "w": w,
                "h": h,
                "cx": cx,
                "cy": cy,
                "x": cx - w // 2,
                "y": cy - h // 2,
            }
        )
        el["right_x"] = cx + w // 2
        el["left_x"] = cx - w // 2
        el["top_y"] = cy - h // 2
        el["bot_y"] = cy + h // 2

    el_by_id = {el["id"]: el for el in elements}

    last_cx = max(el["cx"] for el in elements)
    P_W = (last_cx - P_X) + SIZES["task"][0] // 2 + MARGIN_R
    P_H = len(role_order) * LANE_H

    flows: list[dict] = []
    fc = [1]
    gateway_no = {gw["id"]: (gw.get("no_to") or "") for gw in gateways}

    def add_flow(src_id: str, tgt_id: str, name: str = "") -> None:
        fid = f"Flow_{fc[0]}"
        fc[0] += 1
        src = el_by_id.get(src_id)
        tgt = el_by_id.get(tgt_id)
        if not (src and tgt):
            return
        forward = tgt["col"] > src["col"]
        adjacent = abs(tgt["col"] - src["col"]) == 1
        same_lane = src["lane_idx"] == tgt["lane_idx"]

        max_lane = max(src["lane_idx"], tgt["lane_idx"])
        min_lane = min(src["lane_idx"], tgt["lane_idx"])
        bot_corridor = P_Y + (max_lane + 1) * LANE_H - 15
        top_corridor = P_Y + min_lane * LANE_H + 15

        if forward and adjacent and same_lane:
            wps = [(src["right_x"], src["cy"]), (tgt["left_x"], tgt["cy"])]
        elif forward and adjacent:
            mid_x = (src["right_x"] + tgt["left_x"]) // 2
            wps = [
                (src["right_x"], src["cy"]),
                (mid_x, src["cy"]),
                (mid_x, tgt["cy"]),
                (tgt["left_x"], tgt["cy"]),
            ]
        elif forward:
            wps = [
                (src["cx"], src["bot_y"]),
                (src["cx"], bot_corridor),
                (tgt["cx"], bot_corridor),
                (tgt["cx"], tgt["bot_y"]),
            ]
        else:
            wps = [
                (src["cx"], src["top_y"]),
                (src["cx"], top_corridor),
                (tgt["cx"], top_corridor),
                (tgt["cx"], tgt["top_y"]),
            ]

        label_bounds = None
        if name and "Gateway" in src["type"] and src["type"] != "parallelGateway":
            ex, ey = wps[0]
            if abs(ex - src["right_x"]) <= 2:
                label_bounds = (ex + 4, ey - 18, 30, 14)
            elif abs(ey - src["bot_y"]) <= 2:
                label_bounds = (ex + 4, ey + 4, 30, 14)
            elif abs(ey - src["top_y"]) <= 2:
                label_bounds = (ex + 4, ey - 18, 30, 14)
            else:
                label_bounds = (ex + 4, ey - 14, 30, 14)

        flows.append(
            {
                "id": fid,
                "source": src_id,
                "target": tgt_id,
                "name": name,
                "waypoints": wps,
                "label_bounds": label_bounds,
            }
        )

    for i in range(len(elements) - 1):
        src = elements[i]
        nxt = elements[i + 1]
        if "Gateway" in src["type"]:
            is_parallel = src["type"] == "parallelGateway"
            add_flow(src["id"], nxt["id"], "" if is_parallel else "Yes")
            no_tgt = gateway_no.get(src["id"]) or "End_1"
            if no_tgt not in el_by_id:
                no_tgt = "End_1"
            if no_tgt == nxt["id"]:
                no_tgt = "End_1"
            if no_tgt != nxt["id"]:
                add_flow(src["id"], no_tgt, "" if is_parallel else "No")
        else:
            add_flow(src["id"], nxt["id"])

    lines: list[str] = []
    lines.append('<?xml version="1.0" encoding="UTF-8"?>')
    lines.append('<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"')
    lines.append('             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"')
    lines.append('             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"')
    lines.append('             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"')
    lines.append('             id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">')

    lines.append('  <collaboration id="Collab_1">')
    lines.append(f'    <participant id="Part_1" name="{_esc(process_name)}" processRef="Process_1"/>')
    lines.append('  </collaboration>')

    lines.append(f'  <process id="Process_1" name="{_esc(process_name)}" isExecutable="false">')

    lines.append('    <laneSet id="LaneSet_1">')
    for li, role in enumerate(role_order):
        lid = f"Lane_{li + 1}"
        lines.append(f'      <lane id="{lid}" name="{_esc(role)}">')
        for el in elements:
            if el["lane_idx"] == li:
                lines.append(f'        <flowNodeRef>{el["id"]}</flowNodeRef>')
        lines.append('      </lane>')
    lines.append('    </laneSet>')

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

    for fl in flows:
        na = f' name="{_esc(fl["name"])}"' if fl["name"] else ""
        lines.append(
            f'    <sequenceFlow id="{fl["id"]}" sourceRef="{fl["source"]}" targetRef="{fl["target"]}"{na}/>'
        )

    lines.append('  </process>')

    lines.append('  <bpmndi:BPMNDiagram id="BPMNDiagram_1">')
    lines.append('    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Collab_1">')

    lines.append('      <bpmndi:BPMNShape id="Shape_Part_1" bpmnElement="Part_1" isHorizontal="true">')
    lines.append(f'        <dc:Bounds x="{P_X}" y="{P_Y}" width="{P_W}" height="{P_H}"/>')
    lines.append('      </bpmndi:BPMNShape>')

    for li, role in enumerate(role_order):
        lid = f"Lane_{li + 1}"
        lines.append(f'      <bpmndi:BPMNShape id="Shape_{lid}" bpmnElement="{lid}" isHorizontal="true">')
        lines.append(
            f'        <dc:Bounds x="{P_X + POOL_HDR_W}" y="{P_Y + li * LANE_H}" width="{P_W - POOL_HDR_W}" height="{LANE_H}"/>'
        )
        lines.append('      </bpmndi:BPMNShape>')

    _TYPED_TASKS = {
        "userTask",
        "serviceTask",
        "manualTask",
        "businessRuleTask",
        "sendTask",
        "receiveTask",
        "scriptTask",
    }
    for el in elements:
        lines.append(f'      <bpmndi:BPMNShape id="Shape_{el["id"]}" bpmnElement="{el["id"]}">')
        lines.append(
            f'        <dc:Bounds x="{el["x"]}" y="{el["y"]}" width="{el["w"]}" height="{el["h"]}"/>'
        )
        if "Gateway" in el["type"]:
            GW_LBL_W = 90
            GW_LBL_H = 40
            GAP = 6
            lx = el["cx"] - GW_LBL_W
            ly = el["top_y"] - GW_LBL_H - GAP
            lines.append('        <bpmndi:BPMNLabel>')
            lines.append(f'          <dc:Bounds x="{lx}" y="{ly}" width="{GW_LBL_W}" height="{GW_LBL_H}"/>')
            lines.append('        </bpmndi:BPMNLabel>')
        elif el["type"] in _TYPED_TASKS:
            ICON_H = 24
            lines.append('        <bpmndi:BPMNLabel>')
            lines.append(
                f'          <dc:Bounds x="{el["x"]}" y="{el["y"] + ICON_H}" width="{el["w"]}" height="{el["h"] - ICON_H}"/>'
            )
            lines.append('        </bpmndi:BPMNLabel>')
        lines.append('      </bpmndi:BPMNShape>')

    for fl in flows:
        if not fl["waypoints"]:
            continue
        lines.append(f'      <bpmndi:BPMNEdge id="Edge_{fl["id"]}" bpmnElement="{fl["id"]}">')
        for wx, wy in fl["waypoints"]:
            lines.append(f'        <di:waypoint x="{wx}" y="{wy}"/>')
        if fl.get("label_bounds"):
            lx, ly, lw, lh = fl["label_bounds"]
            lines.append('        <bpmndi:BPMNLabel>')
            lines.append(f'          <dc:Bounds x="{lx}" y="{ly}" width="{lw}" height="{lh}"/>')
            lines.append('        </bpmndi:BPMNLabel>')
        lines.append('      </bpmndi:BPMNEdge>')

    lines.append('    </bpmndi:BPMNPlane>')
    lines.append('  </bpmndi:BPMNDiagram>')
    lines.append('</definitions>')

    return "\n".join(lines)


def validate_xml(xml_str: str) -> tuple[bool, str]:
    try:
        ET.fromstring(xml_str.encode("utf-8"))
        return True, ""
    except ET.ParseError as e:
        return False, str(e)
