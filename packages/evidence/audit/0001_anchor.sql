-- The separate audit database (E2). It holds only chain anchors: the ledger's head hash at a point in time.
-- DMC's writer role can insert and read; it cannot update, delete or truncate, so a rewritten ledger cannot also rewrite its anchors.
create table if not exists chain_anchor (
  seq         bigint      primary key,
  hash        text        not null,
  anchored_at timestamptz not null default now()
);
create or replace function chain_anchor_append_only() returns trigger language plpgsql as $$
begin raise exception 'chain_anchor is append-only'; end $$;
drop trigger if exists chain_anchor_no_change on chain_anchor;
create trigger chain_anchor_no_change before update or delete on chain_anchor for each row execute function chain_anchor_append_only();
drop trigger if exists chain_anchor_no_truncate on chain_anchor;
create trigger chain_anchor_no_truncate before truncate on chain_anchor for each statement execute function chain_anchor_append_only();
