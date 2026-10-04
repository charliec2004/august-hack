import "server-only";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

/**
 * The single server-only Postgres client (spec section 40.6).
 * Always use parameterized SQL; every user-owned query takes the server-derived
 * user ID as an explicit parameter.
 */

declare global {
  var __augustPgPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const pool = new Pool({ connectionString, max: 10 });
  pool.on("error", (err) => {
    // Idle client errors must not crash the process; never log connection details.
    console.error("pg pool error:", err.message);
  });
  return pool;
}

/** Lazily-created Pool, reused across hot reloads in development. */
export function getPool(): Pool {
  if (!globalThis.__augustPgPool) {
    globalThis.__augustPgPool = createPool();
  }
  return globalThis.__augustPgPool;
}

export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
) {
  return getPool().query<R>(text, params);
}

/**
 * Runs `fn` inside a transaction on a dedicated client.
 * Commits on success, rolls back on any thrown error, and always releases the client.
 */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // Connection may already be broken; the original error is what matters.
    }
    throw err;
  } finally {
    client.release();
  }
}
