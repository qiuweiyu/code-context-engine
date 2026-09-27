const CONCEPTS = new Map([
  ["change", ["update"]],
  ["email", ["contact", "details"]],
  ["address", ["contact", "details"]],
  ["give", ["distribute"]],
  ["homework", ["exercise"]],
  ["class", ["exercise"]],
  ["complete", ["finalize"]],
  ["buyer", ["purchase"]],
  ["order", ["purchase"]],
  ["disable", ["revoke"]],
  ["login", ["session"]],
  ["summary", ["summarize"]],
  ["study", ["learning"]],
  ["activity", ["learning"]]
]);

function terms(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 2);
}

function expandedTask(task) {
  const out = new Set(terms(task));
  for (const term of [...out]) {
    for (const alias of CONCEPTS.get(term) ?? []) out.add(alias);
  }
  return out;
}

function candidateText(candidate) {
  return [
    candidate.path,
    ...(candidate.symbol_hints ?? []),
    ...(candidate.reasons ?? [])
  ].join(" ").toLowerCase();
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const expanded = expandedTask(request.task);
  const scores = request.candidates.map((candidate) => {
    const haystack = candidateText(candidate);
    const matched = [...expanded].filter((term) => haystack.includes(term));
    const semanticOnly = matched.filter((term) =>
      !terms(request.task).includes(term)
    );
    const score = Math.min(
      1,
      0.02
        + (matched.length * 0.08)
        + (semanticOnly.length * 0.34)
    );
    return {
      path: candidate.path,
      semantic_score: Number(score.toFixed(4)),
      reason: semanticOnly.length
        ? "reference semantic concepts: " + semanticOnly.sort().join(",")
        : "reference semantic concepts: none"
    };
  });

  process.stdout.write(JSON.stringify({
    protocol: "cce.semantic-provider",
    version: "1.0",
    request_id: request.request_id,
    provider: {
      id: "cce.semantic-reference",
      version: "1.0.0"
    },
    scores,
    diagnostics: [
      "evaluation-only deterministic provider; not a production model"
    ]
  }));
});
