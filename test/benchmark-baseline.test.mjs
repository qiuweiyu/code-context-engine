import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("ground-truth baseline records both a resolved flow and a known barrel miss", async () => {
  const { stdout } = await exec(process.execPath, ["benchmarks/run.mjs"], {
    cwd: new URL("..", import.meta.url),
    timeout: 120000,
    maxBuffer: 1024 * 1024
  });
  const report = JSON.parse(stdout);
  assert.equal(report.corpus_version, 1);
  const [flow, barrel, dualVue, goAmbiguous, comments, routeAmbiguous] = report.cases;
  assert.equal(flow.name, "vue-ts-go-http");
  assert.deepEqual(
    [flow.labeled_edges.tp, flow.labeled_edges.fp, flow.labeled_edges.fn],
    [5, 0, 0]
  );
  assert.equal(flow.retrieval.hit_at_3, 3);
  assert.equal(barrel.name, "ts-barrel-vue-page");
  assert.equal(barrel.labeled_edges.fn, 1);
  assert.equal(barrel.retrieval.hit_at_3, 2);
  assert.equal(dualVue.labeled_edges.fn, 1);
  assert.equal(goAmbiguous.labeled_edges.fp, 0);
  assert.equal(comments.labeled_edges.fp, 2);
  assert.deepEqual(
    [routeAmbiguous.labeled_edges.tp, routeAmbiguous.labeled_edges.fp],
    [1, 0]
  );
  for (const item of report.cases) {
    assert.equal(item.indexing.warm_changed, 0);
    assert.equal(item.indexing.warm_skipped, item.indexing.first_changed);
    assert.ok(item.output_bytes.compact < item.output_bytes.full);
  }
});
