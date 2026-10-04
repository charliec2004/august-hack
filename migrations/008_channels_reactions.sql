-- Channels: web chat is one channel; email is a conversational channel too.
-- Every message records the channel it arrived on / was delivered to, plus a
-- provider reference (email: { inboxId, threadId, messageId }).
alter table messages add column channel text not null default 'web'
  check (channel in ('web','email','imessage'));
alter table messages add column channel_ref jsonb;

-- 'unverified_channel': text from a channel whose sender authentication could
-- not be confirmed. Stored and answered, never authorizing.
-- (authority_kind has no check constraint; documented here.)

-- Addresses a user is known by on each channel. Only verified identities may
-- talk to August on that channel.
create table channel_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  channel text not null check (channel in ('web','email','imessage')),
  address text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (channel, address)
);
create index channel_identities_user_idx on channel_identities(user_id, channel);

alter table app_users add column primary_channel text not null default 'web'
  check (primary_channel in ('web','email','imessage'));

-- Tapback reactions: one per user per message; changing replaces, removing deletes.
create table message_reactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  emoji text not null check (emoji in ('❤️','👍','👎','😂','‼️','❓')),
  created_at timestamptz not null default now(),
  unique (user_id, message_id)
);
create index message_reactions_message_idx on message_reactions(message_id);
