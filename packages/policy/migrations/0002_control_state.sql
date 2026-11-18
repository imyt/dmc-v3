-- Pause switches, set by an administrator. key: 'enforcement' (everything) or 'policy:<id>'.
-- A paused policy is evaluated as if it were in shadow mode: its result is recorded, and nothing is raised, blocked or changed.
create table control_state (
  key        text        primary key,
  paused     boolean     not null,
  changed_by text        not null,
  changed_at timestamptz not null default now()
);
