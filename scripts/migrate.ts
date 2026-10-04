/**
 * Minimal forward-only migration runner.
 *
 * Applies migrations/*.sql in lexical order, each inside its own transaction,
 * and records applied filenames (plus a content checksum) in schema_migrations.
 *
 * Usage: npm run db:migrate   (loads .env.local if present)
 * Env:   DATABASE_URL_UNPOOLED (preferred, direct connection) or DATABASE_URL
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

async function main() {
  const connectionString =
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");
  }

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const { rows } = await client.query<{ filename: string; checksum: string }>(
      "select filename, checksum from schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

    let count = 0;
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");

      const prior = applied.get(file);
      if (prior !== undefined) {
        if (prior !== checksum) {
          console.warn(
            `warning: ${file} changed since it was applied (checksum mismatch); not re-running`,
          );
        }
        continue;
      }

      console.log(`applying ${file}`);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          "insert into schema_migrations (filename, checksum) values ($1, $2)",
          [file, checksum],
        );
        await client.query("commit");
        count++;
      } catch (err) {
        await client.query("rollback");
        throw new Error(
          `migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    console.log(count === 0 ? "no pending migrations" : `applied ${count} migration(s)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
