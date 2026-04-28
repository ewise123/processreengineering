// Mirrors Pydantic schemas in backend/app/schemas/.

export type UUID = string;

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Project {
  id: UUID;
  org_id: UUID;
  name: string;
  client_name: string | null;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectCreate {
  name: string;
  client_name?: string | null;
  description?: string | null;
}

export interface ProjectUpdate {
  name?: string;
  client_name?: string | null;
  description?: string | null;
  status?: string;
}

export interface InputRow {
  id: UUID;
  project_id: UUID;
  type: string;
  name: string;
  file_path: string | null;
  file_size: number | null;
  mime_type: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  claim_count: number;
}

export interface InputParseResult {
  input_id: UUID;
  section_count: number;
  chunk_count: number;
  status: string;
}

export interface EmbedResult {
  input_id: UUID;
  embedded_count: number;
  skipped_count: number;
}

export interface Claim {
  id: UUID;
  project_id: UUID;
  kind: string;
  subject: string;
  normalized: Record<string, unknown>;
  confidence: number | null;
  created_at: string;
  updated_at: string;
}

export interface ClaimConflict {
  id: UUID;
  claim_a_id: UUID;
  claim_b_id: UUID;
  kind: string;
  detected_by: string;
  resolution_status: string;
  resolution_notes: string | null;
  created_at: string;
}

export interface ClaimExtractionResult {
  input_id: UUID;
  claim_count: number;
  citation_count: number;
}

export interface ConflictDetectionResult {
  project_id: UUID;
  claim_count: number;
  new_conflict_count: number;
}

export interface ProcessModel {
  id: UUID;
  project_id: UUID;
  name: string;
  level: string;
  parent_model_id: UUID | null;
  created_at: string;
  updated_at: string;
  latest_version_id: UUID | null;
  latest_version_number: number | null;
}

export interface ProcessVersion {
  id: UUID;
  model_id: UUID;
  version_number: number;
  status: string;
  bpmn_xml: string | null;
  notes: string | null;
  created_at: string;
}

export interface ProcessLane {
  id: UUID;
  name: string;
  order_index: number;
}

export interface ProcessNode {
  id: UUID;
  type: string;
  name: string;
  lane_id: UUID | null;
  position: Record<string, unknown>;
  properties: Record<string, unknown>;
}

export interface ProcessEdge {
  id: UUID;
  source_node_id: UUID;
  target_node_id: UUID;
  label: string | null;
  condition_text: string | null;
}

export interface ProcessGraph {
  version: ProcessVersion;
  lanes: ProcessLane[];
  nodes: ProcessNode[];
  edges: ProcessEdge[];
}

export interface ProcessMapGenerateRequest {
  name: string;
  level: string;
  focus?: string | null;
  map_type?: string | null;
  scope_input_ids?: UUID[] | null;
}

export interface ProcessMapGenerateResult {
  model_id: UUID;
  version_id: UUID;
  process_name: string;
  level: string;
  lane_count: number;
  node_count: number;
  edge_count: number;
  node_link_count: number;
  bpmn_xml_size: number;
}

export const INPUT_TYPES = [
  "interview_transcript",
  "interview_notes",
  "sop_document",
  "operating_manual",
  "process_map_upload",
  "event_log",
  "observation_notes",
  "meeting_minutes",
  "strategy_document",
  "organizational_chart",
  "role_description",
  "policy_document",
  "sla_agreement",
  "operational_dashboard",
  "governance_charter",
  "business_requirements",
  "email_thread",
  "transaction_data",
  "vendor_procedure",
  "audio_file",
] as const;

export type InputType = (typeof INPUT_TYPES)[number];

export const CLAIM_KINDS = [
  "actor",
  "task",
  "decision",
  "threshold",
  "sla",
  "dependency",
  "exception",
  "control",
  "system",
  "gateway_condition",
] as const;
