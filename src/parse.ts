/** Parsing at the CLI boundary. Everything inside the app works in integer
 *  minutes and ISO date strings; these functions are the only translation
 *  layer. Each throws rather than defaulting: a silently-defaulted duration
 *  or time shifts every later segment on the day with nothing to show for it. */

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export function parseDuration(input: string): number {
  const s = input.trim().toLowerCase();
  const bad = () => {
    throw new Error(`invalid duration "${input}" (try 90m, 2h, or 1h30)`);
  };

  const hm = /^(\d+)h(?:(\d+)m?)?$/.exec(s);
  if (hm) {
    const minutes = Number(hm[2] ?? 0);
    if (minutes > 59) bad();
    const total = Number(hm[1]) * 60 + minutes;
    return total > 0 ? total : bad();
  }

  const m = /^(\d+)m?$/.exec(s);
  if (m) {
    const total = Number(m[1]);
    return total > 0 ? total : bad();
  }
  return bad();
}

export function parseClock(input: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(input.trim());
  if (!m) throw new Error(`invalid time "${input}" (expected HH:MM)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) {
    throw new Error(`invalid time "${input}" (expected HH:MM, 00:00-23:59)`);
  }
  return h * 60 + min;
}

export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function parseCoords(input: string): { latitude: number; longitude: number } {
  const parts = input.split(",");
  const bad = () => {
    throw new Error(`invalid coordinates "${input}" (expected lat,lon)`);
  };
  if (parts.length !== 2) return bad();

  const latStr = parts[0]!.trim();
  const lonStr = parts[1]!.trim();
  // Number("") is 0, not NaN, so empty strings must be caught before conversion.
  // A segment silently at 0,0 (Gulf of Guinea) instead of throwing is a data
  // integrity bug.
  if (!latStr || !lonStr) return bad();

  const latitude = Number(latStr);
  const longitude = Number(lonStr);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return bad();
  // A swapped pair is the common mistake and lands the segment in the wrong
  // hemisphere, where clustering silently produces a nonsense day.
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return bad();

  return { latitude, longitude };
}

export function parseDateRange(input: string): { start: string; end: string } {
  const bad = () => {
    throw new Error(
      `invalid date range "${input}" (expected 2027-05-08..05-16)`,
    );
  };
  const parts = input.split("..");
  // input.split("..") only destructures the first two parts, silently dropping
  // anything after a second .., so reject input that does not split into exactly two.
  if (parts.length !== 2) return bad();

  const [rawStart, rawEnd] = parts;
  if (!rawStart || !rawEnd) return bad();

  const start = rawStart.trim();
  if (!isIsoDate(start)) return bad();

  // The end may omit the year, which is the form a human types for a trip
  // that does not straddle New Year.
  const end = rawEnd.trim().length === 5 ? `${start.slice(0, 4)}-${rawEnd.trim()}` : rawEnd.trim();
  if (!isIsoDate(end)) return bad();
  if (end < start) return bad();

  return { start, end };
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  // Reject 2027-13-01 and 2027-02-30: Date normalises them silently, so
  // round-tripping is the check.
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseWeekdays(input: string): string[] {
  if (input.trim() === "") return [];
  return input.split(",").map((raw) => {
    const trimmed = raw.trim().toLowerCase();
    // Accept either a 3-letter code (mon) or a full name (monday).
    // .slice(0, 3) only validates the first three chars, so "monkey" → "mon".
    // Instead, verify the whole string is either 3 letters or a full weekday name.
    const normalized = trimmed.slice(0, 3);
    if (!WEEKDAYS.includes(normalized)) {
      throw new Error(`invalid weekday "${raw.trim()}" (expected mon..sun)`);
    }
    // Accept exact 3-letter codes, or strings that match a full weekday name.
    const fullDayNames = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
    if (trimmed.length !== 3 && !fullDayNames.includes(trimmed)) {
      throw new Error(`invalid weekday "${raw.trim()}" (expected mon..sun)`);
    }
    return normalized;
  });
}
