-- Append-only, hash-chained ledger (system design: Evidence ledger).
create table ledger_entry (
  seq           bigint      primary key,
  kind          text        not null,
  subject_ref   text        not null,
  actor         text        not null,
  source_module text        not null,
  source_id     bigint      not null,
  payload       jsonb       not null,
  occurred_at   timestamptz not null,
  payload_hash  text        not null,
  prev_hash     text        not null,
  hash          text        not null,
  recorded_at   timestamptz not null default now(),
  unique (source_module, source_id)
);
create index ledger_subject on ledger_entry (subject_ref, seq);

create function ledger_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'evidence.ledger_entry is append-only';
end $$;
create trigger ledger_no_row_change before update or delete on ledger_entry
  for each row execute function ledger_append_only();
create trigger ledger_no_truncate before truncate on ledger_entry
  for each statement execute function ledger_append_only();

-- Only the ledger writer may insert; nobody may update or delete.
revoke all on ledger_entry from public;
grant select, insert on ledger_entry to dmc_evidence;
revoke update, delete, truncate on ledger_entry from dmc_evidence;
