import { describe, expect, it } from "vitest";

import { buildBreadcrumb, canDecompose } from "./decompose-nav";
import type { AncestryCrumb } from "@/lib/types";

const crumbs: AncestryCrumb[] = [
  { model_id: "m1", version_id: "v1", level: "L2", label: "Order to cash" },
  { model_id: "m2", version_id: "v2", level: "L3", label: "Approve invoice" },
  { model_id: "m3", version_id: null, level: "L4", label: "Verify totals" },
];

describe("buildBreadcrumb", () => {
  it("marks the last crumb current and the rest navigable with hrefs", () => {
    const out = buildBreadcrumb(crumbs, "proj");
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      label: "Order to cash",
      current: false,
      href: "/projects/proj/maps/m1/versions/v1",
    });
    expect(out[2]).toMatchObject({ label: "Verify totals", current: true });
    // a crumb with no latest version is not navigable
    expect(out[2].href).toBeNull();
  });

  it("returns an empty array for a single-element (root) chain", () => {
    expect(buildBreadcrumb([crumbs[0]], "proj")).toEqual([]);
  });
});

describe("canDecompose", () => {
  it("is true below L4 and false at L4", () => {
    expect(canDecompose("L1")).toBe(true);
    expect(canDecompose("L3")).toBe(true);
    expect(canDecompose("L4")).toBe(false);
    expect(canDecompose(null)).toBe(false);   // unknown level -> safe default
  });
});
