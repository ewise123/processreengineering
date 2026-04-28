"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";

export default function ProjectsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects({ limit: 100 }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Workspaces for process reengineering engagements.
          </p>
        </div>
        <Button asChild>
          <Link href="/projects/new">New project</Link>
        </Button>
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading projects…</p>
      )}
      {error && (
        <p className="text-sm text-red-600">
          Failed to load: {(error as Error).message}
        </p>
      )}
      {data && data.items.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No projects yet</CardTitle>
            <CardDescription>
              Create a project to start uploading documents and generating maps.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/projects/new">Create your first project</Link>
            </Button>
          </CardContent>
        </Card>
      )}
      {data && data.items.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.items.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className="block transition hover:translate-y-[-1px]"
            >
              <Card className="h-full hover:border-primary">
                <CardHeader>
                  <CardTitle className="line-clamp-1">{p.name}</CardTitle>
                  <CardDescription className="line-clamp-1">
                    {p.client_name ?? "—"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {p.description ?? "No description."}
                  </p>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Created {new Date(p.created_at).toLocaleDateString()}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
