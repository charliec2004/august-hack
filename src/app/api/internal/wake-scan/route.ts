import { processDueWakes, repairStranded } from "@/server/orchestration/wakes";

export const maxDuration = 300;

/**
 * Backend wake scanner (spec 16). Called by the scheduled trigger with
 * Authorization: Bearer $CRON_SECRET. Claims due wakes exactly once.
 */
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const repaired = await repairStranded();
  const results = await processDueWakes({ limit: 5 });
  return Response.json({ repaired, results });
}

export const GET = handle;
export const POST = handle;
