/** A trip's days as time budgets. Derived, never stored: keeping a `days`
 *  table would create a second copy of this that can disagree with the trip
 *  row it comes from (M2-8). */

export const DEFAULT_DAY_START = 9 * 60;   // 09:00
export const DEFAULT_DAY_END = 19 * 60;    // 19:00

const WEEKDAY_CODES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface TripSchedule {
  startDate: string;
  endDate: string;
  /** Local arrival time on day 1, or null if unknown — in which case day 1 is
   *  treated as full and the plan says so (M2-3). */
  arrivalMin: number | null;
  departureMin: number | null;
  dayStartMin: number;
  dayEndMin: number;
}

export interface DayWindow {
  day: number;
  date: string;
  weekday: string;
  startMin: number;
  endMin: number;
}

export function deriveDays(schedule: TripSchedule): DayWindow[] {
  const days: DayWindow[] = [];
  // UTC throughout: these are calendar dates, not instants, and local-midnight
  // arithmetic would shift a date across a DST boundary.
  const start = new Date(`${schedule.startDate}T00:00:00Z`);
  const end = new Date(`${schedule.endDate}T00:00:00Z`);

  // F4: an unparseable date yields Invalid Date, and `start > end` is FALSE
  // under NaN on either side -- the backwards-range guard below never fires,
  // the loop below never runs (NaN <= NaN is also false), and the function
  // returns [] silently rather than naming the bad date. `days[0]!` then
  // blows up with an unhelpful "undefined is not an object" wherever the
  // caller assumes at least one day, or worse, is invisibly [] where a
  // caller only checks length. Named separately from the backwards-range
  // guard below so the message points at the actual malformed date rather
  // than a nonsensical "ends before it starts".
  if (Number.isNaN(start.getTime())) {
    throw new Error(`invalid trip start date "${schedule.startDate}"`);
  }
  if (Number.isNaN(end.getTime())) {
    throw new Error(`invalid trip end date "${schedule.endDate}"`);
  }

  // Guard against backwards date range. Absence of output is an easy-to-miss
  // failure shape; throw early with both dates to make it visible.
  if (start > end) {
    throw new Error(
      `trip ends ${schedule.endDate} before it starts ${schedule.startDate}`
    );
  }

  for (let d = new Date(start), i = 1; d <= end; d.setUTCDate(d.getUTCDate() + 1), i++) {
    const date = d.toISOString().slice(0, 10);
    days.push({
      day: i,
      date,
      weekday: WEEKDAY_CODES[d.getUTCDay()]!,
      startMin: schedule.dayStartMin,
      endMin: schedule.dayEndMin,
    });
  }

  const first = days[0]!;
  const last = days[days.length - 1]!;

  // Arrival and departure can only SHORTEN a day. Landing at 06:00 does not
  // mean sightseeing starts at 06:00, and `Math.min`/`max` against the day
  // end also keeps the window from inverting on a late landing — a negative
  // budget would read as infinite room to the packer.
  if (schedule.arrivalMin !== null) {
    first.startMin = Math.min(Math.max(first.startMin, schedule.arrivalMin), first.endMin);
  }
  if (schedule.departureMin !== null) {
    last.endMin = Math.max(Math.min(last.endMin, schedule.departureMin), last.startMin);
  }

  return days;
}
