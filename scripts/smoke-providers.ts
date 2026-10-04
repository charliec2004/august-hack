/**
 * Non-destructive provider smoke test.
 *
 *   npm run smoke:providers
 *   SMOKE_LIVE_EFFECTS=true npm run smoke:providers   # also sends one real email
 *
 * Prints only redacted summaries (counts, ids, hosts). Never prints secrets.
 */
import { randomUUID } from "node:crypto";

import { getPool, query } from "@/server/db/client";
import type { AuthorizedEffect } from "@/server/effects/types";
import { mailFindSent, mailInboxStatus, mailPrepareSend, mailSendAuthorized } from "@/server/providers/agentmail";
import { researchWeb } from "@/server/providers/exa";
import { calendarFreeBusy, closeExecutor, executorRead, executorSkills } from "@/server/providers/executor";
import { browserRead } from "@/server/providers/kernel";

type Status = "PASS" | "WARN" | "FAIL" | "SKIP";
const results: Array<{ name: string; status: Status; note: string }> = [];

function report(name: string, status: Status, note: string) {
  results.push({ name, status, note });
  console.log(`[${status}] ${name}: ${note}`);
}

async function check(name: string, fn: () => Promise<[Status, string]>) {
  const t0 = Date.now();
  try {
    const [status, note] = await fn();
    report(name, status, `${note} (${Date.now() - t0}ms)`);
  } catch (err) {
    report(name, "FAIL", `threw: ${String((err as Error).message ?? err).slice(0, 200)}`);
  }
}

const hostOnly = (u: string | null | undefined) => {
  if (!u) return "none";
  try {
    return `${new URL(u).host}/…`;
  } catch {
    return "unparseable";
  }
};

async function main() {
  const { rows } = await query<{ id: string }>(
    `insert into app_users (auth_subject) values ('demo-user')
     on conflict (auth_subject) do update set auth_subject = excluded.auth_subject
     returning id`,
  );
  const userId = rows[0].id;
  console.log(`demo user ready (${userId.slice(0, 8)}…)`);

  await check("exa.researchWeb", async () => {
    const r = await researchWeb({ userId, responsibilityId: null, query: "best ramen restaurants in San Francisco", numResults: 3 });
    if (r.status !== "succeeded" || !r.data?.results.length) return ["FAIL", r.safeSummary];
    const maxLen = Math.max(...r.data.results.map((x) => x.highlights.length));
    return ["PASS", `${r.data.results.length} results, ${r.evidenceRefs.length} evidence rows, max highlight ${maxLen} chars, first host ${hostOnly(r.data.results[0].url)}`];
  });

  await check("executor.connect+skills", async () => {
    const catalog = await executorSkills();
    return catalog.includes("execute") ? ["PASS", "skills catalog lists `execute`"] : ["FAIL", "unexpected skills catalog"];
  });

  await check("executor.read(connections)", async () => {
    const r = await executorRead({
      userId,
      responsibilityId: null,
      activityText: "Checked your connected apps",
      program: `const c = await tools.executor.coreTools.connections.list({});
return c.ok ? c.data.connections.map((x) => ({ integration: x.integration, name: x.name })) : c;`,
    });
    if (r.status !== "succeeded") return ["FAIL", r.safeSummary];
    const leaked = /ya29\.|Bearer |refresh_token|access_token/i.test(r.data?.text ?? "");
    return [leaked ? "FAIL" : "PASS", `${r.data?.text.slice(0, 120)}${leaked ? " (CREDENTIAL-LIKE CONTENT!)" : ""}`];
  });

  await check("executor.calendarFreeBusy", async () => {
    const r = await calendarFreeBusy({ userId, responsibilityId: null, timezone: "America/Los_Angeles" });
    if (r.status === "succeeded") {
      const leaked = /ya29\.|Bearer |token/i.test(JSON.stringify(r.data));
      return [leaked ? "FAIL" : "PASS", `${r.data?.events.length} events, ${r.data?.freeWindows.length} free windows${leaked ? " (CREDENTIAL-LIKE CONTENT!)" : ""}`];
    }
    if (r.safeSummary.startsWith("executor_connection_rejected")) {
      return ["WARN", `external: ${r.safeSummary.slice(0, 160)}`];
    }
    return ["FAIL", r.safeSummary];
  });

  await check("kernel.browserRead(example.com)", async () => {
    let liveView: string | null = null;
    const r = await browserRead({
      userId,
      responsibilityId: null,
      url: "https://example.com",
      instruction: "what is this domain for",
      onLiveView: (u) => {
        liveView = u;
      },
    });
    if (r.status !== "succeeded") return ["FAIL", r.safeSummary];
    return ["PASS", `title "${r.data?.title}", ${r.data?.text.length} chars, live view ${hostOnly(liveView)}, session deleted in finally`];
  });

  await check("agentmail.inbox", async () => {
    const s = await mailInboxStatus();
    return ["PASS", `inbox ${s.inboxId}, ${s.recentThreads} recent thread(s)`];
  });

  if (process.env.SMOKE_LIVE_EFFECTS === "true") {
    await check("agentmail.send (LIVE)", async () => {
      const since = new Date(Date.now() - 60_000);
      const subject = `August smoke test ${new Date().toISOString()}`;
      const draft = mailPrepareSend({
        to: "charlieconner04@gmail.com",
        subject,
        text: "This is an automated smoke test from August. No action needed.",
      });
      const effect: AuthorizedEffect = {
        id: randomUUID(),
        userId,
        responsibilityId: null as unknown as string,
        provider: draft.provider,
        action: draft.action,
        effectClass: "consequential",
        canonicalArgs: draft.args,
        materialFacts: draft.materialFacts,
        proposalHash: "smoke",
        idempotencyKey: `smoke-${randomUUID()}`,
      };
      const d = await mailSendAuthorized(effect);
      if (d.outcome !== "succeeded") return ["FAIL", d.safeSummary];
      const rb = await mailFindSent({ userId, responsibilityId: null, to: "charlieconner04@gmail.com", subject, since });
      return ["PASS", `sent ${d.providerReceiptRef ? "message id received" : "?"}; ${d.safeSummary.replace(/thread \S+/, "thread <id>")}; readback found=${rb.data?.found ?? "error"}`];
    });
  } else {
    report("agentmail.send (LIVE)", "SKIP", "set SMOKE_LIVE_EFFECTS=true to send a real email");
  }
}

main()
  .catch((err) => {
    report("setup", "FAIL", String((err as Error).message ?? err).slice(0, 200));
  })
  .finally(async () => {
    await closeExecutor().catch(() => {});
    await getPool().end().catch(() => {});
    const failed = results.filter((r) => r.status === "FAIL");
    console.log(`\n${results.length - failed.length}/${results.length} non-failing; ${failed.length} failed.`);
    process.exit(failed.length ? 1 : 0);
  });
