-- ADR 0027: the keys of the records the catalog refused in a run. The next run does not count them as changes against max_changes_pct (they were found again, not changed).
alter table run add column refused_keys jsonb;
