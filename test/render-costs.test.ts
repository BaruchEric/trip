import { test, expect, describe } from "bun:test";
import { renderObservations } from "@/render-costs";
import type { CostObservation } from "@/observations";

function obs(o: Partial<CostObservation> = {}): CostObservation {
  return {
    id: 1, tripId: 1, sourceId: 1, atSeconds: 1169,
    label: "Accommodation", amount: 230, currency: "USD",
    coversDays: 4, coversPeople: 1, ...o,
  };
}

describe("renderObservations", () => {
  test("shows the amount, the coverage and the derived rate", () => {
    const out = renderObservations([obs()]);
    expect(out).toContain("USD 230");
    expect(out).toContain("4d x 1p");
    expect(out).toContain("57.50");
  });

  test("unknown coverage renders ? for the rate, never a guess", () => {
    const out = renderObservations([obs({ coversDays: null })]);
    expect(out).toContain("?");
    expect(out).toContain("coverage unknown");
    expect(out).not.toContain("pppd");
  });

  test("the source and timestamp are shown, because provenance is the point", () => {
    const out = renderObservations([obs()]);
    expect(out).toMatch(/source 1/);
    expect(out).toMatch(/19:29/);
  });

  test("a hand-entered observation says so rather than inventing a source", () => {
    expect(renderObservations([obs({ sourceId: null, atSeconds: null })]))
      .toMatch(/entered by hand/i);
  });

  test("a source with no timestamp names the source and stops", () => {
    const out = renderObservations([obs({ atSeconds: null })]);
    expect(out).toMatch(/source 1/);
    expect(out).not.toMatch(/ at /);
  });

  test("NEVER prints a total across observations", () => {
    // The measured card states three components AND their total. Summing
    // them double-counts by exactly the total, and a source says what it
    // says.
    const out = renderObservations([
      obs({ id: 1, label: "Transportation", amount: 40 }),
      obs({ id: 2, label: "Accommodation", amount: 230 }),
      obs({ id: 3, label: "Activities & food", amount: 131 }),
      obs({ id: 4, label: "Total", amount: 401 }),
    ]);
    expect(out).not.toMatch(/^\s*(Total observations|Sum|Overall|Grand)/mi);
    expect(out).not.toContain("802");   // 40 + 230 + 131 + 401
    // The row literally called "Total" is still shown -- it is what the
    // source said. It is just never ADDED to anything.
    expect(out).toContain("USD 401");
  });

  test("a zero amount renders as a real figure, not as unknown", () => {
    const out = renderObservations([obs({ amount: 0 })]);
    expect(out).toContain("USD 0");
    expect(out).toContain("0.00 pppd");
  });

  test("an empty list names the fix", () => {
    expect(renderObservations([])).toContain("trip costs add");
  });

  test("the whole measured Chongqing card renders", () => {
    const out = renderObservations([
      obs({ id: 1, label: "Transportation", amount: 40 }),
      obs({ id: 2, label: "Accommodation", amount: 230 }),
      obs({ id: 3, label: "Activities & food", amount: 131 }),
      obs({ id: 4, label: "Total", amount: 401 }),
    ]);
    expect(out).toContain("10.00 pppd");
    expect(out).toContain("57.50 pppd");
    expect(out).toContain("32.75 pppd");
    expect(out).toContain("100.25 pppd");
  });
});
