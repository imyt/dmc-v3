create table signal (
  id          uuid primary key default gen_random_uuid(),
  source      text not null,
  key         text not null,
  kind        text not null,
  subject_ref text not null,
  subject_type text not null,
  confidence  numeric not null default 1,
  received_at timestamptz not null default now(),
  unique (source, key)
);
create index signal_subject on signal (subject_ref);

create table decision (
  id          uuid primary key default gen_random_uuid(),
  signal_id   uuid not null references signal(id),
  policy_id   text not null,
  mode        text not null check (mode in ('shadow', 'enforced')),
  matched     boolean,
  outcome     text not null check (outcome in ('act', 'act_notify', 'propose', 'drop', 'shadow', 'cleared', 'error')),
  reason      text,
  effect      jsonb not null,
  route       text,
  escalate_after text,
  confidence  numeric not null,
  inputs_hash text not null,
  status      text not null check (status in ('planned', 'applied', 'failed', 'none')),
  attempts    integer not null default 0,
  last_error  text,
  decided_at  timestamptz not null default now(),
  applied_at  timestamptz,
  unique (signal_id, policy_id)
);
create index decision_pending on decision (status) where status in ('planned', 'failed');
