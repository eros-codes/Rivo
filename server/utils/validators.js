const MAX_MESSAGE_LENGTH = parseInt(process.env.MAX_MESSAGE_LENGTH || "2000", 10);

export function isNonEmptyString(v, maxLen = MAX_MESSAGE_LENGTH) {
  return typeof v === "string" && v.trim().length > 0 && v.trim().length <= maxLen;
}

export function parseIntSafe(v) {
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
}

export function isPositiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0;
}

export { MAX_MESSAGE_LENGTH };
