import type { Calibration } from "@/calibrate";

/** The report. A pure string formatter — it does no arithmetic beyond
 *  percentages and reads nothing. */

const pct = (r: number) => `${Math.round(r * 100)}%`;

export function renderCalibrate(c: Calibration): string {
  if (c.legCount === 0) {
    // TRANSIT CANNOT BE CALIBRATED AT ALL, and that is a different statement
    // from "nobody has measured it yet".
    //
    // The old text here said "Measure them with: trip route" for every mode.
    // `trip route` measures WALKING legs and nothing else, so on a transit
    // plan that is advice which cannot work: you would run it, watch legs get
    // stored, run calibrate again and see the identical empty report, with
    // nothing anywhere saying why.
    //
    // M11's rule is that a refusal must be as specific as an answer and still
    // answer whatever part it can. So: name the reason, refuse the comparison
    // that cannot be made honestly, and point at the command that DOES have
    // something to show.
    if (c.mode === "transit") {
      return [
        "How wrong the transit model is here CANNOT BE MEASURED, and this is",
        "not a matter of nobody having tried yet.",
        "",
        "There is no free router covering transit in the cities this was built",
        "against, and OSM carries no timetable to derive one from - no interval,",
        "headway or duration tag on any route relation in four cities. So there",
        "is no ground truth to compare a transit estimate against.",
        "",
        "Grading the station graph against its own output would return exactly",
        "100% and read as perfect agreement. A model's own output is not",
        "evidence about that model, so this refuses rather than printing it.",
        "",
        "What CAN be inspected: trip transit reports the stations, the links and",
        "how many of your segments can reach one.",
      ].join("\n");
    }
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
