-- Which events have been mailed. The key names the event (assigned:<task>, escalated:<task>, reminder:<task>); claiming it before sending is what keeps one event to one email.
create table notification (
  event_key  text        primary key,
  kind       text        not null,
  recipient  text        not null,
  status     text        not null check (status in ('sent', 'no_recipient')),
  created_at timestamptz not null default now()
);
