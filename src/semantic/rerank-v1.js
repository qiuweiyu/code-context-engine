import {
  SEMANTIC_PROVIDER_DEFAULT_WEIGHT,
  SEMANTIC_PROVIDER_MAX_CANDIDATES,
  SEMANTIC_PROVIDER_MAX_WEIGHT
} from "./provider-v1.js";

export function semanticCandidatePoolLimit(maxFiles, availableCandidates) {
  const selectedLimit = Math.max(1, Number(maxFiles) || 1);
  const available = Math.max(0, Number(availableCandidates) || 0);
  return Math.min(
    available,
    Math.max(24, selectedLimit * 3),
    SEMANTIC_PROVIDER_MAX_CANDIDATES
  );
}

export function rerankSemanticCandidatesV1({
  rankedFiles,
  scores,
  weight = SEMANTIC_PROVIDER_DEFAULT_WEIGHT,
  poolSize = rankedFiles?.length ?? 0
}) {
  if (!Array.isArray(rankedFiles)) {
    throw new Error("rankedFiles must be an array");
  }
  if (!Array.isArray(scores)) {
    throw new Error("semantic scores must be an array");
  }
  if (!Number.isFinite(weight) || weight < 0 || weight > SEMANTIC_PROVIDER_MAX_WEIGHT) {
    throw new Error("semantic weight is outside the supported range");
  }

  const boundedPoolSize = Math.min(
    rankedFiles.length,
    Math.max(0, Number(poolSize) || 0),
    SEMANTIC_PROVIDER_MAX_CANDIDATES
  );
  if (boundedPoolSize === 0) {
    return {
      ranked_files: [...rankedFiles],
      refinements: []
    };
  }

  const scoreByPath = new Map(scores.map((entry) => [entry.path, entry]));
  const prefix = rankedFiles.slice(0, boundedPoolSize).map((entry, index) => {
    const semantic = scoreByPath.get(entry.path);
    if (!semantic) {
      throw new Error("missing semantic score for candidate: " + entry.path);
    }
    const deterministicRank = index + 1;
    const deterministicComponent = boundedPoolSize <= 1
      ? 1
      : 1 - (index / (boundedPoolSize - 1));
    const semanticComponent = semantic.semantic_score;
    const fusedScore =
      ((1 - weight) * deterministicComponent)
      + (weight * semanticComponent);

    return {
      entry,
      deterministic_rank: deterministicRank,
      deterministic_component: deterministicComponent,
      semantic_score: semanticComponent,
      semantic_reason: semantic.reason ?? null,
      fused_score: fusedScore
    };
  });

  prefix.sort((a, b) =>
    b.fused_score - a.fused_score
    || a.deterministic_rank - b.deterministic_rank
    || a.entry.path.localeCompare(b.entry.path)
  );

  return {
    ranked_files: [
      ...prefix.map((item) => item.entry),
      ...rankedFiles.slice(boundedPoolSize)
    ],
    refinements: prefix.map((item, index) => ({
      path: item.entry.path,
      deterministic_rank: item.deterministic_rank,
      semantic_rank: index + 1,
      deterministic_component: Number(item.deterministic_component.toFixed(6)),
      semantic_score: item.semantic_score,
      fused_score: Number(item.fused_score.toFixed(6)),
      ...(item.semantic_reason ? { reason: item.semantic_reason } : {})
    }))
  };
}
