create table connection (
  name        text not null,
  environment text not null,
  type        text not null,
  config      jsonb not null default '{}',
  secret_ref  text not null,
  primary key (name, environment)
);

create table job (
  name        text not null,
  environment text not null,
  version     integer not null,
  definition  jsonb not null,
  connection  text not null,
  schedule    text not null,
  enabled     boolean not null default true,
  paused      boolean not null default false,
  primary key (name, environment)
);

create table run (
  id            uuid primary key default gen_random_uuid(),
  job           text not null,
  environment   text not null,
  trigger       text not null check (trigger in ('schedule', 'manual')),
  status        text not null check (status in ('running', 'succeeded', 'failed', 'paused_limit', 'discarded', 'skipped')),
  mode          text not null,
  complete      boolean not null default false,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  read_count    integer not null default 0,
  created       integer not null default 0,
  updated       integer not null default 0,
  unchanged     integer not null default 0,
  deprecated    integer not null default 0,
  errors        integer not null default 0,
  note          text,
  pending_cursor text
);
create index run_job on run (job, environment, started_at desc);

create table cursor (
  job         text not null,
  environment text not null,
  value       text not null,
  updated_at  timestamptz not null default now(),
  primary key (job, environment)
);

-- What the last committed run knew about each record: enough to see what changed without asking the catalog.
create table record_state (
  job         text not null,
  environment text not null,
  key         text not null,
  hash        text not null,
  state       text not null check (state in ('active', 'deprecated')),
  last_run    uuid not null,
  primary key (job, environment, key)
);

-- Changes found by a run, held until the run passes its limit check. Nothing leaves the module before that.
create table staging (
  run_id  uuid not null references run (id) on delete cascade,
  key     text not null,
  change  text not null check (change in ('created', 'updated', 'missing')),
  hash    text,
  attrs   jsonb,
  primary key (run_id, key)
);
