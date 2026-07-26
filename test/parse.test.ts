import { expect, test, describe } from "bun:test";
import {
  parseDuration, parseClock, formatClock, parseCoords,
  parseDateRange, parseWeekdays,
} from "@/parse";

describe("parseDuration", () => {
  test("accepts the forms a human actually types", () => {
    expect(parseDuration("90m")).toBe(90);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("1h30")).toBe(90);
    expect(parseDuration("1h30m")).toBe(90);
    expect(parseDuration("45")).toBe(45);
  });

  test("rejects nonsense instead of defaulting", () => {
    // A silently-defaulted duration would place a segment with the wrong
    // dwell and shift every later segment on the day.
    for (const bad of ["", "abc", "-5m", "0", "1h70m", "90x"]) {
      expect(() => parseDuration(bad)).toThrow(/duration/i);
    }
  });

  test("rejects invalid minutes in hour form (e.g. 1h60m)", () => {
    // The minutes > 59 boundary must not regress from > 59 to > 60.
    expect(() => parseDuration("1h60m")).toThrow(/duration/i);
  });
});

describe("parseClock / formatClock", () => {
  test("round-trips a time of day", () => {
    expect(parseClock("13:05")).toBe(785);
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("23:59")).toBe(1439);
    expect(formatClock(785)).toBe("13:05");
    expect(formatClock(0)).toBe("00:00");
  });

  test("formatClock pads both fields", () => {
    expect(formatClock(9 * 60 + 5)).toBe("09:05");
  });

  test("rejects impossible clock times", () => {
    for (const bad of ["24:00", "12:60", "12", "abc", "-1:00", ""]) {
      expect(() => parseClock(bad)).toThrow(/time/i);
    }
  });
});

describe("parseCoords", () => {
  test("parses a lat,lon pair", () => {
    expect(parseCoords("38.707,-9.145")).toEqual({
      latitude: 38.707, longitude: -9.145,
    });
    expect(parseCoords("38.707, -9.145")).toEqual({
      latitude: 38.707, longitude: -9.145,
    });
  });

  test("rejects out-of-range and malformed pairs", () => {
    // Swapped lat/lon is the common mistake and it puts the segment in the
    // wrong hemisphere, so the range check is load-bearing, not decoration.
    for (const bad of ["91,0", "-91,0", "0,181", "0,-181", "38.707", "a,b", ""]) {
      expect(() => parseCoords(bad)).toThrow(/coordinate/i);
    }
  });

  test("rejects empty or whitespace-only components", () => {
    // Number("") returns 0, not NaN, so empty strings must be caught before
    // conversion. A segment silently at 0,0 (Gulf of Guinea) instead of throwing
    // is a data integrity bug.
    for (const bad of ["38.707,", ",−9.145", ",", " , "]) {
      expect(() => parseCoords(bad)).toThrow(/coordinate/i);
    }
  });

  test("accepts 0,0 as a valid coordinate", () => {
    // 0,0 is a real location; the empty-component guard must not reject it.
    expect(parseCoords("0,0")).toEqual({ latitude: 0, longitude: 0 });
  });
});

describe("parseDateRange", () => {
  test("expands the shorthand end date", () => {
    expect(parseDateRange("2027-05-08..05-16")).toEqual({
      start: "2027-05-08", end: "2027-05-16",
    });
  });

  test("accepts a fully spelled range", () => {
    expect(parseDateRange("2027-05-08..2027-05-16")).toEqual({
      start: "2027-05-08", end: "2027-05-16",
    });
  });

  test("rejects a backwards or malformed range", () => {
    for (const bad of ["2027-05-16..05-08", "2027-05-08", "..05-16",
                       "2027-13-01..12-02", ""]) {
      expect(() => parseDateRange(bad)).toThrow(/date/i);
    }
  });

  test("rejects input with trailing junk after the second ..", () => {
    // input.split("..") only destructures the first two parts, silently dropping
    // anything after a second .., so "2027-05-08..05-16..junk" doesn't throw.
    expect(() => parseDateRange("2027-05-08..05-16..junk")).toThrow(/date/i);
  });

  test("accepts an equal start and end date", () => {
    // A one-day trip is valid; end < start rejects backwards ranges, not equal ones.
    expect(parseDateRange("2027-05-08..05-08")).toEqual({
      start: "2027-05-08", end: "2027-05-08",
    });
  });
});

describe("parseWeekdays", () => {
  test("normalises a comma list", () => {
    expect(parseWeekdays("mon,tue")).toEqual(["mon", "tue"]);
    expect(parseWeekdays("Mon, Tuesday")).toEqual(["mon", "tue"]);
  });

  test("rejects a day that is not a day", () => {
    expect(() => parseWeekdays("mon,funday")).toThrow(/weekday/i);
  });

  test("accepts full weekday names", () => {
    // Full names like "monday" and "tuesday" are valid, not just 3-letter codes.
    expect(parseWeekdays("monday,tuesday")).toEqual(["mon", "tue"]);
    expect(parseWeekdays("Monday")).toEqual(["mon"]);
  });

  test("rejects strings that start with a weekday but have junk", () => {
    // .slice(0, 3) only checks the first three chars, so "monkey" → "mon".
    // Only accept exact full names or 3-letter codes.
    for (const bad of ["monkey", "friday!!", "satan"]) {
      expect(() => parseWeekdays(bad)).toThrow(/weekday/i);
    }
  });
});
