-- Search index over the current state of each node. Maintained by the store in the same transaction as the change.
create table search_doc (
  node_id        uuid primary key references node(id),
  type           text not null,
  lifecycle      text not null,
  qualified_name text not null,
  name           text not null,
  doc            tsvector not null
);
create index search_doc_gin on search_doc using gin (doc);
create index search_doc_type on search_doc (type, lifecycle);
