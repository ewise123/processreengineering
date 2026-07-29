import type {
  AcceptSuggestionResult,
  AiEditAction,
  AiEditResponse,
  AiProposedStepRequest,
  AiProposedStepResult,
  AncestryCrumb,
  BatchAcceptResult,
  BlankMapRequest,
  BlankMapResult,
  ChangeEvent,
  ChangeLogPage,
  DecomposeRequest,
  DecomposeResult,
  DeleteRequest,
  ChatRequest,
  ChatResponse,
  ChatSuggestRequest,
  ChatSuggestResponse,
  Claim,
  ClaimConflict,
  ClaimCreate,
  ClaimExtractionResult,
  ClaimImpact,
  ClaimUpdate,
  ConflictDetectionResult,
  ConflictResolve,
  EmbedResult,
  InputParseResult,
  InputRow,
  EdgeCreate,
  EdgeUpdate,
  LaneCreate,
  LaneUpdate,
  NodeCitations,
  NodeClaimLinkRequest,
  NodeClaimLinkResult,
  NodeCreate,
  NodeIssue,
  NodeIssuesDetail,
  NodeReview,
  NodeReviewUpdate,
  NodeUpdate,
  Process,
  ProcessEdge,
  Page,
  ProcessGraph,
  ProcessLane,
  ProcessMapGenerateRequest,
  ProcessMapGenerateResult,
  ProcessModel,
  ProcessNode,
  ProcessSuggestion,
  ProcessVersion,
  Project,
  ProjectCreate,
  ProjectUpdate,
  ReconcileBatch,
  ReviewState,
  SuggestBatchResult,
  SuggestClaimsResult,
  TriageClaim,
  UUID,
  VersionDiff,
  VersionSummary,
} from "@/lib/types";
import { formatErrorDetail } from "@/lib/error-detail";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function request<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {}
): Promise<T> {
  const { json, headers, ...rest } = init;
  const finalHeaders = new Headers(headers);
  let body = init.body;
  if (json !== undefined) {
    finalHeaders.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: finalHeaders,
    body,
  });
  if (!res.ok) {
    const fallback = `${res.status} ${res.statusText}`;
    let detail = fallback;
    try {
      // FastAPI 422s return `detail` as an array of validation errors; pass the
      // whole body to the formatter so it never stringifies to "[object Object]".
      detail = formatErrorDetail(await res.json(), fallback);
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // Projects
  listProjects: (params: { limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<Page<Project>>(`/api/v2/projects${suffix}`);
  },
  getProject: (id: UUID) => request<Project>(`/api/v2/projects/${id}`),
  createProject: (payload: ProjectCreate) =>
    request<Project>("/api/v2/projects", { method: "POST", json: payload }),
  updateProject: (id: UUID, payload: ProjectUpdate) =>
    request<Project>(`/api/v2/projects/${id}`, {
      method: "PATCH",
      json: payload,
    }),
  deleteProject: (id: UUID) =>
    request<void>(`/api/v2/projects/${id}`, { method: "DELETE" }),

  // Inputs
  listInputs: (projectId: UUID, params: { limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<Page<InputRow>>(`/api/v2/projects/${projectId}/inputs${suffix}`);
  },
  /** Absolute URL of the rendered-PDF stream for a source document.
   *  react-pdf fetches by URL, so this returns a string (not a JSON request). */
  inputPdfUrl: (projectId: UUID, inputId: UUID) =>
    `${API_BASE}/api/v2/projects/${projectId}/inputs/${inputId}/pdf`,
  /** Plain-text body of a text source (the no-LibreOffice fast-path).
   *  Rejects (throws) with 415 for non-text formats — the viewer then uses
   *  the PDF path. */
  getInputText: (projectId: UUID, inputId: UUID) =>
    request<{ text: string }>(
      `/api/v2/projects/${projectId}/inputs/${inputId}/text`,
    ),
  uploadInput: async (projectId: UUID, type: string, file: File) => {
    const fd = new FormData();
    fd.append("type", type);
    fd.append("file", file);
    const res = await fetch(`${API_BASE}/api/v2/projects/${projectId}/inputs`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const data = (await res.json()) as { detail?: string };
        if (data.detail) detail = data.detail;
      } catch {
        // ignore
      }
      throw new Error(detail);
    }
    return (await res.json()) as InputRow;
  },
  parseInput: (projectId: UUID, inputId: UUID) =>
    request<InputParseResult>(
      `/api/v2/projects/${projectId}/inputs/${inputId}/parse`,
      { method: "POST" }
    ),
  embedInput: (projectId: UUID, inputId: UUID) =>
    request<EmbedResult>(
      `/api/v2/projects/${projectId}/inputs/${inputId}/embed`,
      { method: "POST" }
    ),
  extractClaims: (projectId: UUID, inputId: UUID) =>
    request<ClaimExtractionResult>(
      `/api/v2/projects/${projectId}/inputs/${inputId}/extract-claims`,
      { method: "POST" }
    ),

  // Claims & conflicts
  listClaims: (
    projectId: UUID,
    params: { kind?: string; limit?: number; offset?: number } = {}
  ) => {
    const qs = new URLSearchParams();
    if (params.kind) qs.set("kind", params.kind);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<Page<Claim>>(`/api/v2/projects/${projectId}/claims${suffix}`);
  },
  createClaim: (projectId: UUID, body: ClaimCreate) =>
    request<Claim>(`/api/v2/projects/${projectId}/claims`, {
      method: "POST",
      json: body,
    }),
  updateClaim: (projectId: UUID, claimId: UUID, body: ClaimUpdate) =>
    request<Claim>(`/api/v2/projects/${projectId}/claims/${claimId}`, {
      method: "PATCH",
      json: body,
    }),
  deleteClaim: (projectId: UUID, claimId: UUID) =>
    request<void>(`/api/v2/projects/${projectId}/claims/${claimId}`, {
      method: "DELETE",
    }),
  getClaimImpact: (projectId: UUID, claimId: UUID) =>
    request<ClaimImpact>(
      `/api/v2/projects/${projectId}/claims/${claimId}/impact`
    ),
  detectConflicts: (projectId: UUID) =>
    request<ConflictDetectionResult>(
      `/api/v2/projects/${projectId}/detect-conflicts`,
      { method: "POST" }
    ),
  listConflicts: (
    projectId: UUID,
    params: { resolution_status?: string; limit?: number; offset?: number } = {}
  ) => {
    const qs = new URLSearchParams();
    if (params.resolution_status) qs.set("resolution_status", params.resolution_status);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<Page<ClaimConflict>>(
      `/api/v2/projects/${projectId}/conflicts${suffix}`
    );
  },
  resolveConflict: (projectId: UUID, conflictId: UUID, body: ConflictResolve) =>
    request<ClaimConflict>(
      `/api/v2/projects/${projectId}/conflicts/${conflictId}`,
      { method: "PATCH", json: body }
    ),

  // Process maps
  listProcessMaps: (projectId: UUID) =>
    request<ProcessModel[]>(`/api/v2/projects/${projectId}/process-maps`),
  generateProcessMap: (projectId: UUID, payload: ProcessMapGenerateRequest) =>
    request<ProcessMapGenerateResult>(
      `/api/v2/projects/${projectId}/generate-process-map`,
      { method: "POST", json: payload }
    ),
  generateBestPractices: (projectId: UUID, body: ProcessMapGenerateRequest) =>
    request<ProcessMapGenerateResult>(
      `/api/v2/projects/${projectId}/generate-best-practices`,
      { method: "POST", json: body }
    ),
  createBlankMap: (projectId: UUID, body: BlankMapRequest) =>
    request<BlankMapResult>(`/api/v2/projects/${projectId}/process-maps`, {
      method: "POST",
      json: body,
    }),
  getProcessGraph: (projectId: UUID, modelId: UUID, versionId: UUID) =>
    request<ProcessGraph>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}`
    ),
  listVersions: (projectId: UUID, modelId: UUID) =>
    request<VersionSummary[]>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions`
    ),
  copyVersion: (
    projectId: UUID,
    modelId: UUID,
    sourceVersionId: UUID,
    note: string | null
  ) =>
    request<ProcessVersion>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${sourceVersionId}/copy`,
      { method: "POST", json: { note } }
    ),
  getVersionDiff: (
    projectId: UUID,
    modelId: UUID,
    fromId: UUID,
    toId: UUID
  ) =>
    request<VersionDiff>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/version-diff?from=${fromId}&to=${toId}`
    ),
  getProcessMapIssues: (projectId: UUID, modelId: UUID, versionId: UUID) =>
    request<NodeIssue[]>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/issues`
    ),
  updateNode: (projectId: UUID, nodeId: UUID, body: NodeUpdate) =>
    request<ProcessNode>(`/api/v2/projects/${projectId}/nodes/${nodeId}`, {
      method: "PATCH",
      json: body,
    }),
  getReviewState: (projectId: UUID, modelId: UUID, versionId: UUID) =>
    request<ReviewState>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/review`
    ),
  setNodeReview: (projectId: UUID, nodeId: UUID, body: NodeReviewUpdate) =>
    request<NodeReview>(`/api/v2/projects/${projectId}/nodes/${nodeId}/review`, {
      method: "PATCH",
      json: body,
    }),
  requestReview: (projectId: UUID, modelId: UUID, versionId: UUID) =>
    request<ReviewState>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/review/request`,
      { method: "POST" }
    ),
  deleteNode: (projectId: UUID, nodeId: UUID, body: DeleteRequest) =>
    request<void>(`/api/v2/projects/${projectId}/nodes/${nodeId}`, {
      method: "DELETE",
      json: body,
    }),
  createEdge: (
    projectId: UUID,
    modelId: UUID,
    versionId: UUID,
    body: EdgeCreate
  ) =>
    request<ProcessEdge>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/edges`,
      { method: "POST", json: body }
    ),
  updateEdge: (projectId: UUID, edgeId: UUID, body: EdgeUpdate) =>
    request<ProcessEdge>(`/api/v2/projects/${projectId}/edges/${edgeId}`, {
      method: "PATCH",
      json: body,
    }),
  deleteEdge: (projectId: UUID, edgeId: UUID, body: DeleteRequest) =>
    request<void>(`/api/v2/projects/${projectId}/edges/${edgeId}`, {
      method: "DELETE",
      json: body,
    }),
  createNode: (
    projectId: UUID,
    modelId: UUID,
    versionId: UUID,
    body: NodeCreate
  ) =>
    request<ProcessNode>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/nodes`,
      { method: "POST", json: body }
    ),
  updateLane: (projectId: UUID, laneId: UUID, body: LaneUpdate) =>
    request<ProcessLane>(`/api/v2/projects/${projectId}/lanes/${laneId}`, {
      method: "PATCH",
      json: body,
    }),
  createLane: (
    projectId: UUID,
    modelId: UUID,
    versionId: UUID,
    body: LaneCreate
  ) =>
    request<ProcessLane>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/lanes`,
      { method: "POST", json: body }
    ),
  deleteLane: (projectId: UUID, laneId: UUID, body: DeleteRequest) =>
    request<void>(`/api/v2/projects/${projectId}/lanes/${laneId}`, {
      method: "DELETE",
      json: body,
    }),
  getNodeCitations: (projectId: UUID, nodeId: UUID) =>
    request<NodeCitations>(
      `/api/v2/projects/${projectId}/nodes/${nodeId}/citations`
    ),
  attachNodeClaims: (
    projectId: UUID,
    nodeId: UUID,
    body: NodeClaimLinkRequest
  ) =>
    request<NodeClaimLinkResult>(
      `/api/v2/projects/${projectId}/nodes/${nodeId}/claims`,
      { method: "POST", json: body }
    ),
  detachNodeClaim: (projectId: UUID, nodeId: UUID, claimId: UUID) =>
    request<void>(
      `/api/v2/projects/${projectId}/nodes/${nodeId}/claims/${claimId}`,
      { method: "DELETE" }
    ),
  getNodeIssues: (projectId: UUID, nodeId: UUID) =>
    request<NodeIssuesDetail>(
      `/api/v2/projects/${projectId}/nodes/${nodeId}/issues`
    ),
  chatWithMap: (
    projectId: UUID,
    modelId: UUID,
    versionId: UUID,
    body: ChatRequest
  ) =>
    request<ChatResponse>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/chat`,
      { method: "POST", json: body }
    ),
  chatSuggest: (
    projectId: UUID,
    modelId: UUID,
    versionId: UUID,
    body: ChatSuggestRequest,
    signal?: AbortSignal
  ) =>
    request<ChatSuggestResponse>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/chat-suggest`,
      { method: "POST", json: body, signal }
    ),
  aiEditNode: (
    projectId: UUID,
    modelId: UUID,
    versionId: UUID,
    nodeId: UUID,
    action: AiEditAction
  ) =>
    request<AiEditResponse>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/nodes/${nodeId}/ai-edit`,
      { method: "POST", json: { action } }
    ),
  applyProposedStep: (
    projectId: UUID,
    modelId: UUID,
    versionId: UUID,
    body: AiProposedStepRequest
  ) =>
    request<AiProposedStepResult>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/ai-proposed-step`,
      { method: "POST", json: body }
    ),
  reconcileMap: (projectId: UUID, modelId: UUID, versionId: UUID) =>
    request<ReconcileBatch>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/reconcile`,
      { method: "POST", json: {} }
    ),
  applyDecompose: (
    projectId: UUID,
    modelId: UUID,
    versionId: UUID,
    nodeId: UUID,
    body: DecomposeRequest
  ) =>
    request<DecomposeResult>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/nodes/${nodeId}/decompose`,
      { method: "POST", json: body }
    ),
  removeSubProcess: (
    projectId: UUID,
    modelId: UUID,
    versionId: UUID,
    nodeId: UUID
  ) =>
    request<void>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/nodes/${nodeId}/decompose`,
      { method: "DELETE" }
    ),
  getProcessMap: (projectId: UUID, modelId: UUID) =>
    request<ProcessModel>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}`
    ),
  getMapAncestry: (projectId: UUID, modelId: UUID) =>
    request<AncestryCrumb[]>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/ancestry`
    ),

  // Process inventory
  listProcesses: (projectId: UUID) =>
    request<Process[]>(`/api/v2/projects/${projectId}/processes`),
  createProcess: (projectId: UUID, body: { name: string; description?: string }) =>
    request<Process>(`/api/v2/projects/${projectId}/processes`, {
      method: "POST",
      json: body,
    }),
  updateProcess: (
    projectId: UUID,
    processId: UUID,
    body: { name?: string; description?: string; order_index?: number; status?: string }
  ) =>
    request<Process>(`/api/v2/projects/${projectId}/processes/${processId}`, {
      method: "PATCH",
      json: body,
    }),
  deleteProcess: (projectId: UUID, processId: UUID) =>
    request<void>(`/api/v2/projects/${projectId}/processes/${processId}`, {
      method: "DELETE",
    }),
  assignClaims: (projectId: UUID, processId: UUID, claimIds: UUID[]) =>
    request<{ process_id: UUID; linked: number; already_linked: number }>(
      `/api/v2/projects/${projectId}/processes/${processId}/claims`,
      { method: "POST", json: { claim_ids: claimIds } }
    ),
  unassignClaims: (projectId: UUID, processId: UUID, claimIds: UUID[]) =>
    request<{ process_id: UUID; removed: number }>(
      `/api/v2/projects/${projectId}/processes/${processId}/claims`,
      { method: "DELETE", json: { claim_ids: claimIds } }
    ),
  suggestClaimsForProcess: (projectId: UUID, processId: UUID) =>
    request<SuggestClaimsResult>(
      `/api/v2/projects/${projectId}/processes/${processId}/suggest-claims`,
      { method: "POST", json: {} }
    ),
  listUnassignedClaims: (projectId: UUID) =>
    request<TriageClaim[]>(`/api/v2/projects/${projectId}/claims/unassigned`),

  // AI suggestions
  suggestProcesses: (projectId: UUID, body: { scope_input_ids?: UUID[] | null } = {}) =>
    request<SuggestBatchResult>(`/api/v2/projects/${projectId}/suggest-processes`, {
      method: "POST",
      json: body,
    }),
  listSuggestions: (
    projectId: UUID,
    params: { status?: string; kind?: string } = {}
  ) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.kind) qs.set("kind", params.kind);
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<ProcessSuggestion[]>(
      `/api/v2/projects/${projectId}/process-suggestions${suffix}`
    );
  },
  acceptSuggestion: (projectId: UUID, suggestionId: UUID) =>
    request<AcceptSuggestionResult>(
      `/api/v2/projects/${projectId}/process-suggestions/${suggestionId}/accept`,
      { method: "POST" }
    ),
  rejectSuggestion: (projectId: UUID, suggestionId: UUID) =>
    request<AcceptSuggestionResult>(
      `/api/v2/projects/${projectId}/process-suggestions/${suggestionId}/reject`,
      { method: "POST" }
    ),
  acceptSuggestionBatch: (projectId: UUID, batchId: UUID) =>
    request<BatchAcceptResult>(
      `/api/v2/projects/${projectId}/process-suggestion-batches/${batchId}/accept`,
      { method: "POST" }
    ),

  // Map ↔ process wiring
  attachMapToProcess: (projectId: UUID, modelId: UUID, processId: UUID | null) =>
    request<ProcessModel>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}`,
      { method: "PATCH", json: { process_id: processId } }
    ),

  // Change history
  getNodeHistory: (projectId: UUID, nodeId: UUID) =>
    request<ChangeEvent[]>(
      `/api/v2/projects/${projectId}/nodes/${nodeId}/history`
    ),
  getEdgeHistory: (projectId: UUID, edgeId: UUID) =>
    request<ChangeEvent[]>(
      `/api/v2/projects/${projectId}/edges/${edgeId}/history`
    ),
  getChangeLog: (
    projectId: UUID,
    modelId: UUID,
    params: {
      target_id?: UUID;
      actor_kind?: string;
      source?: string;
      since?: string;
      cursor?: string;
      limit?: number;
    } = {}
  ) => {
    const qs = new URLSearchParams();
    if (params.target_id !== undefined) qs.set("target_id", params.target_id);
    if (params.actor_kind !== undefined) qs.set("actor_kind", params.actor_kind);
    if (params.source !== undefined) qs.set("source", params.source);
    if (params.since !== undefined) qs.set("since", params.since);
    if (params.cursor !== undefined) qs.set("cursor", params.cursor);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<ChangeLogPage>(
      `/api/v2/projects/${projectId}/models/${modelId}/log${suffix}`
    );
  },
};
