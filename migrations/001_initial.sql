-- 001_initial.sql
-- Core durable schema for August (spec Appendix B, section 38) plus the
-- section 24 tables not present in the appendix (connections, browser_profiles,
-- browser_profile_leases) and the section 24 indexes.
-- memory_records + pgvector live in 002_memory.sql.

create extension if not exists "pgcrypto";

create table app_users (
  id uuid primary key default gen_random_uuid(),
  auth_subject text not null unique,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now()
);

create table threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id),
  title text,
  created_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references threads(id),
  user_id uuid not null references app_users(id),
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  authority_kind text not null default 'none',
  created_at timestamptz not null default now()
);

create table responsibilities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id),
  thread_id uuid not null references threads(id),
  source_message_id uuid references messages(id),
  title text not null,
  goal text not null,
  success_criteria jsonb not null default '[]',
  constraints jsonb not null default '{}',
  status text not null,
  priority text not null default 'normal',
  next_action text,
  next_wake_at timestamptz,
  waiting_on text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index responsibilities_user_status_idx
  on responsibilities(user_id, status, updated_at desc);

create table responsibility_events (
  id uuid primary key default gen_random_uuid(),
  responsibility_id uuid not null references responsibilities(id),
  user_id uuid not null references app_users(id),
  event_kind text not null,
  safe_detail jsonb not null default '{}',
  evidence_refs jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table worker_sessions (
  id uuid primary key default gen_random_uuid(),
  responsibility_id uuid not null references responsibilities(id),
  user_id uuid not null references app_users(id),
  assignment_ref text not null unique,
  objective text not null,
  success_criteria jsonb not null default '[]',
  constraints jsonb not null default '{}',
  capability_scope jsonb not null default '[]',
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table worker_runs (
  id uuid primary key default gen_random_uuid(),
  worker_session_id uuid not null references worker_sessions(id),
  user_id uuid not null references app_users(id),
  status text not null,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  report jsonb
);

create table wakeups (
  id uuid primary key default gen_random_uuid(),
  responsibility_id uuid not null references responsibilities(id),
  user_id uuid not null references app_users(id),
  source text not null,
  cause_ref text not null,
  due_at timestamptz not null,
  status text not null default 'pending',
  claim_owner text,
  claim_expires_at timestamptz,
  attempt_count integer not null default 0,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

create index wakeups_due_idx on wakeups(status, due_at);

create table evidence_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id),
  responsibility_id uuid references responsibilities(id),
  provider text not null,
  source_ref text,
  source_url text,
  safe_summary text not null,
  payload jsonb,
  observed_at timestamptz not null default now(),
  expires_at timestamptz
);

create table effect_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id),
  responsibility_id uuid not null references responsibilities(id),
  worker_session_id uuid references worker_sessions(id),
  source_message_id uuid references messages(id),
  provider text not null,
  action text not null,
  effect_class text not null,
  canonical_args jsonb not null,
  material_facts jsonb not null default '{}',
  proposal_hash text not null,
  review_decision text,
  review_reason text,
  status text not null default 'prepared',
  idempotency_key text not null unique,
  attempt integer not null default 1,
  dispatch_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index effect_user_status_idx
  on effect_proposals(user_id, status, updated_at desc);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  effect_proposal_id uuid not null references effect_proposals(id),
  user_id uuid not null references app_users(id),
  proposal_hash text not null,
  decision text not null check (decision in ('approved','denied')),
  created_at timestamptz not null default now()
);

create table effect_receipts (
  id uuid primary key default gen_random_uuid(),
  effect_proposal_id uuid not null references effect_proposals(id),
  user_id uuid not null references app_users(id),
  outcome text not null check (outcome in ('succeeded','failed','uncertain')),
  provider_receipt_ref text,
  provider_request_id text,
  evidence_refs jsonb not null default '[]',
  retry_posture text not null,
  created_at timestamptz not null default now()
);

create table provider_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references app_users(id),
  responsibility_id uuid references responsibilities(id),
  provider text not null,
  external_event_id text not null,
  event_kind text not null,
  payload_digest text not null,
  safe_payload jsonb not null default '{}',
  received_at timestamptz not null default now(),
  consumed_at timestamptz,
  unique(provider, external_event_id)
);

create table artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id),
  responsibility_id uuid references responsibilities(id),
  storage_key text not null,
  filename text not null,
  media_type text not null,
  byte_count bigint not null,
  sha256 text not null,
  created_at timestamptz not null default now()
);

create table trace_events (
  id bigserial primary key,
  user_id uuid not null references app_users(id),
  responsibility_id uuid references responsibilities(id),
  worker_run_id uuid references worker_runs(id),
  event_kind text not null,
  safe_detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Section 24 additions -------------------------------------------------------

create table connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id),
  provider text not null,
  connection_ref text not null,
  status text not null default 'active',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, provider, connection_ref)
);

create index connections_user_provider_idx
  on connections(user_id, provider, status);

create table browser_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id),
  kernel_profile_ref text not null unique,
  label text,
  status text not null default 'active',
  lease_metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index browser_profiles_user_idx on browser_profiles(user_id, status);

-- Single-writer lease over a Kernel browser profile (section 19).
create table browser_profile_leases (
  id uuid primary key default gen_random_uuid(),
  browser_profile_id uuid not null references browser_profiles(id),
  user_id uuid not null references app_users(id),
  worker_run_id uuid references worker_runs(id),
  kernel_session_ref text,
  mode text not null default 'write' check (mode in ('read','write')),
  lease_owner text not null,
  lease_expires_at timestamptz not null,
  acquired_at timestamptz not null default now(),
  released_at timestamptz
);

-- At most one unreleased lease per profile (simple hackathon rule).
create unique index browser_profile_leases_active_uidx
  on browser_profile_leases(browser_profile_id)
  where released_at is null;

-- Section 24 indexes ---------------------------------------------------------

create index worker_runs_status_lease_idx
  on worker_runs(status, lease_expires_at);

create index effect_proposals_hash_idx
  on effect_proposals(proposal_hash);

create index responsibility_events_resp_idx
  on responsibility_events(responsibility_id, created_at);
