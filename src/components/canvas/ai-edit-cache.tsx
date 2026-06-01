"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

import { api } from "@/lib/api";
import type { AiEditAction, AiEditResponse, SuggestedStep, UUID } from "@/lib/types";

export interface AiEditEntry {
  activeAction: AiEditAction | null;
  loading: boolean;
  result: AiEditResponse | null;
  error: string | null;
  /** For suggest_next: steps not yet accepted/rejected. null outside suggest_next flow. */
  pendingSteps: SuggestedStep[] | null;
}

const EMPTY: AiEditEntry = {
  activeAction: null,
  loading: false,
  result: null,
  error: null,
  pendingSteps: null,
};

interface RunActionArgs {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  nodeId: UUID;
  action: AiEditAction;
}

interface Ctx {
  getEntry: (nodeId: UUID) => AiEditEntry;
  runAction: (args: RunActionArgs) => void;
  /** Remove one suggest_next step; clears the entry when none remain. */
  resolveStep: (nodeId: UUID, step: SuggestedStep) => void;
  /** Reset a node's entry (used for accept/reject of single-card variants). */
  clear: (nodeId: UUID) => void;
}

const AiEditCacheContext = createContext<Ctx | null>(null);

export function AiEditCacheProvider({ children }: { children: ReactNode }) {
  const [byNode, setByNode] = useState<Record<string, AiEditEntry>>({});

  const patch = useCallback((nodeId: UUID, p: Partial<AiEditEntry>) => {
    setByNode((m) => ({ ...m, [nodeId]: { ...(m[nodeId] ?? EMPTY), ...p } }));
  }, []);

  const runAction = useCallback(
    async ({ projectId, modelId, versionId, nodeId, action }: RunActionArgs) => {
      patch(nodeId, {
        activeAction: action,
        loading: true,
        result: null,
        error: null,
        pendingSteps: null,
      });
      try {
        const res = await api.aiEditNode(projectId, modelId, versionId, nodeId, action);
        patch(nodeId, {
          loading: false,
          result: res,
          pendingSteps: res.suggest_next ? res.suggest_next.steps : null,
        });
      } catch (e) {
        patch(nodeId, { loading: false, error: (e as Error).message });
      }
    },
    [patch]
  );

  const resolveStep = useCallback((nodeId: UUID, step: SuggestedStep) => {
    setByNode((m) => {
      const entry = m[nodeId] ?? EMPTY;
      const remaining = (entry.pendingSteps ?? []).filter((s) => s !== step);
      if (remaining.length === 0) return { ...m, [nodeId]: EMPTY };
      return { ...m, [nodeId]: { ...entry, pendingSteps: remaining } };
    });
  }, []);

  const clear = useCallback((nodeId: UUID) => {
    setByNode((m) => ({ ...m, [nodeId]: EMPTY }));
  }, []);

  // getEntry is defined inline on the value object so it always closes over the
  // current byNode snapshot rather than a stale copy captured at mount time.
  const value: Ctx = {
    getEntry: (nodeId: UUID) => byNode[nodeId] ?? EMPTY,
    runAction,
    resolveStep,
    clear,
  };

  return (
    <AiEditCacheContext.Provider value={value}>
      {children}
    </AiEditCacheContext.Provider>
  );
}

export function useAiEditNode(nodeId: UUID) {
  const ctx = useContext(AiEditCacheContext);
  if (!ctx) throw new Error("useAiEditNode must be used within AiEditCacheProvider");
  return {
    entry: ctx.getEntry(nodeId),
    runAction: (args: { projectId: UUID; modelId: UUID; versionId: UUID; action: AiEditAction }) =>
      ctx.runAction({ ...args, nodeId }),
    resolveStep: (step: SuggestedStep) => ctx.resolveStep(nodeId, step),
    clear: () => ctx.clear(nodeId),
  };
}
