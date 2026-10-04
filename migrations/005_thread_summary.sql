-- Rolling summary of the forever conversation: everything older than the
-- verbatim tail is folded into one running summary, updated incrementally.
create table thread_summaries (
  thread_id uuid primary key references threads(id) on delete cascade,
  user_id uuid not null references app_users(id),
  summary text not null,
  covers_until timestamptz not null,
  message_count integer not null default 0,
  updated_at timestamptz not null default now()
);
