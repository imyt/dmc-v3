-- Latest trust grade per asset: five dimension grades, the tier (the lowest), and the tier its scopes require.
create table grade (
  subject_ref   text        primary key,
  dimensions    jsonb       not null,
  tier          text        not null,
  required_tier text        not null,
  weakest       text[]      not null,
  computed_at   timestamptz not null default now()
);
create index grade_short on grade (subject_ref) where tier <> required_tier;
