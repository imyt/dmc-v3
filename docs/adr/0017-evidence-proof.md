# ADR 0017: Evidence trace and proof export

Status: accepted. Date: 2026-11-18. Closes task E4.

## Decision
- A node is traced by every name the ledger knows it by: `node/<id>` (catalog events) and `<Type>:<qualified name>` (signals, decisions, actions, exceptions). Entries are read oldest first, with a cursor on `seq`.
- A proof is a JSON bundle with the entries about the node, `payloadHash`, `prevHash` and `hash` for each, the `payloadHash` and `hash` of every ledger entry between the first and last of them, the hash that precedes that run, and the ledger head at export time.
- `verifyProof` needs no database: it recomputes every entry's payload hash, every chain link from the one before, and checks each entry sits on that chain. Any edit to an entry, a link or the anchor fails.
- The head in the bundle is what an auditor compares with the audit database copy (E2); until E2 exists the proof shows internal consistency only.
- Export is limited to 200,000 ledger entries between first and last; a wider span is a 422 asking for a narrower request.
- Endpoints (`read_evidence`: auditor, admin, and control owners where the rule passes): `GET /v1/nodes/{qn}/evidence`, `GET /v1/nodes/{qn}/evidence/proof`, `GET /v1/evidence/verify`.

## Consequences
- A proof shows that entries are genuine and in order. It does not by itself show that no entry is missing; completeness comes from the live trace, whose counts an auditor can compare.
- The API process needs a read connection as the evidence role.
