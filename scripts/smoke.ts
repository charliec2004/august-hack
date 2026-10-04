/**
 * npm run smoke — environment presence, database connectivity, migrations,
 * AI Gateway call, then the provider smokes. Non-destructive unless
 * SMOKE_LIVE_EFFECTS=true. Never prints secret values.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { Client } from "pg";

type Row = { check: string; ok: boolean | "skip"; detail: string };
const rows: Row[] = [];
const add = (check: string, ok: Row["ok"], detail = "") => rows.push({ check, ok, detail });

const REQUIRED = [
  "DATABASE_URL",
  "EXA_API_KEY",
  "KERNEL_API_KEY",
  "EXECUTOR_MCP_URL",
  "EXECUTOR_MCP_TOKEN",
  "AGENTMAIL_API_KEY",
  "AGENTMAIL_INBOX_ID",
  "SPRITES_TOKEN",
  "AWS_ENDPOINT_URL_S3",
];
const missing = REQUIRED.filter((k) => !process.env[k]);
add("env: required vars present", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : "");
add(
  "env: AI Gateway configured",
  Boolean(process.env.NEON_AI_GATEWAY_BASE_URL && process.env.NEON_AI_GATEWAY_TOKEN),
  "needs paid Neon plan (DECISIONS D2)",
);

const db = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL });
try {
  await db.connect();
  await db.query("select 1");
  add("db: connect", true);
  const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
  const { rows: applied } = await db.query<{ filename: string }>("select filename from schema_migrations");
  const pending = files.filter((f) => !applied.some((a) => a.filename === f));
  add("db: migrations applied", pending.length === 0, pending.length ? `pending ${pending.join(", ")}` : `${files.length} applied`);
} catch (e) {
  add("db: connect", false, (e as Error).message.slice(0, 120));
} finally {
  await db.end().catch(() => {});
}

if (process.env.NEON_AI_GATEWAY_BASE_URL && process.env.NEON_AI_GATEWAY_TOKEN) {
  try {
    const res = await fetch(`${process.env.NEON_AI_GATEWAY_BASE_URL.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.NEON_AI_GATEWAY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.REVIEW_MODEL || "gpt-5-6-luna",
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    add("ai gateway: chat completion", res.ok, `HTTP ${res.status}`);
  } catch (e) {
    add("ai gateway: chat completion", false, (e as Error).message.slice(0, 120));
  }
} else {
  add("ai gateway: chat completion", "skip", "not configured");
}

for (const script of ["smoke:providers", "smoke:sprites"]) {
  const r = spawnSync("npm", ["run", "-s", script], { encoding: "utf8", env: process.env, timeout: 240_000 });
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-1)[0] ?? "";
  add(`provider: ${script}`, r.status === 0 ? true : r.status === 2 ? "skip" : false, tail.slice(0, 140));
}

const mark = (ok: Row["ok"]) => (ok === true ? "PASS" : ok === "skip" ? "SKIP" : "FAIL");
for (const r of rows) console.log(`${mark(r.ok)}  ${r.check}${r.detail ? `  (${r.detail})` : ""}`);
process.exit(rows.some((r) => r.ok === false) ? 1 : 0);
