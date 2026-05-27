import type { ReactNode } from "react";

export default function CanvasLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#fafbfc" }}>
      {children}
    </div>
  );
}
