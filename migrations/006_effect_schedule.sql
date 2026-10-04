-- Send later + user edits on the exact-effect rail.
-- scheduled_for: an approved (authorized) effect is not dispatched before this
-- time; the wake scanner dispatches it once due.
-- supersedes_effect_id: a user-authored proposal that replaced an agent proposal
-- the user edited (the original is denied with 'superseded_by_user_edit').
alter table effect_proposals add column scheduled_for timestamptz;
alter table effect_proposals add column supersedes_effect_id uuid references effect_proposals(id);

create index effect_proposals_scheduled_idx
  on effect_proposals(scheduled_for)
  where status = 'authorized' and scheduled_for is not null;
