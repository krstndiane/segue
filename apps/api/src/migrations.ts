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

export const MIGRATIONS: Migration[] = [social];
