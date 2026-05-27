"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";

export default function ProjectOverviewPage() {
  const { id } = useParams<{ id: string }>();
  const { data: project } = useQuery({
    queryKey: ["project", id],
    queryFn: () => api.getProject(id),
  });
  const { data: inputs } = useQuery({
    queryKey: ["inputs", id],
    queryFn: () => api.listInputs(id, { limit: 1 }),
  });
  const { data: claims } = useQuery({
    queryKey: ["claims", id],
    queryFn: () => api.listClaims(id, { limit: 1 }),
  });
  const { data: conflicts } = useQuery({
    queryKey: ["conflicts", id],
    queryFn: () => api.listConflicts(id, { limit: 1 }),
  });

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Stat label="Documents" value={inputs?.total} />
      <Stat label="Claims" value={claims?.total} />
      <Stat label="Conflicts" value={conflicts?.total} />
      <Stat label="Status" value={project?.status ?? "—"} />
      <Card className="md:col-span-2 lg:col-span-4">
        <CardHeader>
          <CardTitle>Description</CardTitle>
          <CardDescription>
            {project
              ? `Created ${new Date(project.created_at).toLocaleString()}`
              : "—"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-wrap text-sm">
            {project?.description?.trim() || "No description."}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string | undefined }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold tabular-nums">
          {value === undefined ? "—" : value}
        </p>
      </CardContent>
    </Card>
  );
}
