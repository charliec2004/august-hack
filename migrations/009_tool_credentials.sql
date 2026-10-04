-- CLI logins for tools in the user's environment (e.g. a Notion token).
--
-- Secrets: values are AES-256-GCM encrypted with the server key
-- CREDENTIALS_KEY (AAD = user, tool, kind); plaintext exists only in server
-- memory while injecting into a live Computer. Nothing else stores it.

create table tool_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id),
  tool_key text not null,
  kind text not null check (kind in ('env','file')),
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  key_version integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, tool_key)
);

-- Credential files currently written on a live Computer:
-- { toolKey: { path, updatedAt } }. Used to sync after the user changes a
-- login and to delete the files before the Computer is destroyed.
alter table computers add column credential_files jsonb not null default '{}';

-- Software installed by hand in a task (npm -g, pip, brew, curl|sh...), as a
-- promotion signal: the same tool installed in several unrelated tasks is
-- suggested for the persistent environment. Names only; never values.
alter table computer_commands add column local_installs text[] not null default '{}';
