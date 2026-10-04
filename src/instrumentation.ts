/**
 * Local/long-running-server wake scanner. In deployment the scheduled trigger
 * calls /api/internal/wake-scan instead; both use the same transactional claim,
 * so running both at once is safe (a wake is claimed exactly once).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if ((process.env.WAKE_SCANNER ?? (process.env.VERCEL ? "off" : "inprocess")) !== "inprocess") return;
  const { processDueWakes, repairStranded } = await import("@/server/orchestration/wakes");
  const g = globalThis as { __augustScanner?: NodeJS.Timeout };
  if (g.__augustScanner) return;
  let busy = false;
  g.__augustScanner = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await repairStranded();
      await processDueWakes({ limit: 3 });
    } catch (e) {
      console.error("[wake-scanner]", (e as Error).message);
    } finally {
      busy = false;
    }
  }, 20_000);
}
