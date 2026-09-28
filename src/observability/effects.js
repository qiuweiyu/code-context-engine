import { effectSchema } from "./contract.js";

export const TOKEN_ESTIMATION_METHOD = "utf8_bytes_div_4_v1";

function safeCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("output bytes and estimates must be nonnegative safe integers");
  }
  return value;
}

export function estimateTokensFromBytes(bytes) {
  return Math.ceil(safeCount(bytes) / 4);
}

// Each query is estimated separately. Totals are sums of those estimates.
export function effectsFromCompletedEvent(event) {
  if (event?.event_type !== "query_completed"
    || event.payload?.measurement_source !== "measured"
    || event.payload?.status !== "success") return [];
  const full_bytes = safeCount(event.payload.full_bytes);
  const compact_bytes = safeCount(event.payload.compact_bytes);
  return [
    effectSchema.parse({
      measurement_source: "measured", scope: "cce_output",
      full_bytes, compact_bytes
    }),
    effectSchema.parse({
      measurement_source: "estimated", scope: "cce_output",
      method: TOKEN_ESTIMATION_METHOD,
      full_tokens: estimateTokensFromBytes(full_bytes),
      compact_tokens: estimateTokensFromBytes(compact_bytes)
    })
  ];
}

export function effectsFromRequest(request) {
  if (!request || request.status !== "success" || request.operation !== "query") return [];
  const event = request.events?.findLast((entry) => entry.event_type === "query_completed");
  return effectsFromCompletedEvent(event);
}

export function addEffects(total, effects) {
  if (!effects.length) return total;
  const [measured, estimated] = effects;
  for (const [key, amount] of Object.entries({
    full_bytes: measured.full_bytes,
    compact_bytes: measured.compact_bytes,
    full_tokens: estimated.full_tokens,
    compact_tokens: estimated.compact_tokens
  })) total[key] = safeCount(total[key] + amount);
  total.measured_queries = safeCount(total.measured_queries + 1);
  return total;
}

export function totalEffects(total) {
  if (!total.measured_queries) return [];
  return [
    effectSchema.parse({
      measurement_source: "measured", scope: "cce_output",
      full_bytes: total.full_bytes, compact_bytes: total.compact_bytes
    }),
    effectSchema.parse({
      measurement_source: "estimated", scope: "cce_output",
      method: TOKEN_ESTIMATION_METHOD,
      full_tokens: total.full_tokens, compact_tokens: total.compact_tokens
    })
  ];
}
