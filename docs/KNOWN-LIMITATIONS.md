# Known limitations — v0.2.0

CCE v0.2.0 is a static-analysis and retrieval tool. It is intentionally conservative.

## Supported analyzers

Supported in v0.2.0:

- Go
- TypeScript
- JavaScript
- Vue SFC
- lightweight HTTP / SQL / test / entry-point extraction around those ecosystems

Not yet first-class analyzers:

- Java
- Python
- C / C++
- C#
- Rust
- Kotlin, PHP, Ruby, Swift, Dart and other ecosystems

Those languages may still appear as files in a repository, but v0.2.0 does not claim equivalent symbol/call analysis for them.

## Static-analysis limits

CCE does not claim to reconstruct all runtime behavior.

Reflection, runtime dependency injection, dynamic dispatch, generated code, configuration-driven wiring, eval-like behavior and highly dynamic imports may stay unresolved.

An unresolved edge is intentionally not traversed as if it were proven.

TypeScript/JavaScript framework registrations and queue/event flows are recognized only where bounded static patterns are implemented.

Go projects get stronger type evidence when the local Go toolchain can load packages successfully; AST facts remain available when type loading is incomplete.

## Retrieval limits

The deterministic retriever depends on indexed facts, names, aliases and graph evidence.
A query miss does not prove that a feature does not exist.

Semantic Provider v1 cannot introduce a file that deterministic retrieval did not already place in its bounded candidate set.
It improves ordering, not fact discovery.

## Platform and scale

CI currently validates Ubuntu and Windows.

macOS CI is not yet part of the release gate.

The checked-in quality corpus is deliberately small and labeled; its precision/recall numbers describe that corpus only, not every real repository.

A dedicated large-monorepo incremental benchmark is still future work.

Node.js 22 may print an ExperimentalWarning for the built-in `node:sqlite` module. The warning itself is not a CCE failure.

## Public compatibility boundary

Public Index v1, SCIP export and versioned public protocols are intended integration boundaries.

Internal SQLite tables and internal JSONL layout are implementation details and may evolve.

See [INTEROPERABILITY.md](INTEROPERABILITY.md) for the public compatibility rules.
