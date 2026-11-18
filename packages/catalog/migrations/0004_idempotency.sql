-- Answers to writes that carried an Idempotency-Key, so a retry returns the first answer instead of writing twice.
create table idempotency_key (
  key        text primary key,
  body_hash  text  not null,
  response   jsonb not null,
  created_at timestamptz not null default now()
);
create index idempotency_key_created on idempotency_key (created_at);
