# ADR 0002 — Metamodel registry dependencies

Status: accepted (task M1)

Context: types are YAML files in `metamodel/types/`, validated by a JSON Schema in CI (Metamodel doc, "Type definition format").

Decision: add `yaml` (parser) and `ajv` (JSON Schema 2020-12 validator) to `@dmc/catalog`. Both are widely used, have no native code, and run in Node 22.

Consequences: the registry loader stays small; the schema file is the contract for type authors and coding agents. Cross-type checks (parents, edge targets, inheritance) are code, not schema.
