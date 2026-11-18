# DMC — Access Control (RBAC/ABAC)

Nov 17, 2026

## Model

Roles decide *what* someone can do; attributes from the catalog decide *on which objects*. A request is allowed only when a role grants the action and every attribute rule for that object passes.

- **Deny by default.** No role, no access. Everything not granted is refused with a reason.
- **Roles come from IdP groups.** DMC stores no role assignments of its own; joiners and leavers are handled in the IdP.
- **Attributes come from the catalog.** Ownership, stewardship and scope ownership are edges in the metamodel, so access follows the data as it changes.
- **Read is broad, write is narrow.** DMC holds metadata only, so most metadata is readable by any signed-in user; writes are limited to owners of the object.
- **Synced fields are read-only for everyone.** A change to a field owned by another tool becomes a task for that tool.
- **Separation of duties.** Nobody approves their own request, merges their own policy, or edits evidence.
- **Every write and every denied write is recorded** in the ledger with the role and rule that decided it.

## Roles

Nine roles. A person can hold several; permissions add up, but separation-of-duties rules still apply per object.

| Role | Who | IdP group (placeholder) |
| --- | --- | --- |
| Viewer | Any signed-in employee | None: any user signed in through SSO |
| Application Owner | Owner or delegate of an application in ServiceNow | Derived from ServiceNow ownership; no group needed |
| Data Steward | Steward for one or more Data Domains | `dmc-steward-<domain>` |
| Scope Owner | Owner of a regulatory report or business process scope | `dmc-scope-owner` |
| Policy Author | Writes policies from operating instructions and TCRs | `dmc-policy-author` |
| Control Owner | Accountable for a control type (for example data movement, privacy) | `dmc-control-owner-<control>` |
| Auditor | Internal audit, second line | `dmc-auditor` |
| Platform Admin | Runs DMC: sync jobs, metamodel, kill switches | `dmc-platform-admin` |
| Service Account | Non-human callers: sync jobs, scripts, coding agents | Registered client in the IdP |

Application Owner is the one role granted by data rather than by group: anyone ServiceNow lists as owner or delegate of an application holds it for that application only.

## Permission matrix

**Yes** = on any object; **Own** = only on objects the attribute rules give them (next section); blank = not allowed. Service accounts get only what their registered scopes allow.

| Action | Viewer | App Owner | Steward | Scope Owner | Policy Author | Control Owner | Auditor | Admin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Search and read catalog metadata | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Edit DMC-owned fields on an asset (description, domain) |  | Own | Own |  |  |  |  |  |
| Create and edit Datasets; link them to columns |  | Own |  |  |  |  |  |  |
| Link Business Elements to tables and columns |  | Own |  |  |  |  |  |  |
| Create, submit and amend Scopes |  |  |  | Own |  |  |  |  |
| Edit glossary: terms, categories, domains (after cutover) |  |  | Own |  |  |  |  |  |
| Accept or reject a classification proposed along lineage (columns with no domain: any steward) |  |  | Own |  |  |  |  | Yes |
| Decide an exception or workflow task assigned to them |  | Own | Own | Own |  | Own |  |  |
| Write policies in the editor (opens a pull request) |  |  |  |  | Yes | Own |  |  |
| Sign off a policy in UAT (the DMC platform team then merges) |  |  |  |  |  | Own |  |  |
| Pause a policy or use its kill switch |  |  |  |  |  | Own |  | Yes |
| Pause or resume all enforcement; see versions and what is running |  |  |  |  |  |  |  | Yes |
| Create and edit Control Requirements |  |  |  |  | Yes | Own |  |  |
| Read evidence, verify the ledger, export proof |  |  |  |  |  | Own | Yes | Yes |
| Run, pause and view sync jobs |  |  |  |  |  |  |  | Yes |
| Review and merge metamodel changes |  |  |  |  |  |  |  | Yes |
| Change role-to-group mapping |  |  |  |  |  |  |  | Yes (via config merge) |
| Create or revoke scope delegations |  |  |  | Own |  |  |  |  |

## Attribute rules (ABAC)

Each "Own" in the matrix is one of these rules, written in CEL like policies and evaluated against the catalog.

| Rule | Grants "Own" when | Example |
| --- | --- | --- |
| Application ownership | The user is the owner or one of the two delegates of the Application (set in ServiceNow), and the object is that Application or reached from it (its Systems, Tables, Columns, Integrations, Datasets) | An app owner links their own datasets to their own columns, not another app's |
| Domain stewardship | The user is in the steward group of the object's Data Domain | A Payments steward edits Payments terms only |
| Scope ownership | The user owns the Scope (owner synced from the source system) or holds an active delegation for it in DMC | A PRA110 owner amends PRA110 only |
| Control ownership | The user is in the control owner group for the policy's or evidence's control type | The privacy control owner merges privacy policies only |
| Assignment | The workflow task or exception is assigned to the user or their group | Only the assignee decides an exception |

**Rules that restrict, whatever the role**

| Rule | Effect |
| --- | --- |
| Synced fields | Fields whose source of truth is another tool cannot be edited; the edit becomes a task for that tool |
| Locked scopes | A submitted Scope is read-only; changes need an amendment, which creates a new version |
| Separation of duties | Nobody approves their own request, decides an exception they raised, or merges a pull request they opened |
| Evidence is append-only | No role, including Admin, can change or delete ledger entries |
| Environment | In production, writes come only through the UI and API; no direct database access for any role |

All metadata is readable by every signed-in user; there are no read restrictions.

## Delegation and scope approvals

**Application delegates** live in ServiceNow, two per application, and sync into DMC. DMC does not edit them.

**Scope delegates** live in DMC, because the systems that hold scopes and their owners have no delegates. A delegation records:

| Field | Meaning |
| --- | --- |
| Owner, delegate | Who grants and who receives |
| Covers | One scope, or all of the owner's scopes |
| Rights | Prepare and submit on the owner's behalf |
| Valid from, valid to | At most 12 months; expires on its own, with a reminder 14 days before |
| Reason | Free text, kept as evidence |

Only the owner creates or revokes a delegation. A delegate cannot re-delegate. Every delegation ends when the source system changes the owner. Each change is recorded in the ledger.

**Scope submission**

1. The owner or a delegate prepares and submits the scope: groups, business elements, source-to-target flows. Submission locks it; there is no separate approval step.
2. Once locked, each app owner on the scope's flows gets one task to link their tables and columns; each confirmed link is that app owner's attestation.
3. The scope shows as complete when every business element has confirmed links. Overdue link tasks escalate per policy.
4. An amendment follows the same path and creates a new version. Only app owners affected by the change get new link tasks.

## Service accounts and coding agents

Non-human callers are registered clients in the IdP with narrow scopes. They never get a human role.

| Caller | Scopes | Notes |
| --- | --- | --- |
| Sync jobs (inside DMC) | `dmc.signal.write` for their own source | Writes become signals; policy decides what applies |
| Fabric | `dmc.read` | Read-only: trust, ownership, classification, lineage |
| Scripts and coding agents acting for a person | `dmc.read`, `dmc.propose` | Act on behalf of a named user; the user's attribute rules apply, and both identities are logged |
| Coding agents writing policies | None in DMC | They open pull requests in the policy repo; the merge rules there decide |

An agent can never do more than the person it acts for, and its writes always go through the signal and policy path, so low-risk or repeatable changes auto-apply and the rest go to review.

## Enforcement and audit

1. **Login.** OIDC/SAML through the existing IdP. The token carries the user's groups; DMC maps groups to roles from a config file in the repo.
2. **Gateway check.** Every request is checked for role and action before it reaches a module.
3. **Module check.** The module re-checks the attribute rules against the catalog, because only it knows the object. Both checks use one shared authorization library, so the rules are written once.
4. **UI.** Screens receive the allowed actions per object from the API and hide what the user cannot do; the API stays the real gate.
5. **Audit.** Every write records the user, any agent acting for them, the role and the rule that allowed it. Denied writes are logged too. Auditors can see who could do what on any date, because roles and ownership are bitemporal.

Role-to-group mapping and attribute rules are config in the repo, so they change only by merge, like policies.

## Open questions

- [ ] Map roles to existing IdP groups or create new ones (later).
