# 0014. Shared authorization library (F4, without SSO)

Status: accepted. SSO login and token checks (the corporate part of F4) are deferred by the owner.

## Decision
- `Authz` in `@dmc/platform` implements docs/access-control.md. Roles, rules and the permission matrix are data in `config/authz.yaml`, validated at load (unknown roles or rules, broken CEL and non-boolean rules fail).
- Roles come from IdP groups (`dmc-steward-<domain>`, `dmc-control-owner-<control>` carry a parameter). Everyone signed in is a Viewer. Application Owner is granted by data: the module passes the owners it resolved from the catalog.
- Attribute rules are CEL over `principal` and `object` facts. The library never reads the catalog; the module resolves the facts. A rule whose fact is missing does not grant.
- Restrictions apply whatever the role: synced fields, locked objects, separation of duties (`sod` actions). Evidence cannot be edited because no such action exists.
- A decision carries `subject`, optional `agent`, `role`, `rule` and a plain reason, so the caller can write it to the ledger, denials included.
- Non-human callers: a service account may do only actions marked `service` with its registered scope. An agent acting for a person needs `dmc.read` or `dmc.propose` and is limited to what that person may do.
- Test helpers (`person`, `service`, `agentFor`) build principals without an IdP.

## Not done (needs the corporate environment)
OIDC/SAML login, token verification in the gateway, and reading groups from the token. They only have to produce a `Principal`.

## Dependency
`@marcbachmann/cel-js` is now also a dependency of `@dmc/platform` (already used by policy and workflow).
