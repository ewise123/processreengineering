import { redirect } from "next/navigation";

/**
 * The detection review UI moved onto the Processes tab. This legacy route
 * (and any bookmarks to it) redirects there. In Next.js 16, `params` is a
 * Promise and must be awaited.
 */
export default async function DetectRunRedirect({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id } = await params;
  redirect(`/projects/${id}/processes`);
}
