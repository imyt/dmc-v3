create table action (
  id              uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  decision_id     text not null,
  policy_id       text not null,
  subject_ref     text not null,
  kind            text not null check (kind in ('dmc_change', 'tool_task', 'notify')),
  effect          jsonb not null,
  status          text not null check (status in ('done', 'blocked', 'pending_confirmation', 'undone', 'failed')),
  switch_scope    text,                       -- which kill switch blocked it
  undo            jsonb,                      -- { attribute, previous, applied } for dmc_change
  actor           text not null,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz,
  undone_at       timestamptz,
  undone_by       text
);
create index action_subject on action (subject_ref);
create index action_blocked on action (status) where status = 'blocked';

create table kill_switch (
  scope       text primary key,               -- 'all' | 'policy:<id>' | 'effect:<action>'
  reason      text not null,
  set_by      text not null,
  set_at      timestamptz not null default now()
);

-- A change waiting for the owning tool. The next sync of that source confirms it (D3).
create table pending_change (
  id          uuid primary key default gen_random_uuid(),
  action_id   uuid not null references action(id),
  subject_ref text not null,
  attribute   text not null,
  expected    jsonb not null,
  route       text not null,
  due_by      timestamptz,
  state       text not null default 'pending' check (state in ('pending', 'confirmed', 'escalated', 'cancelled')),
  created_at  timestamptz not null default now(),
  confirmed_at timestamptz
);
create index pending_open on pending_change (subject_ref, attribute) where state = 'pending';
