/** Validation shared by the storage modules.
 *
 *  It lives in its own file rather than in `segments.ts` because `mentions.ts`
 *  needs the same tag checks, while `segments.ts` imports `unlinkSegment` from
 *  `mentions.ts`. Putting these in either storage module would make the two
 *  depend on each other. */

const WEEKDAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAY_NAMES = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
];

/** Tags and closed days share one column each, comma separated. A value
 *  holding a comma would silently become two on read, and an empty value
 *  would become a phantom entry — both are rejected rather than corrupting
 *  the row. */
export function joinList(values: string[], field: string): string {
  for (const v of values) {
    if (v.includes(",")) {
      throw new Error(`${field} value "${v}" may not contain a comma`);
    }
    if (v.trim() === "") {
      throw new Error(`a ${field} may not be empty`);
    }
  }
  return values.join(",");
}

/** Normalise a weekday to its 3-letter code. Accepts "MON", "Monday", "mon".
 *  Case folding happens HERE rather than at the CLI because M3 writes segments
 *  programmatically: a mention carrying "Mon" would otherwise never match the
 *  scheduler's lowercase comparison and the segment would be scheduled on a day
 *  it is closed, silently. */
export function normalizeWeekday(raw: string): string {
  const s = raw.trim().toLowerCase();
  const code = s.length === 3 ? s : WEEKDAY_NAMES.indexOf(s) >= 0 ? s.slice(0, 3) : "";
  if (!WEEKDAY_CODES.includes(code)) {
    throw new Error(`invalid weekday "${raw.trim()}" (expected mon..sun)`);
  }
  return code;
}
