# Contributing

Thanks for helping improve Code Context Engine.

## Development principles

1. Core indexing must work without an LLM or cloud service.
2. Prefer compiler/native language APIs over regex when practical.
3. Do not silently present heuristic edges as compiler-proven facts.
4. Generated index data must be reproducible from source.
5. Source-code privacy is a first-class requirement.
6. A parser change that affects exported facts should update the parser/schema version and tests.

## Local setup

Requirements:

- Node.js 22.13+
- Git
- Go for Go analyzer tests

```bash
npm install
npm test
```

## Pull requests

Keep changes focused. Include tests for parser or freshness behavior. If a change alters the index schema, describe migration/backward-compatibility impact in the PR.

## Adding a language analyzer

A language analyzer should return deterministic facts:

- symbols,
- signatures,
- source line ranges,
- imports/dependencies,
- calls where resolvable.

Avoid embedding network access in analyzers.
