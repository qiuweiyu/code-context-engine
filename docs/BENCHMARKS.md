# CCE Ground Truth seed corpus

The runner is a local, deterministic **measurement tool** for comparing analyzer changes. It does not use a model or upload code.

Run from the repository root:

```bash
npm run benchmark
node benchmarks/run.mjs --strict
npm test
```

The first command always reports measured quality; `--strict` exits nonzero for any labeled false positive/false negative. Strict mode is expected to fail on the v0.1.7 barrel case and should become a gate after the relevant analyzer work. The full test suite checks the baseline shape and known miss; it does not lock timings.

The runner copies each checked-in fixture into a temporary Git repository, indexes it cold, indexes it again unchanged, queries it, inspects SQLite typed edges, reports metrics, then removes the temporary copy. Add a case to `benchmarks/ground-truth.json` with a source fixture directory, a fixed task, relevant file paths and **explicitly labeled positive and negative** (type/from/to) edges.

Metrics:

- TP/FN count labeled positive edges observed/missed; FP/TN count labeled negative edges observed/not observed.
- Precision = TP/(TP+FP); Recall = TP/(TP+FN). Null means no predictions in the labeled universe. **Unlabeled edges are excluded**: scores cannot be extrapolated to the full repository.
- Top-3/Top-5 are counts of relevant selected implementation files; reciprocal rank uses the first relevant file. These alone do not penalize unrelated files or guarantee all relevant files appear.
- Cold/warm indexing and query timings are rough local wall times. Compare on the same machine/runtime, with multiple repetitions for formal performance gates.
- Full/Compact byte counts are minified JSON serialization sizes, not tokenizer-specific token counts.

Current frozen seed (six deliberately small cases):

| Case | Positive edges found | Negative edges absent | Retrieval | Known limit |
| --- | ---: | ---: | --- | --- |
| `vue-ts-go-http` | 5/5 | 2/2 | relevant Hit@3 3/3 | A deliberately simple page/API/route/call/DB chain |
| `ts-barrel-vue-page` | 0/1 | 1/1 | relevant Hit@3 2/3 | Current regex analyzer loses a re-exported page API link |
| `vue-two-scripts-macro` | 0/1 | 1/1 | relevant Hit@3 2/2 | First-script-only extraction misses setup call |
| `go-interface-ambiguity` | 1/1 | 2/2 | relevant Hit@3 1/1 | Two implementations remain unresolved |
| `commented-request-false-positive` | 1/1 | 0/2 | relevant Hit@3 2/2 | Comment creates one phantom API edge and one phantom DB edge |
| `route-method-ambiguity` | 1/1 unresolved reference | 2/2 | relevant Hit@3 2/2 | Unknown HTTP method remains unresolved with GET and POST routes |

The six cases provide a WP8-A seed baseline. Later packages should add cross-package Go variants, JS/TS aliases and dynamic imports, more Vue macros, constructed SQL and partial project configuration. Freeze each fixture and expected evidence before implementing the corresponding parser change. SGC real-project queries should be version pinned and evaluated separately with permission to use that repository, never checked into CCE as copied source.
