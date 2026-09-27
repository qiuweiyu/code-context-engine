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

## CI quality gate

`npm run benchmark:gate` reads `benchmarks/quality-gate.json`. WP13 introduced the gate; WP14 advances the frozen corpus to v6 while keeping the same deliberately broad hosted-runner performance ceilings:

- corpus version = 6 and case count = 16;
- TP >= 34, FP <= 1, FN = 0;
- every case must have `warm_changed=0` and `coverage_status=sufficient`;
- relevant Hit@5 ratio >= 0.66;
- Compact output must be smaller than Full, Compact/Full <= 0.50, and total Compact bytes <= 10,000;
- per-case cold index <= 3000 ms, warm index <= 1500 ms, query <= 500 ms.

The performance ceilings are **regression alarms**, not service-level objectives. Compare detailed timings only on the same OS/runtime; CI runs this timing gate on Ubuntu while Windows remains a functional compatibility job.

## Optional semantic-provider evaluation

WP17 adds a separate Semantic Corpus v1. It does **not** replace or mutate Ground Truth v6 and it does not change the graph TP/FP/FN universe.

Run:

```bash
npm run benchmark:semantic
npm run benchmark:semantic:gate
```

The semantic corpus uses `benchmarks/fixtures/semantic-paraphrase` plus the evaluation-only local process `benchmarks/providers/semantic-reference.mjs`. The reference provider is deterministic, requires no network/model/API key, and exists only to verify that the optional provider contract can produce measurable bounded reranking gains. It is not a claim about any production model or embedding system.

The five frozen queries deliberately share a broad lexical `service` anchor while expressing the target behavior through paraphrases. Their relevant files start at deterministic ranks 3, 4, 5, 6 and 7. With `maxFiles=5`, the first three are selected by deterministic retrieval while the last two are outside the final selection. The semantic provider may rerank only the deterministic candidate pool and is still limited by the Protocol v1 semantic weight cap of 0.35.

Semantic metrics:

- Hit@1/3/5 count cases whose relevant file appears within that selected prefix.
- MRR averages reciprocal rank of the first relevant selected file; a missing relevant file contributes zero.
- `selected_relevant` counts relevant files surviving final selection.
- Query timing reports the median of three OFF and ON runs per case. ON includes local provider-process startup, so it is expected to be slower.
- Full/Compact bytes measure the minified response size. Provider OFF remains the original deterministic output shape; Provider ON adds bounded semantic status/debug metadata.

`benchmarks/semantic-quality-gate.json` currently requires:

- corpus version 1 and 5 cases;
- provider applied in all 5 cases;
- ON Hit@5 = 5/5;
- Hit@3 improvement >= 2 cases;
- selected relevant improvement >= 2;
- MRR improvement >= 0.25;
- total Compact byte increase <= 600 bytes;
- average ON median query latency <= 500 ms on the Ubuntu quality-gate runner.

The first frozen Stage 5 measurement on the Ubuntu development machine produced:

| Metric | Provider OFF | Provider ON | Delta |
| --- | ---: | ---: | ---: |
| Hit@1 cases | 0/5 | 1/5 | +1 |
| Hit@3 cases | 1/5 | 3/5 | +2 |
| Hit@5 cases | 3/5 | 5/5 | +2 |
| Selected relevant | 3 | 5 | +2 |
| MRR | 0.1567 | 0.4567 | +0.3000 |
| Avg median query latency | ~2.6 ms | ~115 ms | ~+112 ms |
| Compact bytes total | 3175 | 3568 | +393 |

The latency values are machine-specific observations, not a release SLA. The quality gate intentionally leaves a broad ceiling. Most importantly, the existing deterministic Ground Truth v6 gate remains TP=34, FP=1, FN=0 and `compact_bytes=6243`, so optional semantic evaluation does not redefine graph correctness.


Current frozen corpus v6 (sixteen deliberately small cases):

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
| `go-non-http-entry-flow` | 6/6 | 2/2 | relevant Hit@5 1/1 | WP14 traces Go CLI, cron job and consumer entries through handlers into call/DB facts |
| `ts-non-http-entry-flow` | 2/2 | 2/2 | relevant Hit@5 1/1 | WP14 resolves TS scheduled/queue handlers and ignores commented pseudo-registrations |

Across v6 labeled facts the measured total is TP=34, FP=1, FN=0 (precision 34/35 and recall 1.0 on this labeled universe only). WP14 adds eight labeled non-HTTP entry-flow positives and four negative controls with no new labeled false positive. The pre-existing single false positive is still the separate comment/text-pattern case. These small fixtures are not product-wide accuracy estimates.

The original six cases remain the WP8-A comparison baseline; WP9 adds TS/JS aliases, re-export conflict and dynamic-import conservatism; WP10 adds compiler-sfc dual-script/setup and component/composable evidence; WP11 adds package-aware Go function/generic evidence and an interface-dispatch negative control; WP13 adds multi-module Go workspace and multi-config TypeScript isolation; WP14 adds CLI/job/consumer entry-handler flows. Later packages should add broader build-tag/workspace variants, constructed SQL, partial project configuration and larger real-repository labels. Freeze each fixture and expected evidence before implementing the corresponding parser change. SGC real-project queries should be version pinned and evaluated separately with permission to use that repository, never checked into CCE as copied source.
