"use client";

import { Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useAiEditNode } from "@/components/canvas/ai-edit-cache";
import { canDecompose } from "@/components/canvas/decompose-nav";
import type {
  AiEditAction,
  AiEditResponse,
  SubStep,
  SuggestedStep,
  UUID,
} from "@/lib/types";

const LOADING_LABELS: Record<AiEditAction, string> = {
  relabel: "Relabeling step…",
  describe: "Writing description…",
  validate: "Checking for gaps…",
  suggest_next: "Suggesting next steps…",
  decompose: "Decomposing into sub-steps…",
};

export function AiEditPanel({
  projectId,
  modelId,
  versionId,
  nodeId,
  level,
  childModelId,
  onRelabel,
  onDescribe,
  onAddStep,
  onDecompose,
  onOpenChild,
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  nodeId: UUID;
  level: string | null;
  childModelId: UUID | null;
  onRelabel: (name: string) => void;
  onDescribe: (description: string) => void;
  onAddStep: (step: SuggestedStep) => void;
  onDecompose: (subSteps: SubStep[]) => void;
  onOpenChild: (childModelId: UUID) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { entry, runAction, resolveStep, clear } = useAiEditNode(nodeId);

  const decomposeAllowed = canDecompose(level);

  function handleMenuAction(action: AiEditAction) {
    setMenuOpen(false);
    runAction({ projectId, modelId, versionId, action });
  }

  const baseActions: { action: AiEditAction; label: string }[] = [
    { action: "relabel", label: "Relabel step" },
    { action: "describe", label: "Describe step" },
    { action: "validate", label: "Validate completeness" },
    { action: "suggest_next", label: "Suggest next step" },
  ];

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-violet-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-violet-700"
      >
        <Sparkles size={11} />
        Ask AI to edit this step
      </button>

      {menuOpen && (
        <div role="menu" className="mt-1 rounded-md border border-slate-200 bg-white py-1 shadow">
          {baseActions.map((a) => (
            <button
              key={a.action}
              role="menuitem"
              type="button"
              onClick={() => handleMenuAction(a.action)}
              className="block w-full px-3 py-1.5 text-left text-[11px] text-slate-700 hover:bg-slate-50"
            >
              {a.label}
            </button>
          ))}
          {childModelId && (
            <button
              role="menuitem"
              type="button"
              onClick={() => { setMenuOpen(false); onOpenChild(childModelId); }}
              className="block w-full px-3 py-1.5 text-left text-[11px] font-semibold text-violet-700 hover:bg-slate-50"
            >
              Open sub-process
            </button>
          )}
          <button
            role="menuitem"
            type="button"
            disabled={!decomposeAllowed}
            title={decomposeAllowed ? undefined : "Already at the most detailed level (L4)"}
            onClick={() => decomposeAllowed && handleMenuAction("decompose")}
            className="block w-full px-3 py-1.5 text-left text-[11px] text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
          >
            {childModelId ? "Re-decompose (new version)" : "Decompose into sub-steps"}
          </button>
        </div>
      )}

      {entry.loading && <LoadingSkeleton action={entry.loadingAction} />}
      {entry.error && <p className="mt-2 text-[11px] text-rose-600">{entry.error}</p>}

      {entry.result && (
        <ProposalCards
          result={entry.result}
          pendingSteps={entry.pendingSteps}
          isReDecompose={!!childModelId}
          onRelabel={(name) => { onRelabel(name); clear(); }}
          onDescribe={(d) => { onDescribe(d); clear(); }}
          onResolveStep={(step, accept) => {
            if (accept) onAddStep(step);
            resolveStep(step);
          }}
          onDecompose={(subSteps) => { onDecompose(subSteps); clear(); }}
          onDismiss={clear}
        />
      )}
    </div>
  );
}

function ShimmerCard() {
  return (
    <div className="relative overflow-hidden rounded-md border border-slate-200 bg-slate-50/60 p-2">
      {/* Title bar */}
      <div aria-hidden className="h-2.5 w-3/4 rounded bg-slate-200" />
      {/* Rationale bar */}
      <div aria-hidden className="mt-1.5 h-2 w-1/2 rounded bg-slate-200" />
      {/* Chip row */}
      <div aria-hidden className="mt-2 flex gap-1">
        <div aria-hidden className="h-3 w-10 rounded bg-slate-200" />
        <div aria-hidden className="h-3 w-10 rounded bg-slate-200" />
        <div aria-hidden className="h-3 w-10 rounded bg-slate-200" />
      </div>
      {/* Sweeping shimmer overlay — starts off-screen left, sweeps to right */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-violet-200/60 to-transparent animate-[ai-shimmer_1.6s_ease-in-out_infinite] motion-reduce:hidden"
      />
    </div>
  );
}

function LoadingSkeleton({ action }: { action: AiEditAction | null }) {
  const label = action ? LOADING_LABELS[action] : "Asking Claude…";
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className="mt-2 space-y-2"
    >
      {/* Label row */}
      <div className="flex items-center gap-1">
        <Sparkles aria-hidden size={11} className="text-violet-600 animate-pulse motion-reduce:animate-none" />
        <span aria-hidden className="text-[11px] text-slate-500">{label}</span>
      </div>
      {/* Two skeleton proposal cards */}
      <ShimmerCard />
      <ShimmerCard />
    </div>
  );
}

function ClaimChips({ ids }: { ids: UUID[] }) {
  if (ids.length === 0) {
    return <span className="text-[10px] italic text-amber-700">no sourced claims — inference</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <span key={id} className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-mono text-slate-600">
          {id.slice(0, 8)}
        </span>
      ))}
    </div>
  );
}

function Card({
  title,
  rationale,
  citedIds,
  children,
}: {
  title: string;
  rationale: string;
  citedIds: UUID[];
  children?: ReactNode;
}) {
  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50/60 p-2">
      <p className="text-[11px] font-semibold text-slate-800">{title}</p>
      {rationale && <p className="mt-0.5 text-[10px] text-slate-500">{rationale}</p>}
      <div className="mt-1"><ClaimChips ids={citedIds} /></div>
      {children}
    </div>
  );
}

function AcceptReject({ onAccept, onReject }: { onAccept: () => void; onReject: () => void }) {
  return (
    <div className="mt-2 flex gap-1.5">
      <button
        type="button"
        onClick={onAccept}
        className="rounded bg-slate-800 px-2 py-1 text-[10px] font-semibold text-white"
      >
        Accept
      </button>
      <button
        type="button"
        onClick={onReject}
        className="rounded border border-slate-300 px-2 py-1 text-[10px] text-slate-600"
      >
        Reject
      </button>
    </div>
  );
}

function ProposalCards({
  result,
  pendingSteps,
  isReDecompose,
  onRelabel,
  onDescribe,
  onResolveStep,
  onDecompose,
  onDismiss,
}: {
  result: AiEditResponse;
  pendingSteps: SuggestedStep[] | null;
  isReDecompose: boolean;
  onRelabel: (name: string) => void;
  onDescribe: (description: string) => void;
  /** Called for suggest_next cards. accept=true → apply; accept=false → discard. */
  onResolveStep: (step: SuggestedStep, accept: boolean) => void;
  onDecompose: (subSteps: SubStep[]) => void;
  onDismiss: () => void;
}) {
  if (result.relabel) {
    const r = result.relabel;
    if (r.unchanged) {
      return (
        <Card title="Label already faithful" rationale={r.rationale} citedIds={r.cited_claim_ids} />
      );
    }
    return (
      <Card title={r.proposed_name} rationale={r.rationale} citedIds={r.cited_claim_ids}>
        <AcceptReject onAccept={() => onRelabel(r.proposed_name)} onReject={onDismiss} />
      </Card>
    );
  }
  if (result.describe) {
    const d = result.describe;
    return (
      <Card title={d.proposed_description} rationale={d.rationale} citedIds={d.cited_claim_ids}>
        <AcceptReject onAccept={() => onDescribe(d.proposed_description)} onReject={onDismiss} />
      </Card>
    );
  }
  if (result.validate) {
    const gaps = result.validate.gaps;
    if (gaps.length === 0) {
      return <p className="mt-2 text-[11px] text-emerald-700">No completeness gaps found.</p>;
    }
    return (
      <div>
        {gaps.map((g, i) => (
          <Card
            key={i}
            title={`${g.severity.toUpperCase()}: ${g.summary}`}
            rationale=""
            citedIds={g.cited_claim_ids}
          />
        ))}
      </div>
    );
  }
  if (result.suggest_next) {
    // Use pendingSteps (managed by AiEditCacheProvider) so accepting/rejecting
    // a card removes only that card; the last removal clears the entry entirely.
    // Fall back to result.suggest_next.steps only if pendingSteps hasn't been
    // populated yet (should not happen in practice).
    const steps = pendingSteps ?? result.suggest_next.steps;
    if (steps.length === 0) {
      return (
        <p className="mt-2 text-[11px] text-slate-500">
          The sources don&apos;t support a next step.
        </p>
      );
    }
    return (
      <div>
        {steps.map((s, i) => (
          <Card
            key={i}
            title={`${s.proposed_name} (${s.proposed_type})`}
            rationale={s.rationale}
            citedIds={s.cited_claim_ids}
          >
            <AcceptReject
              onAccept={() => onResolveStep(s, true)}
              onReject={() => onResolveStep(s, false)}
            />
          </Card>
        ))}
      </div>
    );
  }
  if (result.decompose) {
    const steps = result.decompose.sub_steps;
    if (steps.length === 0) {
      return (
        <p className="mt-2 text-[11px] text-slate-500">
          The sources don&apos;t support a breakdown of this step.
        </p>
      );
    }
    return (
      <div className="mt-2 rounded-md border border-slate-200 bg-slate-50/60 p-2">
        <p className="text-[11px] font-semibold text-slate-800">
          {steps.length} sub-step{steps.length > 1 ? "s" : ""}
        </p>
        {isReDecompose && (
          <p className="mt-0.5 text-[10px] text-amber-700">
            Creates a new version of the existing sub-process; the current version is kept in history.
          </p>
        )}
        <ol className="mt-1 list-decimal space-y-1 pl-4">
          {steps.map((s, i) => (
            <li key={i} className="text-[10px] text-slate-700">
              <span className="font-medium">{s.proposed_name}</span>
              <span className="text-slate-400"> · {s.proposed_type} · {s.role}</span>
              {s.cited_claim_ids.length === 0 && (
                <span className="ml-1 italic text-amber-700">(inference)</span>
              )}
            </li>
          ))}
        </ol>
        <AcceptReject onAccept={() => onDecompose(steps)} onReject={onDismiss} />
      </div>
    );
  }
  return null;
}
