import { expect, test, describe } from "bun:test";
import { deriveDays, DEFAULT_DAY_START, DEFAULT_DAY_END } from "@/days";

const base = {
  startDate: "2027-05-08", endDate: "2027-05-16",
  arrivalMin: null, departureMin: null,
  dayStartMin: DEFAULT_DAY_START, dayEndMin: DEFAULT_DAY_END,
};

describe("deriveDays", () => {
  test("both endpoints are inclusive", () => {
    const days = deriveDays(base);
    expect(days).toHaveLength(9);
    expect(days[0]!.date).toBe("2027-05-08");
    expect(days[8]!.date).toBe("2027-05-16");
    expect(days[0]!.day).toBe(1);
    expect(days[8]!.day).toBe(9);
  });

  test("a single-day trip yields one day", () => {
    expect(deriveDays({ ...base, endDate: "2027-05-08" })).toHaveLength(1);
  });

  test("without arrival and departure every day is full", () => {
    const days = deriveDays(base);
    for (const d of days) {
      expect(d.startMin).toBe(540);
      expect(d.endMin).toBe(1140);
    }
  });

  test("arrival shortens the first day and departure the last", () => {
    const days = deriveDays({ ...base, arrivalMin: 930, departureMin: 660 });
    expect(days[0]!.startMin).toBe(930);
    expect(days[0]!.endMin).toBe(1140);
    expect(days[8]!.startMin).toBe(540);
    expect(days[8]!.endMin).toBe(660);
    // Middle days are untouched.
    expect(days[4]!.startMin).toBe(540);
    expect(days[4]!.endMin).toBe(1140);
  });

  test("an arrival before the day window does not lengthen the day", () => {
    // Landing at 06:00 does not mean sightseeing starts at 06:00.
    const days = deriveDays({ ...base, arrivalMin: 360 });
    expect(days[0]!.startMin).toBe(540);
  });

  test("a departure after the day window does not lengthen the day", () => {
    const days = deriveDays({ ...base, departureMin: 1380 });
    expect(days[8]!.endMin).toBe(1140);
  });

  test("an arrival past the day's end yields a zero-length day, not a negative one", () => {
    // A 23:00 landing leaves no usable time. The day must survive as empty
    // rather than reporting negative capacity, which would let the packer
    // treat it as infinitely roomy.
    const days = deriveDays({ ...base, arrivalMin: 1380 });
    expect(days[0]!.endMin - days[0]!.startMin).toBe(0);
    expect(days[0]!.endMin).toBeGreaterThanOrEqual(days[0]!.startMin);
  });

  test("a one-day trip applies both arrival and departure", () => {
    const days = deriveDays({
      ...base, endDate: "2027-05-08", arrivalMin: 600, departureMin: 900,
    });
    expect(days).toHaveLength(1);
    expect(days[0]!.startMin).toBe(600);
    expect(days[0]!.endMin).toBe(900);
  });

  test("weekday is reported for the closed-days check", () => {
    // 2027-05-08 is a Saturday.
    const days = deriveDays(base);
    expect(days[0]!.weekday).toBe("sat");
    expect(days[1]!.weekday).toBe("sun");
    expect(days[2]!.weekday).toBe("mon");
  });

  test("dates advance correctly across a month boundary", () => {
    const days = deriveDays({ ...base, startDate: "2027-05-30", endDate: "2027-06-02" });
    expect(days.map((d) => d.date)).toEqual([
      "2027-05-30", "2027-05-31", "2027-06-01", "2027-06-02",
    ]);
  });

  test("backwards date range throws with both dates in message", () => {
    expect(() => deriveDays({ ...base, startDate: "2027-05-10", endDate: "2027-05-08" })).toThrow(
      /trip ends 2027-05-08 before it starts 2027-05-10/
    );
  });

  // F4: an unparseable date produces Invalid Date, and `start > end` is FALSE
  // when either side is NaN -- the backwards-range guard silently does not
  // fire. Verified before the fix: this returned [] with no error at all.
  test("an unparseable start date throws instead of silently returning no days", () => {
    expect(() => deriveDays({ ...base, startDate: "2027-13-45" })).toThrow(
      /invalid trip start date "2027-13-45"/,
    );
  });

  test("an unparseable end date throws instead of silently returning no days", () => {
    expect(() => deriveDays({ ...base, endDate: "2027-13-45" })).toThrow(
      /invalid trip end date "2027-13-45"/,
    );
  });

  test("an unparseable start date throws even with an arrival time set", () => {
    // Verified before the fix: this threw "undefined is not an object"
    // instead (days[0]! on the empty array), naming neither the bug's cause
    // nor the bad date.
    expect(() => deriveDays({ ...base, startDate: "2027-13-45", arrivalMin: 930 })).toThrow(
      /invalid trip start date "2027-13-45"/,
    );
  });

  test("backwards date range throws even without arrival or departure", () => {
    expect(() => deriveDays({
      ...base, startDate: "2027-05-10", endDate: "2027-05-08",
      arrivalMin: null, departureMin: null,
    })).toThrow(
      /trip ends 2027-05-08 before it starts 2027-05-10/
    );
  });

  test("dates advance correctly across a year boundary", () => {
    const days = deriveDays({ ...base, startDate: "2027-12-30", endDate: "2028-01-02" });
    expect(days.map((d) => d.date)).toEqual([
      "2027-12-30", "2027-12-31", "2028-01-01", "2028-01-02",
    ]);
  });

  test("leap day is handled correctly", () => {
    const days = deriveDays({ ...base, startDate: "2028-02-27", endDate: "2028-03-01" });
    expect(days.map((d) => d.date)).toEqual([
      "2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01",
    ]);
  });
});
