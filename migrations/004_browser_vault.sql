-- August's own browser: lifecycle-owned Kernel sessions and the per-user
-- vault of saved website logins.
--
-- Secrets: a saved login's username/password live ONLY in Kernel's vault
-- (credential item, sensitive fields encrypted by Kernel and never returned by
-- its API). This table stores the opaque item reference plus the exact HTTPS
-- origins the login may be entered on ("Login origin" binding).

create table vault_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id),
  label text not null,
  -- Exact normalized origins (scheme://host[:port]) the login may be used on.
  login_origins text[] not null check (cardinality(login_origins) between 1 and 5),
  login_url text,
  kernel_vault text not null,
  kernel_item_key text not null unique,
  status text not null check (status in ('pending','ready','failed')),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index vault_items_user_idx on vault_items(user_id, status);

-- Every Kernel browser session August creates. Liveness is owned by this row,
-- never by a URL copied into activity: "Watch browser" is offered only while
-- status = 'live'. Closed by the adapter's finally, the run's end, or
-- reconcileBrowserSessions (expired run lease / Kernel reports it gone).
create table browser_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id),
  responsibility_id uuid references responsibilities(id),
  worker_run_id uuid references worker_runs(id),
  -- 'task': one-shot session for a single tool call; 'run': the run's live browser.
  kind text not null default 'task' check (kind in ('task','run')),
  kernel_session_id text,
  -- Interactive Kernel live view (user can take control). Short-lived UI metadata.
  live_view_url text,
  browser_profile_id uuid references browser_profiles(id),
  profile_lease_id uuid references browser_profile_leases(id),
  status text not null default 'opening' check (status in ('opening','live','closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  close_reason text
);

create index browser_sessions_open_idx on browser_sessions(user_id) where status <> 'closed';
create unique index browser_sessions_one_run_browser_uidx
  on browser_sessions(worker_run_id)
  where kind = 'run' and status <> 'closed';

-- One persistent default Kernel profile per user (saved sign-ins/cookies).
create unique index browser_profiles_user_default_uidx
  on browser_profiles(user_id)
  where label = 'default' and status = 'active';
