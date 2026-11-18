-- Latest shadow evaluation per policy and subject. Shadow results never raise exceptions.
create table shadow_result (
  policy_id    text        not null,
  policy_mode  text        not null,
  subject_ref  text        not null,
  matched      boolean,                   -- null when the expression could not be evaluated
  error        text,
  evaluated_at timestamptz not null default now(),
  primary key (policy_id, subject_ref)
);
create index shadow_matched on shadow_result (policy_id) where matched;
