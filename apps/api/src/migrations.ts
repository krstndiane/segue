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

export const MIGRATIONS: Migration[] = [social, profilesConnections];
