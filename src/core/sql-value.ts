/**
 * A value as it binds to SQL: null and undefined are NULL, a boolean
 * is 1 or 0, an object is its JSON text; numbers, bigints and strings
 * bind as they are.
 */
export function serializeValue(v: any): any {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}
