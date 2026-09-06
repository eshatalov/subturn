// core/json.ts — the one type guard every parser of harness output needs.

/** A plain JSON object: not null, not an array. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
