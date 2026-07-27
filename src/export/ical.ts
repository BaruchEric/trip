import type { ExportView, ExportStop } from "@/export/view";
import { basisWord } from "@/plan/travel";

/** RFC 5545 iCalendar.
 *
 *  The interesting property is STATUS. RFC 5545 defines TENTATIVE /
 *  CONFIRMED / CANCELLED for a VEVENT — "Indicates event is tentative" — which
 *  is a standard, portable place to put this project's `?`. Five of the six
 *  segments in the measured Chongqing trip have unknown opening hours, and a
 *  calendar that presented all six identically would be more confident than
 *  the plan it came from. */

const CRLF = "\r\n";

/** Fold at 75 OCTETS, per RFC 5545 3.1, with a single leading space on each
 *  continuation.
 *
 *  Octets, not characters, and the difference is not academic here: 洪崖洞 is
 *  three bytes per character, so folding by character count overruns the
 *  limit, and splitting mid-sequence produces mojibake in every client. */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  const parts: string[] = [];
  let start = 0;
  // 75 for the first line, 74 for continuations (the leading space counts).
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never split a UTF-8 sequence: continuation bytes are 10xxxxxx.
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74;
  }
  return parts.map((p, i) => (i === 0 ? p : ` ${p}`)).join(CRLF);
}

/** RFC 5545 3.3.11: backslash, semicolon, comma and newline in a TEXT value. */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Floating local time — no Z, no TZID. The trip carries no timezone field,
 *  and inventing one would assert a fact the tool does not have. */
function stamp(date: string, minutes: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + Math.floor(minutes / 1440));
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${day.getUTCFullYear()}${pad(day.getUTCMonth() + 1)}${pad(day.getUTCDate())}` +
    `T${pad(Math.floor(m / 60))}${pad(m % 60)}00`;
}

function dateOnly(date: string, offsetDays = 0): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function money(n: number | null, currency: string | null): string {
  if (n === null) return "price unknown";
  if (n === 0) return "free";
  return currency === null ? String(n) : `${n} ${currency}`;
}

function describe(s: ExportStop, currency: string | null): string {
  const parts: string[] = [];
  if (s.arriveBy) {
    parts.push(`Getting here: ${s.arriveBy.minutes} min ${s.arriveBy.mode} ` +
      `(${basisWord(s.arriveBy.basis)})`);
  }
  parts.push(money(s.price, currency));
  if (!s.hoursKnown) {
    parts.push("Opening hours are UNKNOWN - this time is where the planner " +
      "put it, not when the place is open. Verify before you go.");
  }
  return parts.join("\\n");
}

export function renderIcs(v: ExportView, now: string): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//trip//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(v.tripName)}`,
    // The unknown-count trailer has no native slot, so it rides here AND the
    // description says where the complete record is. Carried, but invisible
    // in a calendar UI, and saying so is the honest arrangement.
    `X-TRIP-PRICE-TOTAL:${v.tripTotal.total ?? ""}`,
    `X-TRIP-PRICE-UNKNOWN:${v.tripTotal.unknown}`,
    `X-WR-CALDESC:${escapeText(
      `${v.tripTotal.unknown} of this trip's segments have no price recorded, ` +
      "and per-traveller costs are not representable in iCalendar. " +
      "The Markdown export is the complete record.")}`,
  ];

  for (const d of v.days) {
    for (const s of d.stops) {
      lines.push(
        "BEGIN:VEVENT",
        // Stable, so re-importing UPDATES rather than duplicating.
        `UID:trip-${escapeText(v.tripName)}-seg-${s.segmentId}@trip.local`,
        `DTSTAMP:${now}`,
        `DTSTART:${stamp(d.date, s.startMin)}`,
        `DTEND:${stamp(d.date, s.endMin)}`,
        `SUMMARY:${escapeText(s.localName === null ? s.name : `${s.name} (${s.localName})`)}`,
        // The one place a calendar can natively say "this might be wrong".
        `STATUS:${s.hoursKnown ? "CONFIRMED" : "TENTATIVE"}`,
        `DESCRIPTION:${escapeText(describe(s, v.currency)).replace(/\\\\n/g, "\\n")}`,
        `X-TRIP-PRICE:${s.price ?? ""}`,
        `X-TRIP-HOURS-KNOWN:${s.hoursKnown ? "TRUE" : "FALSE"}`,
      );
      if (s.arriveBy) {
        lines.push(
          `X-TRIP-TRAVEL-MINUTES:${s.arriveBy.minutes}`,
          `X-TRIP-TRAVEL-BASIS:${s.arriveBy.basis.toUpperCase()}`,
        );
      }
      if (s.latitude !== null && s.longitude !== null) {
        // RFC 5545: LATITUDE;LONGITUDE -- the OPPOSITE order to GeoJSON.
        lines.push(`GEO:${s.latitude};${s.longitude}`);
        if (s.localName !== null) lines.push(`LOCATION:${escapeText(s.localName)}`);
      }
      lines.push("END:VEVENT");
    }
  }

  for (const u of v.unplaced) {
    // A compromise, and recorded as one: a VEVENT needs a date and this
    // segment has no day, so the trip start is used. The SUMMARY leads with
    // "Not planned:" and carries the reason, so the date reads as a
    // placeholder rather than a claim.
    //
    // VTODO is the semantically correct component and is NOT used: Google
    // Calendar ignores VTODO entirely, so the item would vanish silently --
    // exactly the failure this project exists to prevent. Visible and
    // slightly wrong beats correct and invisible.
    lines.push(
      "BEGIN:VEVENT",
      `UID:trip-${escapeText(v.tripName)}-unplaced-${u.segmentId}@trip.local`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${dateOnly(v.startDate)}`,
      `DTEND;VALUE=DATE:${dateOnly(v.startDate, 1)}`,
      `SUMMARY:${escapeText(`Not planned: ${u.name} - ${u.reason}`)}`,
      "STATUS:TENTATIVE",
      "TRANSP:TRANSPARENT",
      `DESCRIPTION:${escapeText(
        "This is in the trip but in no day. The date above is a placeholder, " +
        "not a plan.")}`,
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`;
}
