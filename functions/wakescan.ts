/**
 * Scheduled by a Neon Function Trigger (every minute). Delegates to the app's
 * wake scanner, which claims due wakes exactly once and resumes them.
 */
export default async function wakescan(req: Request): Promise<Response> {
  if (!req.headers.get("x-neon-trigger-invocation-id")) return new Response("forbidden", { status: 403 });
  const res = await fetch(`${process.env.APP_BASE_URL}/api/internal/wake-scan`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  return new Response(await res.text(), { status: res.status });
}
