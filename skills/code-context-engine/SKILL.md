# Code Context Engine Agent Skill

Use Code Context Engine before broad repository reading when a local project is indexed.

1. Run `context_index_repo` when the index is missing or stale.
2. Run `context_query` with the concrete coding/debugging task.
3. Read `must_read` source first, then `maybe_read` only when needed.
4. Treat `features[].status=needs_review` as a warning that the implementation changed after the feature definition was reviewed.
5. Treat `features[].status=stale` as unreliable; inspect the source and repair the feature definition before depending on it.
6. Use returned callers, callees, routes, data objects, and tests to expand context deterministically instead of scanning the whole repository.
7. Never infer that a missing result proves a feature does not exist. Search symbols/routes/files before creating a duplicate implementation.
8. Code Context Engine is static analysis, not proof of runtime behavior. Dynamic dispatch, reflection, generated code, and configuration-driven wiring may be incomplete.
