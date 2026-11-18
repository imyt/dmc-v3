# ADR 0007 — CEL library and policy compile

Status: accepted (task P1)

Decision: use `@marcbachmann/cel-js` (zero dependencies, CEL spec subset with a type-checking `Environment`, an AST we can walk) for policy conditions. `ajv` and `yaml` are already approved. Compilation lives in `@dmc/policy`; the metamodel registry moved to `@dmc/platform` (its stated home) so modules can read it without importing `@dmc/catalog`.

Compile checks: JSON Schema; scope type and concept exist; the CEL expression parses, uses only the asset variable (the snake-case type name, e.g. `data_product`) and `now`, and returns a boolean; every attribute or edge it reads exists on the scope type; `set_attribute` targets only `dmc`-sourced attributes; `raise_exception` has a route; file name equals the policy slug.

Evaluation: a missing attribute is an error result, not a silent false, so authors guard with `has(...)`. The golden harness requires, per policy, one case that matches and one that does not.

Edge names in conditions are the metamodel's (`integration.transfers`), not the illustrative `integration.datasets` in the system design.

Alternatives: `cel-js` (older, 0.x), a hand-rolled expression language (more to maintain, harder for agents to write correctly).
