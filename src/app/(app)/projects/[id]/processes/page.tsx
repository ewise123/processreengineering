"use client";

import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ProcessList } from "@/components/inventory/process-list";
import { ClaimTriagePanel } from "@/components/inventory/claim-triage-panel";
import { SuggestionInbox } from "@/components/inventory/suggestion-inbox";
import { api } from "@/lib/api";

export default function ProcessesPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const processesQuery = useQuery({
    queryKey: ["processes", projectId],
    queryFn: () => api.listProcesses(projectId),
  });
  const unassignedQuery = useQuery({
    queryKey: ["unassigned", projectId],
    queryFn: () => api.listUnassignedClaims(projectId),
  });
  const suggestionsQuery = useQuery({
    queryKey: ["suggestions", projectId],
    queryFn: () => api.listSuggestions(projectId, { status: "pending" }),
  });

  const suggest = useMutation({
    mutationFn: () => api.suggestProcesses(projectId, {}),
    onSuccess: (res) => {
      toast.success(`AI proposed ${res.suggestion_count} process(es). Review below.`);
      qc.invalidateQueries({ queryKey: ["suggestions", projectId] });
    },
    onError: (e: Error) => toast.error(`Suggest failed: ${e.message}`),
  });

  if (processesQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (processesQuery.error) {
    return <p className="text-sm text-red-600">{(processesQuery.error as Error).message}</p>;
  }

  const processes = processesQuery.data ?? [];
  const unassigned = unassignedQuery.data ?? [];
  const suggestions = suggestionsQuery.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Your process inventory. Create processes top-down and curate claims into
          them, or let AI suggest processes from the claims and accept the ones you
          want. Maps are generated per process on the Maps tab.
        </p>
        <Button onClick={() => suggest.mutate()} disabled={suggest.isPending}>
          {suggest.isPending ? "Suggesting…" : "Suggest processes"}
        </Button>
      </div>

      {suggestions.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">AI suggestions</h2>
          <SuggestionInbox projectId={projectId} suggestions={suggestions} />
        </section>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_400px]">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Processes</h2>
          <ProcessList projectId={projectId} processes={processes} />
        </section>
        <aside>
          <ClaimTriagePanel projectId={projectId} processes={processes} claims={unassigned} />
        </aside>
      </div>
    </div>
  );
}
