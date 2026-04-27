from enum import StrEnum


class InputType(StrEnum):
    INTERVIEW_TRANSCRIPT = "interview_transcript"
    INTERVIEW_NOTES = "interview_notes"
    SOP_DOCUMENT = "sop_document"
    OPERATING_MANUAL = "operating_manual"
    PROCESS_MAP_UPLOAD = "process_map_upload"
    EVENT_LOG = "event_log"
    OBSERVATION_NOTES = "observation_notes"
    MEETING_MINUTES = "meeting_minutes"
    STRATEGY_DOCUMENT = "strategy_document"
    ORGANIZATIONAL_CHART = "organizational_chart"
    ROLE_DESCRIPTION = "role_description"
    POLICY_DOCUMENT = "policy_document"
    SLA_AGREEMENT = "sla_agreement"
    OPERATIONAL_DASHBOARD = "operational_dashboard"
    GOVERNANCE_CHARTER = "governance_charter"
    BUSINESS_REQUIREMENTS = "business_requirements"
    EMAIL_THREAD = "email_thread"
    TRANSACTION_DATA = "transaction_data"
    VENDOR_PROCEDURE = "vendor_procedure"
    AUDIO_FILE = "audio_file"


class InputStatus(StrEnum):
    UPLOADED = "uploaded"
    PARSING = "parsing"
    PARSED = "parsed"
    FAILED = "failed"


class AnalysisType(StrEnum):
    CURRENT_STATE = "current_state_analysis"
    PAIN_POINT = "pain_point_analysis"
    VARIANT = "variant_analysis"
    CONFORMANCE = "conformance_check"
    BOTTLENECK = "bottleneck_analysis"
    AUTOMATION = "automation_assessment"
    FUTURE_STATE = "future_state_design"
    BUSINESS_CASE = "business_case"


class OutputType(StrEnum):
    GM_EXEC_OVERVIEW = "gm_exec_overview_doc"
    GM_CONTEXT_ARCHITECTURE = "gm_context_architecture_doc"
    BPMN_PACKAGE = "bpmn_map_package_l1_l6"
    ACTIVITY_LEVEL = "activity_level_doc"
    RACI_MATRIX = "raci_matrix_doc"
    CONTROLS_RISK = "controls_risk_framework_doc"
    EXCEPTION_ESCALATION = "exception_escalation_doc"
    GOVERNANCE = "governance_doc"
    AUTOMATION_OPPORTUNITIES = "automation_opportunities_doc"


class OutputFormat(StrEnum):
    DOCX = "docx"
    PPTX = "pptx"
    PDF = "pdf"
    PNG = "png"
    XLSX = "xlsx"
    JSON = "json"


class ProcessLevel(StrEnum):
    L1 = "L1"
    L2 = "L2"
    L3 = "L3"
    L4 = "L4"
    L5 = "L5"
    L6 = "L6"


class ProcessVersionStatus(StrEnum):
    DRAFT = "draft"
    REVIEW = "review"
    APPROVED = "approved"


class NodeType(StrEnum):
    TASK = "task"
    EVENT_START = "event_start"
    EVENT_END = "event_end"
    EVENT_INTERMEDIATE = "event_intermediate"
    GATEWAY_EXCLUSIVE = "gateway_exclusive"
    GATEWAY_PARALLEL = "gateway_parallel"
    GATEWAY_INCLUSIVE = "gateway_inclusive"
    SUBPROCESS = "subprocess"


class ClaimKind(StrEnum):
    ACTOR = "actor"
    TASK = "task"
    DECISION = "decision"
    THRESHOLD = "threshold"
    SLA = "sla"
    DEPENDENCY = "dependency"
    EXCEPTION = "exception"
    CONTROL = "control"
    SYSTEM = "system"
    GATEWAY_CONDITION = "gateway_condition"


class ClaimLinkKind(StrEnum):
    SUPPORTS = "supports"
    PARTIAL = "partial"
    INFERRED = "inferred"
    AI_PROPOSED = "ai_proposed"


class ConflictKind(StrEnum):
    THRESHOLD_MISMATCH = "threshold_mismatch"
    OWNER_MISMATCH = "owner_mismatch"
    SLA_MISMATCH = "sla_mismatch"
    SEQUENCE_MISMATCH = "sequence_mismatch"
    MISSING_PATH = "missing_path"


class ConflictStatus(StrEnum):
    DETECTED = "detected"
    RESOLVED = "resolved"
    DISMISSED = "dismissed"


class EntityKind(StrEnum):
    ACTOR = "actor"
    ROLE = "role"
    SYSTEM = "system"
    DOCUMENT = "document"
    POLICY = "policy"


class SectionKind(StrEnum):
    PAGE = "page"
    SLIDE = "slide"
    HEADING = "heading"
    TABLE = "table"
    TRANSCRIPT_TURN = "transcript_turn"
    SHEET_RANGE = "sheet_range"


class ProjectStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class ProjectMemberRole(StrEnum):
    OWNER = "owner"
    EDITOR = "editor"
    REVIEWER = "reviewer"
    VIEWER = "viewer"


class ReviewTargetType(StrEnum):
    PROCESS_MODEL = "process_model"
    PROCESS_VERSION = "process_version"
    PROCESS_NODE = "process_node"
    PROCESS_EDGE = "process_edge"


class ReviewStatus(StrEnum):
    REQUESTED = "requested"
    IN_PROGRESS = "in_progress"
    APPROVED = "approved"
    CHANGES_REQUESTED = "changes_requested"


class JobKind(StrEnum):
    DOCUMENT_PARSE = "document_parse"
    PROCESS_GENERATION = "process_generation"
    CLAIM_EXTRACTION = "claim_extraction"
    EMBEDDING = "embedding"
    EXPORT = "export"


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
