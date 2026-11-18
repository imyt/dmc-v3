create table definition (
  name       text    not null,
  version    integer not null,
  doc        jsonb   not null,
  checksum   text    not null,
  created_at timestamptz not null default now(),
  primary key (name, version)
);

create table instance (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  version     integer not null,
  subject_ref text not null,
  status      text not null check (status in ('running', 'completed', 'cancelled')),
  outcome     text,
  context     jsonb not null default '{}',
  started_by  text not null,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  foreign key (name, version) references definition (name, version)
);
create index instance_subject on instance (subject_ref);

-- One row each time a step is entered. A step is entered at most once per instance (graphs have no cycles),
-- so the unique key is what stops a retry from advancing the instance twice.
create table step_run (
  id          uuid primary key default gen_random_uuid(),
  instance_id uuid not null references instance(id),
  step_id     text not null,
  kind        text not null,
  status      text not null check (status in ('pending', 'running', 'done')),
  root        text not null default '',
  assignee    text,
  claimed_at  timestamptz,
  decision    text,
  decided_by  text,
  due_at      timestamptz,
  escalated_at timestamptz,
  created_at  timestamptz not null default now(),
  done_at     timestamptz,
  unique (instance_id, step_id)
);
create index step_run_assignee on step_run (assignee) where status = 'pending' and kind = 'task';

create table join_arrival (
  instance_id uuid not null references instance(id),
  join_step   text not null,
  root        text not null,   -- which branch of the parallel arrived
  arrived_at  timestamptz not null default now(),
  primary key (instance_id, join_step, root)
);

-- remembers the answer to a decision that was already made, so a retry returns it instead of acting again
create table decision_key (
  key         text primary key,
  step_run_id uuid not null references step_run(id),
  created_at  timestamptz not null default now()
);
