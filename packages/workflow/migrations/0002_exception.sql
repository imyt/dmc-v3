create table exception (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  severity    text not null check (severity in ('low', 'medium', 'high', 'critical')),
  subject_ref text not null,                -- what it was raised on
  policy_id   text,
  message     text not null,
  route       text not null,
  dedupe_key  text not null,
  instance_id uuid not null references instance(id),
  raised_at   timestamptz not null default now(),
  due_at      timestamptz
);
-- one open exception per policy and subject: re-evaluating the same signal must not raise it again
create unique index exception_open_dedupe on exception (dedupe_key);
create index exception_subject on exception (subject_ref);

-- status is derived from the workflow instance, so it can never disagree with it
create view exception_view as
select e.*,
  case
    when i.status = 'cancelled' then 'withdrawn'
    when i.status = 'completed' then i.outcome
    when exists (select 1 from step_run r where r.instance_id = i.id and r.kind = 'task' and r.escalated_at is not null) then 'escalated'
    else 'open'
  end as status
from exception e join instance i on i.id = e.instance_id;
