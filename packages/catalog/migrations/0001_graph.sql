-- Catalog graph: nodes and edges, bitemporal (valid time + record time). Metamodel types live in YAML, not here.

create table node (
  id             uuid primary key default gen_random_uuid(),
  type           text not null,
  qualified_name text not null unique,   -- identity: re-applying a record finds the same node
  created_at     timestamptz not null default now()
);
create index node_type on node (type, qualified_name);

create table node_version (
  node_id       uuid        not null references node(id),
  lifecycle     text        not null check (lifecycle in ('discovered', 'proposed', 'confirmed', 'deprecated')),
  attributes    jsonb       not null,
  provenance    jsonb       not null,     -- per attribute: who or what set it, when
  valid_from    timestamptz not null,
  valid_to      timestamptz,              -- null = still true
  recorded_from timestamptz not null default now(),
  recorded_to   timestamptz,              -- null = our current belief
  actor         text        not null,
  primary key (node_id, valid_from, recorded_from)
);
-- exactly one current version per node
create unique index node_version_current on node_version (node_id) where valid_to is null and recorded_to is null;
create index node_version_asof on node_version (node_id, valid_from, valid_to);

create table edge (
  id            bigserial   primary key,
  name          text        not null,
  from_id       uuid        not null references node(id),
  to_id         uuid        not null references node(id),
  lifecycle     text        not null check (lifecycle in ('discovered', 'proposed', 'confirmed', 'deprecated')),
  source        text        not null,
  valid_from    timestamptz not null,
  valid_to      timestamptz,
  recorded_from timestamptz not null default now(),
  recorded_to   timestamptz,
  actor         text        not null
);
create unique index edge_current on edge (name, from_id, to_id) where valid_to is null and recorded_to is null;
create index edge_from on edge (from_id, name);
create index edge_to on edge (to_id, name);
