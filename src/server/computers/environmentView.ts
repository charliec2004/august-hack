import "server-only";

import { query } from "../db/client";
import { listToolCredentials } from "../credentials/store";
import { getActiveEnvironment } from "./environment";

/**
 * What the Worker sees from computer_environment: persistent tools (on every
 * Computer, with login status as a boolean only) kept apart from this
 * Computer's task-only installs, plus promotion hints.
 */

export const PROMOTION_MIN_TASKS = 2;

export type EnvironmentView = {
  generation: number;
  persistentTools: {
    toolKey: string;
    packageName: string;
    packageVersion: string;
    login?: { kind: "env" | "file"; configured: boolean };
  }[];
  thisComputerOnly: { localInstalls: string[]; note: string };
  suggestions: string[];
};

export async function environmentView(args: {
  userId: string;
  workerSessionId: string | null;
}): Promise<EnvironmentView> {
  const [env, creds] = await Promise.all([getActiveEnvironment(args.userId), listToolCredentials(args.userId)]);
  const configured = new Set(creds.map((c) => c.toolKey));
  const persistentTools = env.manifest.tools.map((t) => ({
    toolKey: t.toolKey,
    packageName: t.packageName,
    packageVersion: t.packageVersion,
    ...(t.auth ? { login: { kind: t.auth.kind, configured: configured.has(t.toolKey) } } : {}),
  }));
  const known = new Set(env.manifest.tools.flatMap((t) => [t.toolKey, t.packageName]));

  const [local, repeated] = await Promise.all([
    args.workerSessionId
      ? query<{ name: string }>(
          `select distinct unnest(cc.local_installs) as name
             from computer_commands cc join computers c on c.id = cc.computer_id
            where c.user_id = $1 and c.worker_session_id = $2
              and c.lifecycle in ('provisioning','running','dormant')`,
          [args.userId, args.workerSessionId],
        )
      : Promise.resolve({ rows: [] as { name: string }[] }),
    query<{ name: string; tasks: number }>(
      `select name, count(distinct c.responsibility_id)::int as tasks
         from computer_commands cc
         join computers c on c.id = cc.computer_id
         cross join lateral unnest(cc.local_installs) as name
        where cc.user_id = $1 and c.responsibility_id is not null
        group by name
       having count(distinct c.responsibility_id) >= $2
        order by tasks desc, name
        limit 10`,
      [args.userId, PROMOTION_MIN_TASKS],
    ),
  ]);

  return {
    generation: env.generation,
    persistentTools,
    thisComputerOnly: {
      localInstalls: local.rows.map((r) => r.name).sort(),
      note: "Installed by hand for this task only; gone when this computer is released.",
    },
    suggestions: repeated.rows
      .filter((r) => !known.has(r.name))
      .map(
        (r) => `You installed ${r.name} locally in ${r.tasks} earlier tasks. Consider proposing it for all computers with computer_install_tool.`,
      ),
  };
}
