"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { UUID } from "@/lib/types";

export function NewEmptyClusterButton({
  projectId,
  runId,
}: {
  projectId: UUID;
  runId: UUID;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: (n: string) =>
      api.createSegment(projectId, runId, { name: n }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-run", projectId, runId] });
      setName("");
    },
    onError: (e: Error) => toast.error(`Create failed: ${e.message}`),
  });

  return (
    <div className="flex items-center gap-2 pt-2">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name a new empty cluster"
        maxLength={300}
        className="max-w-xs"
      />
      <Button
        size="sm"
        disabled={!name.trim() || create.isPending}
        onClick={() => create.mutate(name.trim())}
      >
        + New empty cluster
      </Button>
    </div>
  );
}
