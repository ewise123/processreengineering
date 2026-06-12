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
  chunks_processed: number;
  chunks_total: number;
  extraction_started_at: string | null;
  extraction_error: string | null;
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
  source: string;
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
  detection_reason: string | null;
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
  process_id?: UUID | null;
  process_name?: string | null;
  unreconciled_claim_count?: number;
}

export interface ProcessVersion {
  id: UUID;
  model_id: UUID;
  parent_version_id: UUID | null;
  version_number: number;
  status: string;
  bpmn_xml: string | null;
  notes: string | null;
  created_at: string;
}

export interface VersionSummary {
  id: UUID;
  version_number: number;
  parent_version_id: UUID | null;
  status: string;
  notes: string | null;
  created_at: string;
  node_count: number;
  lane_count: number;
  edge_count: number;
}

export interface NodeChange {
  name: string;
  from_name?: string | null;
  from_lane?: string | null;
  to_lane?: string | null;
}

export interface EdgeChange {
  source: string;
  target: string;
}

export interface LaneChange {
  name: string;
}

export interface VersionDiff {
  nodes: {
    added: NodeChange[];
    removed: NodeChange[];
    renamed: NodeChange[];
    moved: NodeChange[];
    unchanged_count: number;
  };
  edges: { added: EdgeChange[]; removed: EdgeChange[] };
  lanes: { added: LaneChange[]; removed: LaneChange[] };
}

export type ReviewDecision = "approved" | "changes_requested";

export interface NodeReview {
  node_id: UUID;
  status: ReviewDecision;
  note: string | null;
}

export interface ReviewCounts {
  approved: number;
  changes_requested: number;
  pending: number;
  total: number;
}

export interface ReviewState {
  version_id: UUID;
  version_status: string;
  request_status: string | null;
  nodes: NodeReview[];
  counts: ReviewCounts;
}

export interface NodeReviewUpdate {
  status: ReviewDecision;
  note?: string;
}

export interface ProcessLane {
  id: UUID;
  name: string;
  order_index: number;
  height_px: number;
  color: string | null;
  collapsed: boolean;
}

export interface LaneCreate {
  name: string;
  order_index: number;
  height_px?: number | null;
}

export interface LaneUpdate {
  name?: string;
  order_index?: number;
  height_px?: number;
  color?: string;
  collapsed?: boolean;
}

export interface NodeUpdate {
  name?: string;
  type?: string;
  lane_id?: UUID;
  x?: number;
  relative_y?: number;
  description?: string;
}

export interface NodeCreate {
  type: string;
  name: string;
  lane_id: UUID;
  x: number;
  relative_y: number;
}

export interface EdgeCreate {
  source_node_id: UUID;
  target_node_id: UUID;
  label?: string | null;
}

export interface EdgeUpdate {
  label?: string | null;
  bend_x?: number | null;
  bend_y?: number | null;
}

export interface CitationDetail {
  citation_id: UUID;
  chunk_id: UUID;
  quote: string;
  confidence: number | null;
  input_id: UUID;
  input_name: string;
  input_type: string;
  section_kind: string;
  section_ref: Record<string, unknown>;
}

export interface ClaimWithCitations {
  id: UUID;
  kind: string;
  subject: string;
  normalized: Record<string, unknown>;
  confidence: number | null;
  link_kind: string;
  citations: CitationDetail[];
}

export interface NodeCitations {
  node_id: UUID;
  claims: ClaimWithCitations[];
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
  bend_x?: number | null;
  bend_y?: number | null;
}

export interface ProcessGraph {
  version: ProcessVersion;
  lanes: ProcessLane[];
  nodes: ProcessNode[];
  edges: ProcessEdge[];
}

export type IssueSeverity = "medium" | "high";

export interface NodeIssue {
  node_id: UUID;
  severity: IssueSeverity;
  conflict_count: number;
}

export interface ClaimSummary {
  id: UUID;
  kind: string;
  subject: string;
  normalized: Record<string, unknown>;
  confidence: number | null;
}

export interface NodeIssueDetail {
  conflict_id: UUID;
  kind: string;
  resolution_status: string;
  detected_by: string;
  resolution_notes: string | null;
  detection_reason: string | null;
  this_claim: ClaimSummary;
  other_claim: ClaimSummary;
}

export interface NodeIssuesDetail {
  node_id: UUID;
  issues: NodeIssueDetail[];
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  history: ChatTurn[];
  user_message: string;
  selected_node_id?: UUID | null;
  selected_edge_id?: UUID | null;
}

export interface ChatResponse {
  content: string;
}

export interface ProcessMapGenerateRequest {
  name: string;
  level: string;
  focus?: string | null;
  map_type?: string | null;
  scope_input_ids?: UUID[] | null;
  process_id?: UUID | null;
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

export interface Process {
  id: UUID;
  project_id: UUID;
  name: string;
  description: string;
  order_index: number;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
  claim_count: number;
  map_count: number;
}

export interface TriageClaim {
  id: UUID;
  kind: string;
  subject: string;
  source: string;
}

export interface ProcessSuggestion {
  id: UUID;
  batch_id: UUID;
  project_id: UUID;
  kind: "process_discovery" | "map_reconcile";
  process_id: UUID | null;
  version_id: UUID | null;
  op: string;
  payload: Record<string, unknown>;
  rationale: string;
  confidence: number | null;
  status: "pending" | "accepted" | "rejected";
  outcome: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface SuggestBatchResult {
  batch_id: UUID;
  suggestion_count: number;
}

export type ReconcileOp =
  | "add_step"
  | "recite_node"
  | "flag_stale_node"
  | "relabel_node";

export interface ReconcileSuggestion {
  id: UUID;
  batch_id: UUID;
  op: ReconcileOp;
  /** Op-specific payload with resolved UUIDs. See the SP-7c op vocabulary. */
  payload: Record<string, unknown>;
  rationale: string;
  confidence: number | null;
  status: "pending" | "accepted" | "rejected";
}

export interface ReconcileBatch {
  /** null when the delta was empty and no LLM call was made. */
  batch_id: UUID | null;
  version_id: UUID;
  empty: boolean;
  suggestions: ReconcileSuggestion[];
}

export interface AcceptSuggestionResult {
  suggestion_id: UUID;
  status: string;
  outcome: string;
  process_id?: UUID | null;
  linked?: number;
}

export interface BatchAcceptResult {
  batch_id: UUID;
  accepted: number;
  skipped: number;
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

export type AiEditAction = "relabel" | "describe" | "validate" | "suggest_next";

export interface RelabelProposal {
  proposed_name: string;
  unchanged: boolean;
  rationale: string;
  cited_claim_ids: UUID[];
}

export interface DescribeProposal {
  proposed_description: string;
  rationale: string;
  cited_claim_ids: UUID[];
}

export interface ValidateGap {
  summary: string;
  severity: "low" | "medium" | "high";
  cited_claim_ids: UUID[];
}

export interface ValidateProposal {
  gaps: ValidateGap[];
}

export interface SuggestedStep {
  proposed_name: string;
  proposed_type: string;
  edge_label: string | null;
  rationale: string;
  cited_claim_ids: UUID[];
}

export interface SuggestNextProposal {
  steps: SuggestedStep[];
}

export interface AiEditResponse {
  action: AiEditAction;
  relabel?: RelabelProposal | null;
  describe?: DescribeProposal | null;
  validate?: ValidateProposal | null;
  suggest_next?: SuggestNextProposal | null;
}

export interface AiProposedStepRequest {
  source_node_id: UUID;
  name: string;
  type: string;
  lane_id: UUID;
  x: number;
  relative_y: number;
  edge_label?: string | null;
  cited_claim_ids: UUID[];
}

export interface AiProposedStepResult {
  node: ProcessNode;
  edge: ProcessEdge;
}

/** What the document viewer should open to. `sectionRef`/`quote` drive the
 *  jump-and-highlight; both null when opening a document without a citation
 *  (e.g. from the Sources tab). */
export interface ViewerTarget {
  inputId: UUID;
  inputName: string;
  sectionRef: Record<string, unknown> | null;
  quote: string | null;
}

export interface ClaimCreate {
  kind: string;
  subject: string;
  normalized?: Record<string, unknown>;
}

export interface ClaimUpdate {
  kind?: string;
  subject?: string;
  normalized?: Record<string, unknown>;
}

export interface ClaimImpactMap {
  model_id: UUID;
  name: string;
}

export interface ClaimImpact {
  claim_id: UUID;
  node_link_count: number;
  maps: ClaimImpactMap[];
}

export interface ConflictResolve {
  resolution_status: string;
  resolution_notes?: string | null;
}

export interface NodeClaimLinkRequest {
  claim_ids: UUID[];
  link_kind?: string;
}

export interface NodeClaimLinkResult {
  node_id: UUID;
  linked_claim_ids: UUID[];
  added_count: number;
  already_linked_count: number;
}

export interface BlankMapRequest {
  name: string;
  level: string;
}

export interface BlankMapResult {
  model_id: UUID;
  version_id: UUID;
  name: string;
  level: string;
  lane_id: UUID;
  start_node_id: UUID;
  end_node_id: UUID;
}
