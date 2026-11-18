# 0027. Sync: null clears, cursor and limit rules, unlink before link, deprecated persons

Status: accepted (fixes from an independent review; extends 0013, 0018, 0024, 0026).

## 1. A value the source clears is cleared
- The job mapping turns a NULL column into an explicit `null` (part of the record hash). A blank string in a plain mapped field is treated the same way. A field the record does not contain at all is still skipped. A value-mapped field with NULL is `null`; a blank string there still needs an entry in the map.
- `CatalogStore.applyNode` treats `null` from a sync writer as "clear this attribute": on an update the attribute and its provenance are removed; on a create it is "not set" (an open legal hold has no end date: no error, nothing written); a required attribute cannot be cleared and the record is refused. Ownership of the cleared name is still checked. Writes by people are unchanged.
- Effect: a delegate removed in ServiceNow, or a scope whose owner is blanked, loses access on the next run. A scope with no owner raises `scope.owner_unknown` as before.
- Edge attributes: a NULL is part of the hash but is not sent as an attribute, so clearing one re-describes the edge without it.
- One-time effect: records that have a NULL in a mapped column get a new hash, so the first run after this change reports them as `updated` (and counts them against `max_changes_pct`). Raise or approve once if a job trips its limit.

## 2. The cursor never moves past a row that did not map
An incremental run with `errors > 0` (missing key, value not in a value map, incomplete edge end) keeps its cursor, as a run with refused records already did (0024). The rows are read again until the source or the mapping is fixed; unchanged ones are skipped by hash. A paused run holds no pending cursor in that case.

## 3. Refused records are not counted as changes again
The run stores the keys the catalog refused (`connectors.run.refused_keys`, migration 0002). The next run does not count those keys as changes for `max_changes_pct` (a refused "created" record is "created" again each run, while the divisor excludes it). Everything else counts as before, so a real mass change still pauses the job. The first load is still never limited.

## 4. Unlink before link
Within one commit, `missing` records (`sync.unlink`, `sync.missing`) go before created/updated ones. An owner transfer on a many-to-one edge (`owned_by`, `stewarded_by`) is applied in one run. Deprecation still happens only for a complete full run; only the order of delivery changed. In an incremental job nothing is unlinked, so a transfer there still needs a full run.

## 5. Deprecated persons
- The duplicate-email refusal for a Person upsert ignores deprecated holders: a new hire may reuse a leaver's email.
- Email to staff ID resolution prefers an active Person; a deprecated one is used only when no active Person has the email (ownership is not silently lost). Two active (or, absent any active, two deprecated) holders are still ambiguous.
- `ScopeOwnerCheck` is unchanged: the owner decided that a deprecated owner is a visible flag in the web app for now, not an exception.

## 6. `sync.missing` respects the source of truth
`CatalogIngest` refuses a `sync.missing` (reported through `onReject`, key in `rejected`) when the type's former owners include the job's source, like link and unlink already did. A type switched to `dmc` is not deprecated by a Collibra job that is still enabled.
