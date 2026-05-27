"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GenerateMapForm } from "@/components/generate-map-form";
import { api } from "@/lib/api";

export default function MapsPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["maps", id],
    queryFn: () => api.listProcessMaps(id),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Generated process maps for this project. Each map can have multiple
          versions; clicking opens the latest.
        </p>
        <GenerateMapForm projectId={id} />
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {error && (
        <p className="text-sm text-red-600">{(error as Error).message}</p>
      )}

      {data && data.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No maps yet</CardTitle>
            <CardDescription>
              Extract claims from at least one document, then click Generate map.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {data && data.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.map((m) => {
            const targetHref = m.latest_version_id
              ? `/projects/${id}/maps/${m.id}/versions/${m.latest_version_id}`
              : `/projects/${id}/maps`;
            return (
              <Link key={m.id} href={targetHref} className="block">
                <Card className="h-full hover:border-primary transition">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="line-clamp-1">{m.name}</CardTitle>
                      <Badge variant="outline">{m.level}</Badge>
                    </div>
                    <CardDescription>
                      {m.latest_version_number
                        ? `v${m.latest_version_number} · `
                        : "no version yet · "}
                      created {new Date(m.created_at).toLocaleDateString()}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xs text-muted-foreground">
                      Click to open canvas.
                    </p>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
