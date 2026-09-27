# CCE Ground Truth seed corpus

The runner is a local, deterministic **measurement tool** for comparing analyzer changes. It does not use a model or upload code.

Run from the repository root:

```bash
npm run benchmark
node benchmarks/run.mjs --strict
npm test
```

The first command always reports measured quality; `--strict` exits nonzero for any labeled false positive/false negative. After WP10, the former TS barrel miss and Vue dual-script miss are both resolved. Strict mode now intentionally fails only on the remaining labeled comment/text-extraction false positive; it can become a hard gate after that separate heuristic issue is addressed. The full test suite checks the frozen baseline shape but does not lock timings.

The runner copies each checked-in fixture into a temporary Git repository, indexes it cold, indexes it again unchanged, queries it, inspects SQLite typed edges, reports metrics, then removes the temporary copy. Add a case to `benchmarks/ground-truth.json` with a source fixture directory, a fixed task, relevant file paths and **explicitly labeled positive and negative** (type/from/to) edges.

Metrics:

- TP/FN count labeled positive edges observed/missed; FP/TN count labeled negative edges observed/not observed.
- Precision = TP/(TP+FP); Recall = TP/(TP+FN). Null means no predictions in the labeled universe. **Unlabeled edges are excluded**: scores cannot be extrapolated to the full repository.
- Top-3/Top-5 are counts of relevant selected implementation files; reciprocal rank uses the first relevant file. These alone do not penalize unrelated files or guarantee all relevant files appear.
- Cold/warm indexing and query timings are rough local wall times. Compare on the same machine/runtime, with multiple repetitions for formal performance gates.
- Full/Compact byte counts are minified JSON serialization sizes, not tokenizer-specific token counts.

Current frozen corpus v3 (eleven deliberately small cases):

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

Across v3 labeled facts the measured total is TP=20, FP=1, FN=0 (precision 20/21 and recall 1.0 on this labeled universe only). On the original ten WP9 cases, WP10 changes TP/FP/FN from 16/1/1 to 17/1/0 by fixing the Vue dual-script false negative without adding a labeled false positive. The added component/composable case contributes three more labeled true positives. These tiny fixtures are not product-wide accuracy estimates.

The original six cases remain the WP8-A comparison baseline; WP9 adds TS/JS aliases, re-export conflict and dynamic-import conservatism; WP10 adds compiler-sfc dual-script/setup and component/composable evidence. Later packages should add cross-package Go variants, broader Vue ecosystem cases, constructed SQL, partial project configuration and larger real-repository labels. Freeze each fixture and expected evidence before implementing the corresponding parser change. SGC real-project queries should be version pinned and evaluated separately with permission to use that repository, never checked into CCE as copied source.
