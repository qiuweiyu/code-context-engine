import test from "node:test";
import assert from "node:assert/strict";
import {
  TOKEN_ESTIMATION_METHOD, estimateTokensFromBytes,
  effectsFromCompletedEvent, effectsFromRequest, addEffects, totalEffects
} from "../src/observability/effects.js";

const event = (full_bytes, compact_bytes, source = "measured") => ({
  event_type: "query_completed",
  payload: { status: "success", full_bytes, compact_bytes,
    ...(source ? { measurement_source: source } : {}) }
});

test("UTF-8 byte heuristic is deterministic, versioned and explicitly estimated", () => {
  assert.equal(TOKEN_ESTIMATION_METHOD, "utf8_bytes_div_4_v1");
  assert.deepEqual([0, 1, 4, 5, 8].map(estimateTokensFromBytes), [0, 1, 1, 2, 2]);
  const pair = effectsFromCompletedEvent(event(5, 1));
  assert.deepEqual(pair, [
    { measurement_source: "measured", scope: "cce_output",
      full_bytes: 5, compact_bytes: 1 },
    { measurement_source: "estimated", scope: "cce_output",
      method: TOKEN_ESTIMATION_METHOD, full_tokens: 2, compact_tokens: 1 }
  ]);
  for (const invalid of [-1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => estimateTokensFromBytes(invalid), RangeError);
  }
});

test("aggregate sums per-query estimates; growth and zero remain visible", () => {
  const total = { measured_queries: 0, full_bytes: 0, compact_bytes: 0,
    full_tokens: 0, compact_tokens: 0 };
  addEffects(total, effectsFromCompletedEvent(event(5, 1)));
  addEffects(total, effectsFromCompletedEvent(event(6, 1)));
  assert.deepEqual(total, { measured_queries: 2, full_bytes: 11,
    compact_bytes: 2, full_tokens: 4, compact_tokens: 2 });
  assert.notEqual(total.full_tokens, estimateTokensFromBytes(total.full_bytes));
  assert.equal(totalEffects(total)[1].full_tokens, 4);
  assert.deepEqual(effectsFromCompletedEvent(event(0, 8))[1],
    { measurement_source: "estimated", scope: "cce_output",
      method: TOKEN_ESTIMATION_METHOD, full_tokens: 0, compact_tokens: 2 });
});

test("only explicit measured, successful query completions qualify", () => {
  assert.deepEqual(effectsFromCompletedEvent(event(5, 1, null)), []);
  assert.deepEqual(effectsFromCompletedEvent({ ...event(5, 1),
    payload: { ...event(5, 1).payload, status: "failure" } }), []);
  assert.deepEqual(effectsFromRequest({ operation: "index", status: "success",
    events: [event(5, 1)] }), []);
  assert.deepEqual(effectsFromRequest({ operation: "query", status: "failure",
    events: [event(5, 1)] }), []);
  assert.deepEqual(effectsFromRequest({ operation: "query", status: "success",
    events: [event(5, 1), event(6, 1)] })[0].full_bytes, 6);
});
