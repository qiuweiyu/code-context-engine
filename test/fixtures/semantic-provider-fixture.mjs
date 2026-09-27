let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", async () => {
  const mode = process.argv[2] ?? "success";
  if (mode === "crash") {
    process.stderr.write("fixture crash\n");
    process.exit(7);
  }
  if (mode === "timeout") {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (mode === "invalid-json") {
    process.stdout.write("{ definitely not json");
    return;
  }

  const request = JSON.parse(input);
  const scores = request.candidates.map((candidate, index) => ({
    path: candidate.path,
    semantic_score: candidate.path.includes("semantic-target")
      ? 0.95
      : Number((0.1 + (index * 0.01)).toFixed(2)),
    reason: "deterministic fixture score"
  }));

  if (mode === "unknown-path") {
    scores[0].path = "src/not-a-candidate.js";
  } else if (mode === "duplicate-path" && scores.length > 1) {
    scores[1].path = scores[0].path;
  } else if (mode === "partial") {
    scores.pop();
  }

  process.stdout.write(JSON.stringify({
    protocol: "cce.semantic-provider",
    version: "1.0",
    request_id: mode === "wrong-request" ? "wrong" : request.request_id,
    provider: {
      id: "fixture.semantic",
      version: "1.0.0"
    },
    scores,
    diagnostics: []
  }));
});
