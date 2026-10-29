/**
 * Database migrations, in order. Each one runs once, inside a transaction,
 * and is recorded in segue.schema_migrations. They are TypeScript strings
 * (not .sql files) so the bundled server carries them.
 *
 * Everything lives in the `segue` schema. On Supabase that schema is not
 * exposed through the auto-generated REST API, and row-level security is on
 * with no policies, so the browser's public key can't read these tables.
 * Only the Segue API (connected with the database URL) can, and it checks
 * who may see what on every request.
 */
import { RESERVED_USERNAMES } from '@segue/schemas';

export interface Migration {
  id: string;
  up: string;
  down: string;
}

const social: Migration = {
  id: '001_accounts_notes_invitations',
  up: /* sql */ `
create table segue.profiles (
  id uuid primary key,
  username text not null check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null check (char_length(display_name) between 1 and 60),
  avatar text check (avatar is null or (avatar like 'data:image/%' and char_length(avatar) <= 60000)),
  bio text not null default '' check (char_length(bio) <= 280),
  discoverable boolean not null default false,
  notify jsonb not null default '{"hearts": true, "invitations": true, "shares": true}',
  timezone text not null default 'UTC' check (char_length(timezone) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_username_key on segue.profiles (username);

-- Personal planner data synced across devices: one JSON value per key, versioned.
create table segue.user_state (
  user_id uuid not null references segue.profiles (id) on delete cascade,
  key text not null check (key in ('blocks', 'settings', 'favorites', 'placeHistory', 'dayArchive')),
  value jsonb not null,
  version integer not null check (version > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table segue.notes (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references segue.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  body text not null default '' check (char_length(body) <= 4000),
  visibility text not null default 'private' check (visibility in ('private', 'selected', 'discoverable')),
  on_date date,
  place_name text check (char_length(place_name) <= 120),
  block_id text check (char_length(block_id) <= 80),
  pinned boolean not null default false,
  archived_at timestamptz,
  client_id text check (char_length(client_id) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (author_id, client_id)
);
create index notes_author_idx on segue.notes (author_id, updated_at desc);
create index notes_discoverable_idx on segue.notes (updated_at desc) where visibility = 'discoverable' and archived_at is null;

-- Who a "selected people" note is shared with.
create table segue.note_shares (
  note_id uuid not null references segue.notes (id) on delete cascade,
  user_id uuid not null references segue.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (note_id, user_id)
);
create index note_shares_user_idx on segue.note_shares (user_id);

create table segue.activities (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references segue.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text not null default 'UTC' check (char_length(timezone) <= 64),
  place_name text check (char_length(place_name) <= 120),
  meeting_notes text not null default '' check (char_length(meeting_notes) <= 500),
  source_note_id uuid references segue.notes (id) on delete set null,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  client_id text check (char_length(client_id) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (created_by, client_id),
  check (ends_at is null or (starts_at is not null and ends_at > starts_at))
);

-- One row per person invited, so each person answers for themselves.
create table segue.invitations (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references segue.activities (id) on delete cascade,
  sender_id uuid not null references segue.profiles (id) on delete cascade,
  recipient_id uuid not null references segue.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  expires_at timestamptz,
  responded_at timestamptz,
  -- What changed since this person last answered (time, place, ...), shown so they can review it.
  changed_fields text[] not null default '{}',
  -- "Can we do another time?" from the person invited.
  counter_start timestamptz,
  counter_end timestamptz,
  counter_note text check (char_length(counter_note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (activity_id, recipient_id),
  check (sender_id <> recipient_id)
);
create index invitations_recipient_idx on segue.invitations (recipient_id, created_at desc);
create index invitations_sender_idx on segue.invitations (sender_id, created_at desc);

-- A heart: "I'd like to be invited to this". Its status comes from the linked invitation.
create table segue.note_interests (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references segue.notes (id) on delete cascade,
  user_id uuid not null references segue.profiles (id) on delete cascade,
  withdrawn_at timestamptz,
  invitation_id uuid references segue.invitations (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (note_id, user_id)
);
create index note_interests_user_idx on segue.note_interests (user_id);

create table segue.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references segue.profiles (id) on delete cascade,
  actor_id uuid references segue.profiles (id) on delete set null,
  type text not null check (type in (
    'note_hearted', 'note_shared', 'invitation_received', 'invitation_accepted', 'invitation_declined',
    'invitation_cancelled', 'invitation_changed', 'invitation_counter'
  )),
  entity_type text not null check (entity_type in ('note', 'invitation')),
  entity_id uuid not null,
  dedupe_key text not null check (char_length(dedupe_key) <= 200),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (recipient_id, dedupe_key)
);
create index notifications_recipient_idx on segue.notifications (recipient_id, created_at desc);

alter table segue.profiles enable row level security;
alter table segue.user_state enable row level security;
alter table segue.notes enable row level security;
alter table segue.note_shares enable row level security;
alter table segue.activities enable row level security;
alter table segue.invitations enable row level security;
alter table segue.note_interests enable row level security;
alter table segue.notifications enable row level security;
`,
  down: /* sql */ `
drop table if exists segue.notifications;
drop table if exists segue.note_interests;
drop table if exists segue.invitations;
drop table if exists segue.activities;
drop table if exists segue.note_shares;
drop table if exists segue.notes;
drop table if exists segue.user_state;
drop table if exists segue.profiles;
`,
};

const profilesConnections: Migration = {
  id: '002_profile_settings_connections',
  up: /* sql */ `
-- Profile settings. Avatars now live in object storage; the column holds the public URL
-- (older rows may still hold a small data URL, which stays readable).
alter table segue.profiles drop constraint if exists profiles_avatar_check;
alter table segue.profiles add constraint profiles_avatar_check check (
  avatar is null
  or (avatar like 'data:image/%' and char_length(avatar) <= 60000)
  or ((avatar like 'https://%' or avatar like 'http://localhost%' or avatar like 'http://127.0.0.1%') and char_length(avatar) <= 500)
);
alter table segue.profiles add column avatar_key text check (avatar_key is null or char_length(avatar_key) <= 200);
alter table segue.profiles add column pronouns text not null default '' check (char_length(pronouns) <= 40);
alter table segue.profiles add column interests text[] not null default '{}' check (cardinality(interests) <= 10);
alter table segue.profiles add column profile_visibility text not null default 'everyone' check (profile_visibility in ('everyone', 'mutuals', 'only_me'));
alter table segue.profiles add column show_mutual_count boolean not null default false;
alter table segue.profiles add column who_can_invite text not null default 'everyone' check (who_can_invite in ('everyone', 'mutuals', 'nobody'));
alter table segue.profiles alter column notify set default '{"hearts": true, "invitations": true, "shares": true, "connections": true}';

-- Mutual connections. One row per pair, whichever way the request went.
create table segue.connections (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references segue.profiles (id) on delete cascade,
  recipient_id uuid not null references segue.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requester_id <> recipient_id)
);
create unique index connections_pair_key on segue.connections (least(requester_id, recipient_id), greatest(requester_id, recipient_id));
create index connections_recipient_idx on segue.connections (recipient_id, status);
create index connections_requester_idx on segue.connections (requester_id, status);

create table segue.user_blocks (
  blocker_id uuid not null references segue.profiles (id) on delete cascade,
  blocked_id uuid not null references segue.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index user_blocks_blocked_idx on segue.user_blocks (blocked_id);

alter table segue.notifications drop constraint if exists notifications_type_check;
alter table segue.notifications add constraint notifications_type_check check (type in (
  'note_hearted', 'note_shared', 'invitation_received', 'invitation_accepted', 'invitation_declined',
  'invitation_cancelled', 'invitation_changed', 'invitation_counter', 'connection_request', 'connection_accepted'
));
alter table segue.notifications drop constraint if exists notifications_entity_type_check;
alter table segue.notifications add constraint notifications_entity_type_check check (entity_type in ('note', 'invitation', 'connection'));

alter table segue.connections enable row level security;
alter table segue.user_blocks enable row level security;

-- Public bucket for profile pictures. Skipped where Supabase Storage isn't present (plain Postgres in CI).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('avatars', 'avatars', true, 2097152, array['image/webp', 'image/jpeg', 'image/png'])
    on conflict (id) do nothing;
  end if;
end $$;
`,
  down: /* sql */ `
delete from segue.notifications where type in ('connection_request', 'connection_accepted');
alter table segue.notifications drop constraint if exists notifications_entity_type_check;
alter table segue.notifications add constraint notifications_entity_type_check check (entity_type in ('note', 'invitation'));
alter table segue.notifications drop constraint if exists notifications_type_check;
alter table segue.notifications add constraint notifications_type_check check (type in (
  'note_hearted', 'note_shared', 'invitation_received', 'invitation_accepted', 'invitation_declined',
  'invitation_cancelled', 'invitation_changed', 'invitation_counter'
));
drop table if exists segue.user_blocks;
drop table if exists segue.connections;
alter table segue.profiles drop column if exists who_can_invite;
alter table segue.profiles drop column if exists show_mutual_count;
alter table segue.profiles drop column if exists profile_visibility;
alter table segue.profiles drop column if exists interests;
alter table segue.profiles drop column if exists pronouns;
alter table segue.profiles drop column if exists avatar_key;
update segue.profiles set avatar = null where avatar like 'http%';
alter table segue.profiles drop constraint if exists profiles_avatar_check;
alter table segue.profiles add constraint profiles_avatar_check check (avatar is null or (avatar like 'data:image/%' and char_length(avatar) <= 60000));
alter table segue.profiles alter column notify set default '{"hearts": true, "invitations": true, "shares": true}';
`,
};

const usernameRules: Migration = {
  id: '003_username_rules',
  up: /* sql */ `
-- Usernames were already stored lowercase with a unique index, so "Dia" and "dia" can't both exist.
-- New rule set: 3-20 characters, starts with a letter, ends with a letter or number, no doubled underscores.
-- Existing names that break the rules are kept as they are (nobody is renamed) and flagged, so the app can ask the owner to choose a new one.
alter table segue.profiles add column username_review boolean not null default false;
update segue.profiles set username_review = true
where not (username ~ '^[a-z][a-z0-9_]{1,18}[a-z0-9]$' and position('__' in username) = 0)
   or username = any (array[${RESERVED_USERNAMES.map((n) => `'${n}'`).join(', ')}]);

-- The database enforces the format whenever a username is set or changed, whatever code does it.
create function segue.enforce_username_rules() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.username is distinct from old.username then
    if new.username !~ '^[a-z][a-z0-9_]{1,18}[a-z0-9]$' or position('__' in new.username) > 0 then
      raise exception 'username does not meet the rules' using errcode = '23514', constraint = 'profiles_username_rules';
    end if;
    new.username_review := false;
  end if;
  return new;
end $$;
create trigger profiles_username_rules before insert or update of username on segue.profiles
  for each row execute function segue.enforce_username_rules();
`,
  down: /* sql */ `
drop trigger if exists profiles_username_rules on segue.profiles;
drop function if exists segue.enforce_username_rules();
alter table segue.profiles drop column if exists username_review;
`,
};

const calendarSync: Migration = {
  id: '004_google_calendar_sync',
  up: /* sql */ `
-- One connected Google account per Segue account. Tokens are encrypted by the API (AES-256-GCM) before they get here.
create table segue.google_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references segue.profiles (id) on delete cascade,
  google_sub text not null,
  email text not null check (char_length(email) <= 320),
  scopes text not null default '',
  refresh_token_enc text,
  access_token_enc text,
  access_expires_at timestamptz,
  status text not null default 'active' check (status in ('active', 'needs_reauth')),
  default_calendar_id uuid,
  last_error text check (char_length(last_error) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table segue.google_calendars (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references segue.google_accounts (id) on delete cascade,
  google_calendar_id text not null check (char_length(google_calendar_id) <= 300),
  summary text not null default '' check (char_length(summary) <= 300),
  is_primary boolean not null default false,
  access_role text not null default 'reader' check (access_role in ('freeBusyReader', 'reader', 'writer', 'owner')),
  time_zone text check (char_length(time_zone) <= 64),
  color text check (char_length(color) <= 16),
  sync_enabled boolean not null default false,
  -- Google's incremental-sync cursor, and the window the first full sync covered.
  sync_token text,
  window_start timestamptz,
  window_end timestamptz,
  synced_at timestamptz,
  lease_until timestamptz,
  last_error text check (char_length(last_error) <= 300),
  -- Push notification channel (renewed before it expires).
  channel_id text,
  channel_token_hash text,
  channel_resource_id text,
  channel_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, google_calendar_id)
);
create unique index google_calendars_channel_key on segue.google_calendars (channel_id) where channel_id is not null;
alter table segue.google_accounts add constraint google_accounts_default_calendar_fk
  foreign key (default_calendar_id) references segue.google_calendars (id) on delete set null;

-- Sign-in handshakes in progress (state + PKCE verifier), single use.
create table segue.google_oauth_states (
  state_hash text primary key,
  user_id uuid not null references segue.profiles (id) on delete cascade,
  verifier_enc text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Segue's copy of each event in a synced calendar, linked to Google by (calendar, Google event id).
create table segue.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references segue.profiles (id) on delete cascade,
  calendar_id uuid not null references segue.google_calendars (id) on delete cascade,
  google_event_id text check (char_length(google_event_id) <= 1024),
  ical_uid text,
  recurring_event_id text,
  original_start jsonb,
  etag text,
  origin text not null default 'google' check (origin in ('google', 'segue')),
  title text not null default '' check (char_length(title) <= 300),
  description text not null default '' check (char_length(description) <= 8000),
  location text not null default '' check (char_length(location) <= 500),
  all_day boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  start_date date,
  end_date date,
  time_zone text check (char_length(time_zone) <= 64),
  status text not null default 'confirmed' check (status in ('confirmed', 'tentative', 'cancelled')),
  transparency text not null default 'opaque' check (transparency in ('opaque', 'transparent')),
  meeting_url text check (char_length(meeting_url) <= 500),
  html_link text check (char_length(html_link) <= 500),
  can_edit boolean not null default false,
  -- What Google had when we last synced, field by field, so a later edit on either side can be merged.
  base jsonb not null default '{}',
  -- Local edits not yet confirmed by Google (field -> new value), and any conflict waiting for a choice.
  local_changes jsonb not null default '{}',
  conflict jsonb,
  sync_state text not null default 'synced' check (sync_state in ('synced', 'pending', 'failed', 'conflict')),
  sync_error text check (char_length(sync_error) <= 300),
  -- The person removed it from Segue's view; stays hidden through later syncs.
  hidden boolean not null default false,
  -- Deleted in Segue, waiting to be deleted in Google.
  delete_requested boolean not null default false,
  client_id text check (char_length(client_id) <= 80),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((all_day and start_date is not null and end_date is not null) or (not all_day and starts_at is not null and ends_at is not null))
);
create unique index calendar_events_google_key on segue.calendar_events (calendar_id, google_event_id) where google_event_id is not null;
create unique index calendar_events_client_key on segue.calendar_events (user_id, client_id) where client_id is not null;
create index calendar_events_time_idx on segue.calendar_events (user_id, starts_at);
create index calendar_events_date_idx on segue.calendar_events (user_id, start_date) where all_day;
create index calendar_events_state_idx on segue.calendar_events (user_id, sync_state) where sync_state <> 'synced';

-- Writes waiting to go to Google. Created in the same transaction as the local change, so one can't exist without the other.
create table segue.calendar_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references segue.profiles (id) on delete cascade,
  event_id uuid not null references segue.calendar_events (id) on delete cascade,
  op text not null check (op in ('create', 'update', 'delete')),
  idempotency_key text not null unique,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'dead')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  last_error text check (char_length(last_error) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index calendar_outbox_open_key on segue.calendar_outbox (event_id) where status in ('queued', 'running');
create index calendar_outbox_due_idx on segue.calendar_outbox (next_attempt_at) where status = 'queued';

alter table segue.google_accounts enable row level security;
alter table segue.google_calendars enable row level security;
alter table segue.google_oauth_states enable row level security;
alter table segue.calendar_events enable row level security;
alter table segue.calendar_outbox enable row level security;
`,
  down: /* sql */ `
drop table if exists segue.calendar_outbox;
drop table if exists segue.calendar_events;
drop table if exists segue.google_oauth_states;
alter table segue.google_accounts drop constraint if exists google_accounts_default_calendar_fk;
drop table if exists segue.google_calendars;
drop table if exists segue.google_accounts;
`,
};

/** Join requests: a plan can be open (or not) to "Can I join?", and its owner can say yes or not this time. Additive only. */
const joinRequests: Migration = {
  id: '005_join_requests',
  up: /* sql */ `
alter table segue.notes add column open_to_join boolean not null default true;
-- The owner said "not this time" to a request. The requester can't ask again for the same plan.
alter table segue.note_interests add column declined_at timestamptz;
alter table segue.notifications drop constraint if exists notifications_type_check;
alter table segue.notifications add constraint notifications_type_check check (type in (
  'note_hearted', 'note_shared', 'invitation_received', 'invitation_accepted', 'invitation_declined',
  'invitation_cancelled', 'invitation_changed', 'invitation_counter', 'connection_request', 'connection_accepted',
  'join_accepted', 'join_declined'
));
`,
  down: /* sql */ `
delete from segue.notifications where type in ('join_accepted', 'join_declined');
alter table segue.notifications drop constraint if exists notifications_type_check;
alter table segue.notifications add constraint notifications_type_check check (type in (
  'note_hearted', 'note_shared', 'invitation_received', 'invitation_accepted', 'invitation_declined',
  'invitation_cancelled', 'invitation_changed', 'invitation_counter', 'connection_request', 'connection_accepted'
));
alter table segue.note_interests drop column if exists declined_at;
alter table segue.notes drop column if exists open_to_join;
`,
};

export const MIGRATIONS: Migration[] = [social, profilesConnections, usernameRules, calendarSync, joinRequests];
