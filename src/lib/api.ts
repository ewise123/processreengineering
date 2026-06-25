import type {
  AcceptDetectionRunResult,
  AiEditAction,
  AiEditResponse,
  AiProposedStepRequest,
  AiProposedStepResult,
  ChatRequest,
  ChatResponse,
  ChatSuggestRequest,
  ChatSuggestResponse,
  Claim,
  ClaimConflict,
  ClaimExtractionResult,
  ConflictDetectionResult,
  DetectProcessesRequest,
  DetectionRunDetail,
  DetectionRunListRow,
  EmbedResult,
  InputParseResult,
  InputRow,
  EdgeCreate,
  EdgeUpdate,
  LaneCreate,
  LaneUpdate,
  NodeCitations,
  NodeCreate,
  NodeIssue,
  NodeIssuesDetail,
  NodeReview,
  NodeReviewUpdate,
  NodeUpdate,
  ProcessEdge,
  Page,
  ProcessGraph,
  ProcessLane,
  ProcessMapGenerateRequest,
  ProcessMapGenerateResult,
  ProcessModel,
  ProcessNode,
  ProcessSegment,
  ProcessVersion,
  Project,
  ProjectCreate,
  ProjectUpdate,
  ReviewState,
  UUID,
  VersionDiff,
  VersionSummary,
} from "@/lib/types";

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
    let detail = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { detail?: string };
      if (data.detail) detail = data.detail;
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

  // Process maps
  listProcessMaps: (projectId: UUID) =>
    request<ProcessModel[]>(`/api/v2/projects/${projectId}/process-maps`),
  generateProcessMap: (projectId: UUID, payload: ProcessMapGenerateRequest) =>
    request<ProcessMapGenerateResult>(
      `/api/v2/projects/${projectId}/generate-process-map`,
      { method: "POST", json: payload }
    ),
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
  deleteNode: (projectId: UUID, nodeId: UUID) =>
    request<void>(`/api/v2/projects/${projectId}/nodes/${nodeId}`, {
      method: "DELETE",
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
  deleteEdge: (projectId: UUID, edgeId: UUID) =>
    request<void>(`/api/v2/projects/${projectId}/edges/${edgeId}`, {
      method: "DELETE",
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
  deleteLane: (projectId: UUID, laneId: UUID) =>
    request<void>(`/api/v2/projects/${projectId}/lanes/${laneId}`, {
      method: "DELETE",
    }),
  getNodeCitations: (projectId: UUID, nodeId: UUID) =>
    request<NodeCitations>(
      `/api/v2/projects/${projectId}/nodes/${nodeId}/citations`
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

  // Process detection
  detectProcesses: (projectId: UUID, body: DetectProcessesRequest = {}) =>
    request<DetectionRunDetail>(
      `/api/v2/projects/${projectId}/detect-processes`,
      { method: "POST", json: body }
    ),
  listDetectionRuns: (projectId: UUID) =>
    request<DetectionRunListRow[]>(
      `/api/v2/projects/${projectId}/detection-runs`
    ),
  getDetectionRun: (projectId: UUID, runId: UUID) =>
    request<DetectionRunDetail>(
      `/api/v2/projects/${projectId}/detection-runs/${runId}`
    ),
  updateSegment: (
    projectId: UUID,
    segmentId: UUID,
    body: { name?: string | null; description?: string | null }
  ) =>
    request<ProcessSegment>(
      `/api/v2/projects/${projectId}/segments/${segmentId}`,
      { method: "PATCH", json: body }
    ),
  createSegment: (
    projectId: UUID,
    runId: UUID,
    body: { name: string }
  ) =>
    request<ProcessSegment>(
      `/api/v2/projects/${projectId}/detection-runs/${runId}/segments`,
      { method: "POST", json: body }
    ),
  mergeSegment: (
    projectId: UUID,
    segmentId: UUID,
    body: { into_segment_id: UUID }
  ) =>
    request<ProcessSegment>(
      `/api/v2/projects/${projectId}/segments/${segmentId}/merge`,
      { method: "POST", json: body }
    ),
  deleteSegment: (projectId: UUID, segmentId: UUID) =>
    request<void>(
      `/api/v2/projects/${projectId}/segments/${segmentId}`,
      { method: "DELETE" }
    ),
  moveClaimToSegment: (
    projectId: UUID,
    segmentId: UUID,
    body: { claim_id: UUID }
  ) =>
    request<ProcessSegment>(
      `/api/v2/projects/${projectId}/segments/${segmentId}/claims`,
      { method: "POST", json: body }
    ),
  acceptDetectionRun: (projectId: UUID, runId: UUID) =>
    request<AcceptDetectionRunResult>(
      `/api/v2/projects/${projectId}/detection-runs/${runId}/accept`,
      { method: "POST" }
    ),
  discardDetectionRun: (projectId: UUID, runId: UUID) =>
    request<void>(
      `/api/v2/projects/${projectId}/detection-runs/${runId}`,
      { method: "DELETE" }
    ),
};
