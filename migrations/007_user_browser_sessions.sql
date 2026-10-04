-- 'user': a browser the user opened themselves from the Computer panel (their
-- persistent profile, so manual sign-ins persist for August). At most one open
-- per user.
alter table browser_sessions drop constraint if exists browser_sessions_kind_check;
alter table browser_sessions add constraint browser_sessions_kind_check check (kind in ('task','run','user'));

create unique index browser_sessions_one_user_browser_uidx
  on browser_sessions(user_id)
  where kind = 'user' and status <> 'closed';
