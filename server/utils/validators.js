const MAX_MESSAGE_LENGTH = parseInt(process.env.MAX_MESSAGE_LENGTH || "1500", 10);
const MAX_NAME_LENGTH = parseInt(process.env.MAX_NAME_LENGTH || "255", 10);

export function isNonEmptyString(v, maxLen = MAX_MESSAGE_LENGTH) {
  return typeof v === "string" && v.trim().length > 0 && v.trim().length <= maxLen;
}

export function parseIntSafe(v) {
  // parseInt silently accepts strings like "12abc" or "1.9";
  // Number is stricter and rejects invalid values.
  const n = Number(String(v).trim());
  return Number.isInteger(n) ? n : null;
}

export function isPositiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0;
}

export { MAX_MESSAGE_LENGTH, MAX_NAME_LENGTH };
