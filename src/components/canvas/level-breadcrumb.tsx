"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";

import type { BreadcrumbItem } from "@/components/canvas/decompose-nav";

export function LevelBreadcrumb({ items }: { items: BreadcrumbItem[] }) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="Process levels"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "6px 12px",
        background: "rgba(255,255,255,0.96)",
        borderRadius: 8,
        border: "1px solid #e2e8f0",
        boxShadow: "0 8px 28px -8px rgba(15, 23, 42, 0.18)",
        fontSize: 12,
        maxWidth: 520,
        overflow: "hidden",
      }}
    >
      {items.map((it, i) => (
        <span key={it.modelId} style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          {i > 0 && <ChevronRight size={12} color="#94a3b8" />}
          {it.current || !it.href ? (
            <span
              title={`${it.level} · ${it.label}`}
              style={{
                fontWeight: it.current ? 600 : 500,
                color: it.current ? "#0f172a" : "#64748b",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 160,
              }}
            >
              {it.label}
            </span>
          ) : (
            <Link
              href={it.href}
              title={`${it.level} · ${it.label}`}
              style={{
                color: "#475569",
                textDecoration: "none",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 140,
              }}
            >
              {it.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
