"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "@/lib/api";

const TABS = [
  { slug: "", label: "Overview" },
  { slug: "documents", label: "Documents" },
  { slug: "claims", label: "Claims" },
  { slug: "conflicts", label: "Conflicts" },
] as const;

export default function ProjectLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const projectId = params.id;

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
    enabled: !!projectId,
  });

  const baseHref = `/projects/${projectId}`;
  const currentSlug = pathname.startsWith(baseHref)
    ? pathname.slice(baseHref.length).replace(/^\//, "").split("/")[0] ?? ""
    : "";

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          <Link href="/projects" className="hover:underline">
            Projects
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {project?.name ?? "Loading…"}
        </h1>
        {project?.client_name && (
          <p className="text-sm text-muted-foreground">{project.client_name}</p>
        )}
      </div>

      <nav className="flex gap-1 border-b">
        {TABS.map((tab) => {
          const isActive = currentSlug === tab.slug;
          const href = tab.slug ? `${baseHref}/${tab.slug}` : baseHref;
          return (
            <Link
              key={tab.slug || "overview"}
              href={href}
              className={`-mb-px border-b-2 px-4 py-2 text-sm transition ${
                isActive
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <div>{children}</div>
    </div>
  );
}
