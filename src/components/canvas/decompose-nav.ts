import type { AncestryCrumb, UUID } from "@/lib/types";

export interface BreadcrumbItem {
  modelId: UUID;
  label: string;
  level: string;
  current: boolean;
  /** Navigation target, or null when the map has no version to open. */
  href: string | null;
}

/**
 * Map an ancestry chain (root -> leaf) into renderable breadcrumb items.
 * Returns [] for a root map (a single-element chain) so single-level maps
 * render no breadcrumb. The last crumb is the current map.
 */
export function buildBreadcrumb(crumbs: AncestryCrumb[], projectId: UUID): BreadcrumbItem[] {
  if (crumbs.length <= 1) return [];
  return crumbs.map((c, i) => ({
    modelId: c.model_id,
    label: c.label,
    level: c.level,
    current: i === crumbs.length - 1,
    href: c.version_id ? `/projects/${projectId}/maps/${c.model_id}/versions/${c.version_id}` : null,
  }));
}

/** Decompose is offered only below the deepest level (L4). */
export function canDecompose(level: string | null | undefined): boolean {
  if (!level) return false;
  const n = parseInt(level.replace(/^L/i, ""), 10);
  return Number.isFinite(n) && n >= 1 && n < 4;
}
