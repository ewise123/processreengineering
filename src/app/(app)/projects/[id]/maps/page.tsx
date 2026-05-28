"use client";

import Link from "next/link";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GenerateMapForm } from "@/components/generate-map-form";
import { PostAcceptPanel } from "@/components/detect/post-accept-panel";
import { api } from "@/lib/api";

export default function MapsPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["maps", id],
    queryFn: () => api.listProcessMaps(id),
  });

  const params = useSearchParams();
  const router = useRouter();
  const postAcceptRun = params.get("postAcceptRun");

  const dismissPanel = () => {
    const sp = new URLSearchParams(params.toString());
    sp.delete("postAcceptRun");
    router.replace(`/projects/${id}/maps${sp.toString() ? `?${sp}` : ""}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Generated process maps for this project. Each map can have multiple
          versions; clicking opens the latest.
        </p>
        <GenerateMapForm projectId={id} />
      </div>

      {postAcceptRun && (
        <PostAcceptPanel
          projectId={id}
          runId={postAcceptRun}
          onDismiss={dismissPanel}
        />
      )}

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
              Find the processes in your documents — open the Processes tab and
              click Detect processes. You can also generate a single map
              directly with the button above.
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
                      <div className="flex items-center gap-1">
                        <Badge variant="outline">{m.level}</Badge>
                        {m.latest_source_run_status === "superseded" && (
                          <Badge
                            variant="secondary"
                            title="Generated from a detection run that has since been superseded."
                          >
                            stale
                          </Badge>
                        )}
                      </div>
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
