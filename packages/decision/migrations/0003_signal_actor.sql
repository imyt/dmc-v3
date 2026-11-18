-- who sent it, so a decision carried out later (by the worker) is attributed to the sender, not to the system
alter table signal add column actor text;
