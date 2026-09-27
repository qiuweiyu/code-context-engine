# CCE v0.2.0 Release Checklist

Target: the first public installable release of Code Context Engine.

## Release principle

WP18 is release-readiness work, not a feature expansion.
The deterministic core remains the default; Semantic Provider v1 remains explicit opt-in.

## Package gate

- [x] npm package name was unused at WP18 start (`npm view code-context-engine` returned E404).
- [x] package metadata points to the public GitHub repository.
- [x] npm tarball excludes tests, benchmarks and CI workflow files.
- [x] npm tarball includes CLI/MCP runtime, Go helpers, public docs and schemas.
- [x] clean install from the generated tarball succeeds.
- [x] `cce --help` succeeds from the installed tarball.
- [x] `code-context-engine --help` succeeds from the installed tarball.
- [x] installed package can index, query and inspect status for a temporary Git repository.
- [x] installed MCP entrypoint starts under an authorized `CCE_ALLOWED_ROOTS`.

## Documentation gate

- [x] README / README-ZH describe current v0.2.0 capabilities rather than old milestones.
- [x] npm-first installation is the primary public path.
- [x] Quick Start provides a reproducible 5–10 minute workflow.
- [x] supported languages and limitations are explicit.
- [x] deterministic default and optional Semantic Provider v1 are explicit.
- [x] MCP example is current.
- [x] flow / locate / graph-html / export-scip commands are discoverable.
- [x] privacy and security boundaries are current.
- [x] CHANGELOG contains the v0.2.0 release entry.

## Quality gate

- [x] `npm test` passes.
- [x] deterministic `benchmark:gate` passes.
- [x] `benchmark:semantic:gate` passes.
- [x] `npm run release:smoke` passes.
- [ ] Ubuntu CI passes.
- [ ] Windows CI passes.
- [x] protected historical `package-lock.json` remains untracked and unchanged.

## Release gate

- [ ] WP18 PR is merged by squash.
- [ ] Ubuntu `main == origin/main`.
- [ ] post-merge release verification passes.
- [ ] tag `v0.2.0` points to the accepted main commit.
- [ ] GitHub Release `v0.2.0` is published.
- [ ] release branch is deleted locally and remotely.
- [ ] Linear SGC-73 is Done.

## npm publication

The Ubuntu environment was not authenticated to npm at WP18 start:
`npm whoami` returned `ENEEDAUTH`.

Do not store npm credentials in the repository or issue comments.
After every other gate passes, npm publication is the only allowed manual step
if authentication is still unavailable:

```bash
npm login
npm publish
```

`publishConfig.access=public` is set in `package.json`.
