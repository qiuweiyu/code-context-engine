const MUST_READ_SYMBOL_LIMIT = 6;
const MAYBE_READ_SYMBOL_LIMIT = 3;

function symbolHint(symbolId) {
  if (typeof symbolId !== "string" || symbolId.length === 0) return null;
  const separator = symbolId.indexOf("::");
  return separator >= 0 ? symbolId.slice(separator + 2) : symbolId;
}

function symbolHints(symbolIds, limit) {
  const hints = [];
  const seen = new Set();
  for (const symbolId of symbolIds ?? []) {
    const hint = symbolHint(symbolId);
    if (!hint || seen.has(hint)) continue;
    seen.add(hint);
    hints.push(hint);
    if (hints.length >= limit) break;
  }
  return hints;
}

function compactFile(entry, symbolLimit) {
  return {
    path: entry.path,
    score: entry.score,
    symbols: symbolHints(entry.symbols, symbolLimit)
  };
}

export function projectQueryOutput(result, { compact = false } = {}) {
  if (!compact || !result?.ok) return result;

  const coverage = result.coverage ?? {};
  return {
    ok: true,
    task: result.task,
    coverage: {
      status: coverage.status,
      candidate_files: coverage.candidate_files,
      selected_files: coverage.selected_files
    },
    retrieval_mode: result.query_expansion?.retrieval_mode ?? null,
    must_read: (result.must_read ?? []).map((entry) =>
      compactFile(entry, MUST_READ_SYMBOL_LIMIT)
    ),
    maybe_read: (result.maybe_read ?? []).map((entry) =>
      compactFile(entry, MAYBE_READ_SYMBOL_LIMIT)
    ),
    tests: [...(result.tests ?? [])],
    semantic_refinement_recommended: Boolean(result.semantic_refinement_recommended)
  };
}

export function serializeQueryOutput(result, { compact = false } = {}) {
  return JSON.stringify(
    projectQueryOutput(result, { compact }),
    null,
    compact ? 0 : 2
  );
}
