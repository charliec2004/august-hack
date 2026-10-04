-- Computers and portable user state (DECISIONS D1), modeled on the main August
-- repo's split: "persistent user state follows the user; compute follows the
-- session". A Sprite is a replaceable execution surface. The User Environment
-- manifest is canonical here in Postgres; the installed-tool bundle lives in
-- Neon Object Storage; the Sprite only ever holds a restored copy.

-- Head pointer per user. Activation is a compare-and-swap on
-- (active_generation, activation_revision). Generation 0 = empty baseline.
create table user_environment_states (
  user_id uuid primary key references app_users(id),
  active_generation integer not null default 0,
  next_generation integer not null default 1,
  activation_revision integer not null default 0,
  updated_at timestamptz not null default now()
);

-- One immutable row per generation.
-- manifest: { format: "user-environment-manifest:v1",
--             tools: [{ toolKey, packageName, packageVersion }],
--             setup: [{ toolKey, command }] }
create table user_environments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id),
  generation integer not null,
  manifest jsonb not null,
  manifest_sha256 text not null,
  bundle_object_key text,
  bundle_sha256 text,
  status text not null check (status in ('candidate','verified','published','failed')),
  source_effect_id uuid references effect_proposals(id),
  created_at timestamptz not null default now(),
  unique (user_id, generation)
);

-- A Computer is bound to one worker session (or the Brain's own session when
-- worker_session_id is null). It pins one User Environment generation.
create table computers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id),
  responsibility_id uuid references responsibilities(id),
  worker_session_id uuid references worker_sessions(id),
  provider text not null default 'sprites',
  provider_ref text not null,
  lifecycle text not null check (lifecycle in ('provisioning','running','dormant','released','lost')),
  pinned_generation integer not null default 0,
  last_checkpoint_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  released_at timestamptz,
  unique (provider, provider_ref)
);

create index computers_user_lifecycle_idx on computers(user_id, lifecycle);
create unique index computers_one_live_per_session_uidx
  on computers(worker_session_id)
  where worker_session_id is not null and lifecycle in ('provisioning','running','dormant');

-- Every command run on a Computer: command, exit status, output digest,
-- produced artifact refs (spec section 22).
create table computer_commands (
  id uuid primary key default gen_random_uuid(),
  computer_id uuid not null references computers(id),
  user_id uuid not null references app_users(id),
  command text not null,
  exit_code integer,
  stdout_digest text,
  safe_output text,
  artifact_refs jsonb not null default '[]',
  created_at timestamptz not null default now()
);

-- AgentMail thread -> responsibility mapping, so inbound replies wake the
-- right obligation.
create table mail_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id),
  responsibility_id uuid not null references responsibilities(id),
  inbox_id text not null,
  provider_thread_id text not null,
  created_at timestamptz not null default now(),
  unique (inbox_id, provider_thread_id)
);

-- UI message parts (assistant-ui) alongside the plain-text content.
alter table messages add column parts jsonb;
alter table messages add column responsibility_id uuid references responsibilities(id);

-- Short-lived browser live-view URLs are UI metadata, not durable state.
alter table worker_runs add column live_view_url text;
alter table worker_runs add column responsibility_id uuid references responsibilities(id);
