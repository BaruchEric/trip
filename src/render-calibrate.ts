import type { Calibration } from "@/calibrate";

/** The report. A pure string formatter — it does no arithmetic beyond
 *  percentages and reads nothing. */

const pct = (r: number) => `${Math.round(r * 100)}%`;

export function renderCalibrate(c: Calibration): string {
  if (c.legCount === 0) {
    // Absence is loud, and it names the fix. Printing an empty table with
    // 100% in it would say the model agrees perfectly here, which is the
    // opposite of what no data means.
    return [
      `No measured legs for --mode=${c.mode}, so how wrong the model is here`,
      "is UNKNOWN.",
      "",
      "Measure them with: trip route",
    ].join("\n");
  }

  const lines = [
    `Model vs measured, from ${c.legCount} leg${c.legCount === 1 ? "" : "s"} ` +
    `(--mode=${c.mode})`,
    "",
  ];

  for (const b of c.bands) {
    const value = b.medianRatio === null
      // A band with no legs is UNKNOWN, not agreement.
      ? "-".padStart(6)
      : pct(b.medianRatio).padStart(6);
    lines.push(
      `  ${b.label.padEnd(16)} n=${String(b.legCount).padStart(3)}   ` +
      `model ${value} of measured` +
      (b.medianRatio === null ? "" : "   (median)"),
    );
  }

  if (c.worst) {
    const w = c.worst;
    lines.push(
      "",
      `  worst: model ${w.modelMinutes} min, measured ` +
      `${Math.round(w.measuredMinutes)} min   ${pct(w.ratio)}` +
      `   (${w.straightKm.toFixed(2)} km apart)`,
    );
  }

  lines.push(
    "",
    "Below 100% means the model UNDER-estimates and a plan built on it runs",
    "late. Above 100% means it over-estimates. Which one happens depends on",
    "the city, not on the model.",
  );

  // Not decoration. A user who compares this against a schedule and finds a
  // mismatch must not conclude one of the two is broken.
  if (c.worst && c.worst.sources > 1) {
    lines.push(
      "",
      "This compares against the MIDPOINT of the routers. The schedule reads",
      "the SLOWER of them, so its numbers will differ, deliberately.",
    );
  }

  return lines.join("\n");
}
