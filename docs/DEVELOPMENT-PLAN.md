# CCE Development Plan

Status: **WP8-A through WP17 are merged; WP18 public-release readiness is active.**

Current accepted main baseline before WP18: `f68924463c2408de5e61fb362f838a19397df8ed`. WP18 release target: `v0.2.0`.

The historical untracked `package-lock.json` remains protected and must not be added, deleted or rewritten. Its accepted SHA-256 is `771655d3d1dfa7abfd04a8a86c4b4fe533b6a5521a7951bb976a53678beda710`.

## 1. Current accepted baseline

WP17 is complete. Accepted release-readiness baseline facts:

- package version before WP18: `0.1.7`; WP18 target: `0.2.0`
- main/origin/main: `f68924463c2408de5e61fb362f838a19397df8ed` at WP18 start
- regression suite: 85/85 PASS
- deterministic Ground Truth v6: TP=34, FP=1, FN=0
- Semantic Corpus v1 gate: PASS; OFF/ON MRR 0.1567 → 0.4567
- Public Index v1, SCIP, Plugin Protocol v1, locate and offline graph are merged
- Optional Semantic Provider v1 is merged and explicit opt-in only
- Ubuntu and Windows CI are active release gates

## 2. Current development state

WP18 runs on `work/cce-wp18-release-readiness` from the accepted WP17 main. Its scope is packaging, public documentation, clean-install smoke, release CI, tag and GitHub Release. It does not add new analyzers or retrieval algorithms.

## 3. Environment and subsequent sync gates

Before future packages: compare GitHub main, local main and origin/main, inspect `git status --short --branch`, run `git fetch --prune origin`, then compare `git rev-list --left-right --count main...origin/main`. Only fast-forward a clean main when the remote is confirmed. Preserve any unrelated local files.

Ubuntu: `/opt/CCE/code-context-engine`, Node 22.22.1, Go 1.26.0. CI uses Node 22 / Go 1.25.x; record compatibility differences. Windows: historical clone `D:/Tools/code-context-engine`, **not checked this turn**. After a WP merge, synchronize each clone safely, run `npm test` and `npm run benchmark`, record the commit and results. No reset/clean of unknown work.

## 4. Revised engineering sequence (2026-09-27)

This sequence supersedes the earlier ordering that placed the first accuracy corpus at WP14. WP8-A through WP17 are merged. The conditional WP12 SSA/callgraph gate remains deferred because the frozen corpus has no labeled false negative requiring SSA. WP18 is the active release-readiness package; analyzer changes remain out of scope unless a release blocker is proven.

| Package | Goal and scope | Non-goals / dependency | Acceptance and risk |
| --- | --- | --- | --- |
| WP8-A | Check in labeled positive and negative graph facts, query relevance, a reproducible runner and timing/output measurements. The seed includes Go ambiguity, TS barrel, Vue dual-script, route ambiguity and comment false positives; later expand JS aliases, dynamic import and real-repo labels. | No parser/retriever changes; baseline v0.1.7. | Reproducible edge precision/recall over *labeled facts*, Top-K/MRR, cold/warm index, query time and bytes; risk: a tiny corpus overstates quality. |
| WP8-B | Internal language analyzer contract with dispatch, fact provenance, diagnostics, partial results and analyzer-specific invalidation. Wrap existing analyzers. | No public stable plugin ABI or new language; WP8-A baseline. | All 39 baseline regression tests and frozen query baselines remain compatible; failure does not silently become an empty successful analysis. Risk: symbol IDs and schema migration. |
| WP9 | TS/JS TypeScript Compiler API **and module resolution together**: Program/TypeChecker, tsconfig/jsconfig aliases, re-exports and barrels. | Do not retune Retriever; WP8-B. | Improve labeled import/call and retrieval results without an unreviewed false-positive increase; compare index cost. Risk: config gaps and memory. |
| WP10 | Vue compiler-sfc, both script blocks, script setup macros and page/component/composable evidence. | Not every Vue ecosystem convention; WP9. | Ground-truth SFC cases and real project flow comparison. Risk: source maps and template semantics. |
| WP11 | Go go/packages and go/types for cross-package calls, method sets, generics and interface evidence. | No SSA yet; WP8-B. | Compare correct/incorrect/unresolved edges and cost against the Go baseline. Risk: build tags and unavailable dependencies. |
| WP12 | Conditional Go SSA/callgraph pilot when WP11 measurement shows a worthwhile gap. | No claim of unique runtime dispatch for a possible target; WP11. | Explicit precision/cost gate for DI and multiple implementations. Risk: graph explosion. |
| WP13 | Larger multi-project corpus and quality/performance CI gates. | The first baseline is already WP8-A; WP9-12. | Repeatable results across supported OSes, documented regression thresholds. |
| WP14 | CLI, job, consumer and queue entry points and non-HTTP feature flows. | Preserve implemented HTTP flows; reliable facts first. | Ground-truth trace from entry to data and tests. |
| WP15 | SCIP, stable public schema and third-party plugin API design. | Do not freeze public ABI before multiple analyzers. | Versioned consumer compatibility and migration samples. |
| WP16 | IDE and graph visualization prototypes. | Depends on WP15. | Navigable code and evidence. |
| WP17 | Optional semantic providers only: versioned local process protocol, bounded reranking and explicit opt-in. | No required LLM, embedding, vendor SDK, source upload or provider-owned graph facts. | Provider-disabled baseline stays compatible; provider OFF/ON retrieval benefit, latency and fallback behavior are measured. |
| WP18 | First public release readiness: npm package surface, public docs, clean-install smoke, release CI, tag and GitHub Release. | No analyzer/retriever feature expansion. | Reproducible v0.2.0 tarball, Ubuntu/Windows PASS, post-merge verification and release artifacts. |

Benchmark usage and labeling limits: [BENCHMARKS.md](BENCHMARKS.md). The implemented internal boundary is documented in [ANALYZER-CONTRACT.md](ANALYZER-CONTRACT.md). The current small corpus is a **seed baseline**, not a completed multi-language accuracy claim. The originally proposed WP11 module-resolution work is merged into WP9; the originally proposed WP14 benchmark starts in WP8-A. Keep one bounded branch per package and record measured evidence in the PR.
## 5. Language expansion policy

CCE is a multi-language engine, not a Go/TypeScript/Vue-only product.

The intended model is:

```text
Native parser/compiler/type system
            ↓
Language Analyzer Adapter
            ↓
Normalized CCE Facts
            ↓
Typed Graph
            ↓
Traversal / Retrieval
            ↓
Full / Compact
            ↓
CLI / MCP / Agents
```

Candidate future adapters, after WP8 stabilizes the contract:

1. Java
2. Python
3. C# / C / C++ / Rust
4. Kotlin / PHP / Ruby / Swift / Dart and others

The core graph/retrieval layer should not need per-language conditionals for each new adapter.

## 6. Branch and work-package policy

For each substantial work package:

1. start from synchronized, clean `main`,
2. create one bounded task branch,
3. keep scope limited to the current WP,
4. run the relevant regression/benchmark gates,
5. open a GitHub PR,
6. merge only after acceptance,
7. sync the development clone back to `main`,
8. delete completed task branches when safe,
9. record final evidence in the work-package documentation/tracker.

Avoid accumulating unnecessary long-lived branches.

## 7. Next action

Finish WP18 packaging/docs/release gates, merge on accepted main, verify the v0.2.0 tarball, create the v0.2.0 tag and GitHub Release, then start the next feature package from that release baseline.
