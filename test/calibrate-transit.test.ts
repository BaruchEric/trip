import { test, expect, describe } from "bun:test";
import { renderCalibrate } from "@/render-calibrate";
import type { Calibration } from "@/calibrate";

const empty = (mode: "walking" | "transit"): Calibration => ({
  mode, legCount: 0,
  bands: [
    { label: "under 2 km", legCount: 0, medianRatio: null },
    { label: "2 km and over", legCount: 0, medianRatio: null },
  ],
  worst: null,
});

describe("calibrate refuses specifically on transit", () => {
  test("it does NOT tell a transit user to run trip route", async () => {
    // `trip route` measures WALKING legs and nothing else. Telling someone on
    // a transit plan to run it is advice that cannot work: they would run it,
    // see legs stored, run calibrate again and get the same empty report,
    // with nothing anywhere saying why.
    const out = renderCalibrate(empty("transit"));
    expect(out).not.toMatch(/Measure them with: trip route/);
  });

  test("it names WHY transit cannot be calibrated", async () => {
    const out = renderCalibrate(empty("transit"));
    expect(out).toMatch(/no free router/i);
    expect(out).toMatch(/timetable/i);
  });

  test("it refuses to grade the graph against itself", async () => {
    // The station graph's own output is not evidence about the station graph.
    // Comparing them would produce a ratio of exactly 1 and read as perfect
    // agreement -- the same false-confidence shape as an empty table showing
    // 100%.
    const out = renderCalibrate(empty("transit"));
    expect(out).toMatch(/not evidence about itself|its own output/i);
  });

  test("it still answers the part it CAN, by naming trip transit", async () => {
    // M11's rule: a refusal must be as specific as an answer, and still answer
    // whatever part it can.
    const out = renderCalibrate(empty("transit"));
    expect(out).toContain("trip transit");
  });

  test("walking is unchanged and still points at trip route", async () => {
    const out = renderCalibrate(empty("walking"));
    expect(out).toContain("Measure them with: trip route");
    expect(out).not.toMatch(/timetable/i);
  });

  test("neither mode prints a band table with no legs behind it", async () => {
    // The failure this guards is an empty table showing "model 100% of
    // measured", which asserts perfect agreement where there is no data at
    // all. The transit refusal is allowed to SAY the words "100%" while
    // explaining why it will not print that row -- what must not appear is
    // the row itself.
    for (const mode of ["walking", "transit"] as const) {
      const out = renderCalibrate(empty(mode));
      expect(out).not.toMatch(/model\s+\d+% of measured/);
      expect(out).not.toContain("under 2 km");
      expect(out).toMatch(/UNKNOWN|CANNOT BE MEASURED/);
    }
  });
});
