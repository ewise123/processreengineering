import type { Metadata } from "next";
import { Agentation } from "agentation";
import { Toaster } from "@/components/ui/sonner";
import { QueryProvider } from "@/lib/query-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "POET",
  description: "Process Reengineering Agent — extract claims, detect conflicts, generate process maps with full provenance.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full bg-background text-foreground antialiased">
        <QueryProvider>{children}</QueryProvider>
        <Toaster richColors position="top-right" />
        {process.env.NODE_ENV === "development" && <Agentation />}
      </body>
    </html>
  );
}
