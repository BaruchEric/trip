import { expect, test, describe } from "bun:test";
import { joinList, normalizeWeekday } from "@/validate";

describe("joinList", () => {
  test("joins values with commas on the happy path", () => {
    expect(joinList(["food", "indoor"], "tag")).toBe("food,indoor");
  });

  test("rejects a value containing a comma", () => {
    expect(() => joinList(["street,food"], "tag")).toThrow(/comma/i);
  });

  test("rejects an empty value", () => {
    expect(() => joinList([""], "tag")).toThrow(/may not be empty/i);
  });

  test("rejects a whitespace-only value", () => {
    expect(() => joinList(["   "], "tag")).toThrow(/may not be empty/i);
  });
});

describe("normalizeWeekday", () => {
  test("normalises an uppercase 3-letter code", () => {
    expect(normalizeWeekday("MON")).toBe("mon");
  });

  test("normalises a full weekday name", () => {
    expect(normalizeWeekday("Monday")).toBe("mon");
  });

  test("passes through an already-lowercase code", () => {
    expect(normalizeWeekday("mon")).toBe("mon");
  });

  test("rejects an invalid weekday", () => {
    expect(() => normalizeWeekday("monkey")).toThrow(/weekday/i);
  });
});
