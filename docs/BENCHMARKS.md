# CCE Ground Truth seed corpus

The runner is a local, deterministic **measurement tool** for comparing analyzer changes. It does not use a model or upload code.

Run from the repository root:

```bash
npm run benchmark
npm run benchmark:gate
node benchmarks/run.mjs --strict
npm test
```

`npm run benchmark` always reports measured quality. WP13 adds `benchmark:gate`, which applies the checked-in thresholds from `benchmarks/quality-gate.json` and is the Ubuntu CI quality/performance gate. `--strict` still exits nonzero for any labeled false positive/false negative; it intentionally fails only on the remaining labeled comment/text-extraction false positive. The CI gate therefore freezes FN=0 while allowing at most that one already-labeled FP. The full test suite checks the frozen baseline shape but does not lock exact timings.

The runner copies each checked-in fixture into a temporary Git repository, indexes it cold, indexes it again unchanged, queries it, inspects SQLite typed edges, reports metrics, then removes the temporary copy. Since WP13, the one-time Go helper build is prepared **before** per-case timing so cold-index measurements represent repository analysis rather than helper compilation or dependency setup. Add a case to `benchmarks/ground-truth.json` with a source fixture directory, a fixed task, relevant file paths and **explicitly labeled positive and negative** (type/from/to) edges.

Metrics:

- TP/FN count labeled positive edges observed/missed; FP/TN count labeled negative edges observed/not observed.
- Precision = TP/(TP+FP); Recall = TP/(TP+FN). Null means no predictions in the labeled universe. **Unlabeled edges are excluded**: scores cannot be extrapolated to the full repository.
- Top-3/Top-5 are counts of relevant selected implementation files; reciprocal rank uses the first relevant file. These alone do not penalize unrelated files or guarantee all relevant files appear.
- Cold/warm indexing and query timings are rough local wall times. Compare on the same machine/runtime, with multiple repetitions for formal performance gates.
- Full/Compact byte counts are minified JSON serialization sizes, not tokenizer-specific token counts.

## WP13 CI quality gate

`npm run benchmark:gate` reads `benchmarks/quality-gate.json`. The frozen v5 thresholds are deliberately broad enough for hosted-runner noise while still catching correctness regressions and order-of-magnitude performance/output growth:

- corpus version = 5 and case count = 14;
- TP >= 26, FP <= 1, FN = 0;
- every case must have `warm_changed=0` and `coverage_status=sufficient`;
- relevant Hit@5 ratio >= 0.66;
- Compact output must be smaller than Full, Compact/Full <= 0.50, and total Compact bytes <= 10,000;
- per-case cold index <= 3000 ms, warm index <= 1500 ms, query <= 500 ms.

The performance ceilings are **regression alarms**, not service-level objectives. Compare detailed timings only on the same OS/runtime; CI runs this timing gate on Ubuntu while Windows remains a functional compatibility job.

Current frozen corpus v5 (fourteen deliberately small cases):

| Case | Positive edges found | Negative edges absent | Retrieval | Known limit / purpose |
| --- | ---: | ---: | --- | --- |
| `vue-ts-go-http` | 5/5 | 2/2 | relevant Hit@3 3/3 | Simple page/API/route/call/DB chain |
| `ts-barrel-vue-page` | 1/1 | 1/1 | relevant Hit@3 2/3 | WP9 resolves the re-exported API symbol; Retriever ranking is intentionally unchanged |
| `vue-two-scripts-macro` | 1/1 | 1/1 | relevant Hit@3 2/2 | WP10 parses normal script + script setup without generated-code evidence |
| `go-interface-ambiguity` | 1/1 | 2/2 | relevant Hit@3 1/1 | Two implementations remain unresolved |
| `commented-request-false-positive` | 1/1 | 1/2 | relevant Hit@3 2/2 | One text-pattern false positive remains outside compiler symbol extraction |
| `route-method-ambiguity` | 1/1 unresolved reference | 2/2 | relevant Hit@3 2/2 | Unknown HTTP method remains unresolved with GET and POST routes |
| `ts-path-alias-call` | 2/2 | 1/1 | relevant Hit@3 2/2 | tsconfig paths must select the tracked API target, not same-name noise |
| `js-path-alias-call` | 2/2 | 1/1 | relevant Hit@3 2/2 | jsconfig alias plus renamed JS import |
| `ts-reexport-conflict` | 1/1 unresolved reference | 2/2 | relevant Hit@3 3/4 | Conflicting star re-exports must stay unresolved |
| `dynamic-import-unresolved` | 2/2 unresolved references | 2/2 | relevant Hit@3 2/2 | Dynamic import and calls through its binding stay unresolved with diagnostics |
| `vue-component-composable` | 3/3 | 1/1 | relevant Hit@3 3/3 | Vue component import and unique composable call preserve static evidence |
| `go-packages-types-cross-package` | 3/3 | 1/1 | relevant Hit@3 2/2 | WP11 resolves cross-package function/generic calls while interface dispatch stays unresolved |
| `go-workspace-cross-module` | 1/1 | 1/1 | relevant Hit@3 2/2 | WP13 resolves a tracked dependency through a multi-module `go.work` graph without linking same-name noise |
| `ts-multi-config-isolation` | 2/2 | 2/2 | relevant Hit@5 4/4 | Two project-local tsconfigs use the same alias and must stay isolated |

Across v5 labeled facts the measured total is TP=26, FP=1, FN=0 (precision 26/27 and recall 1.0 on this labeled universe only). WP13 adds one Go workspace cross-module positive plus two TypeScript multi-config positives, with no new labeled false positive. The pre-existing single false positive is still the separate comment/text-pattern case. These small fixtures are not product-wide accuracy estimates.

The original six cases remain the WP8-A comparison baseline; WP9 adds TS/JS aliases, re-export conflict and dynamic-import conservatism; WP10 adds compiler-sfc dual-script/setup and component/composable evidence; WP11 adds package-aware Go function/generic evidence and an interface-dispatch negative control; WP13 adds multi-module Go workspace and multi-config TypeScript isolation. Later packages should add broader build-tag/workspace variants, constructed SQL, partial project configuration and larger real-repository labels. Freeze each fixture and expected evidence before implementing the corresponding parser change. SGC real-project queries should be version pinned and evaluated separately with permission to use that repository, never checked into CCE as copied source.
