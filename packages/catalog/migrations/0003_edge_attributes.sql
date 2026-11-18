-- What a source says about an edge: for lineage, the job that produced it and how sure the source is.
alter table edge add column attributes jsonb not null default '{}';
-- Lineage walks derives_from edges in both directions.
create index edge_lineage_from on edge (from_id) where name = 'derives_from' and valid_to is null and recorded_to is null;
create index edge_lineage_to on edge (to_id) where name = 'derives_from' and valid_to is null and recorded_to is null;
