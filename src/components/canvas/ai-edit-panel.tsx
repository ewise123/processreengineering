"use client";

import { Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";

import { api } from "@/lib/api";
import type {
  AiEditAction,
  AiEditResponse,
  SuggestedStep,
  UUID,
} from "@/lib/types";

const ACTIONS: { action: AiEditAction; label: string }[] = [
  { action: "relabel", label: "Relabel step" },
  { action: "describe", label: "Describe step" },
  { action: "validate", label: "Validate completeness" },
  { action: "suggest_next", label: "Suggest next step" },
];

export function AiEditPanel({
  projectId,
  modelId,
  versionId,
  nodeId,
  onRelabel,
  onDescribe,
  onAddStep,
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  nodeId: UUID;
  onRelabel: (name: string) => void;
  onDescribe: (description: string) => void;
  onAddStep: (step: SuggestedStep) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState<AiEditAction | null>(null);
  const [result, setResult] = useState<AiEditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Tracks the subset of suggest_next steps the user hasn't acted on yet.
  // null means we're not in a suggest_next flow; an empty array means all steps
  // have been resolved (triggers result clear).
  const [pendingSteps, setPendingSteps] = useState<SuggestedStep[] | null>(null);

  async function run(action: AiEditAction) {
    setMenuOpen(false);
    setResult(null);
    setPendingSteps(null);
    setError(null);
    setLoading(action);
    try {
      const res = await api.aiEditNode(projectId, modelId, versionId, nodeId, action);
      setResult(res);
      if (res.suggest_next) {
        setPendingSteps(res.suggest_next.steps);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  }

  function resolveStep(step: SuggestedStep, accept: boolean) {
    if (accept) {
      onAddStep(step);
    }
    setPendingSteps((prev) => {
      if (prev === null) return null;
      const next = prev.filter((s) => s !== step);
      if (next.length === 0) {
        // All steps resolved — schedule result clear outside this updater.
        // Use setTimeout(0) to avoid calling setResult inside a setState call.
        setTimeout(() => setResult(null), 0);
      }
      return next;
    });
  }

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
          {ACTIONS.map((a) => (
            <button
              key={a.action}
              role="menuitem"
              type="button"
              onClick={() => run(a.action)}
              className="block w-full px-3 py-1.5 text-left text-[11px] text-slate-700 hover:bg-slate-50"
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <p className="mt-2 text-[11px] text-slate-500">Asking Claude…</p>
      )}
      {error && (
        <p className="mt-2 text-[11px] text-rose-600">{error}</p>
      )}

      {result && (
        <ProposalCards
          result={result}
          pendingSteps={pendingSteps}
          onRelabel={(name) => { onRelabel(name); setResult(null); }}
          onDescribe={(d) => { onDescribe(d); setResult(null); }}
          onResolveStep={resolveStep}
          onDismiss={() => setResult(null)}
        />
      )}
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
  onRelabel,
  onDescribe,
  onResolveStep,
  onDismiss,
}: {
  result: AiEditResponse;
  pendingSteps: SuggestedStep[] | null;
  onRelabel: (name: string) => void;
  onDescribe: (description: string) => void;
  /** Called for suggest_next cards. accept=true → apply; accept=false → discard. */
  onResolveStep: (step: SuggestedStep, accept: boolean) => void;
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
    // Use pendingSteps (managed by AiEditPanel) so accepting/rejecting a card
    // removes only that card; the last removal closes the panel entirely.
    // Fall back to result.suggest_next.steps only if pendingSteps hasn't been
    // wired up yet (should never happen in practice).
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
  return null;
}
