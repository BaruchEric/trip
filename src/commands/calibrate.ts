import type { Client } from "@libsql/client";
import { getActiveTrip } from "@/trips";
import { listLegs } from "@/legs";
import { calibrate } from "@/calibrate";
import { renderCalibrate } from "@/render-calibrate";
import { MODES, type Mode } from "@/plan/types";

/** How wrong the travel model is here.
 *
 *  Read-only and offline: `trip route` does the measuring, this only derives.
 *  That is what makes it testable without stubbing a network and cheap enough
 *  to run whenever. */
export async function runCalibrateCommand(
  db: Client,
  _argv: string[],
  json: boolean,
): Promise<string> {
  const trip = await getActiveTrip(db);
  if (!trip) throw new Error("no active trip - run `trip use <name>` first");

  // The trip's own mode: `trip calibrate` takes no flags, so it reports on
  // whatever the plan is actually compiled with.
  const mode = MODES.includes(trip.mode as Mode) ? (trip.mode as Mode) : "walking";
  const result = calibrate(await listLegs(db), mode);

  if (json) {
    return JSON.stringify({
      mode: result.mode,
      legCount: result.legCount,
      // null, not 1: a band with no legs is unknown. Emitted as a NUMBER or
      // null, never a formatted percentage string.
      bands: result.bands.map((b) => ({
        label: b.label, legCount: b.legCount, medianRatio: b.medianRatio,
      })),
      worst: result.worst && {
        modelMinutes: result.worst.modelMinutes,
        measuredMinutes: result.worst.measuredMinutes,
        ratio: result.worst.ratio,
        straightKm: result.worst.straightKm,
        sources: result.worst.sources,
      },
      // Stated as data so an agent does not have to read the prose to learn
      // that this and the schedule answer different questions.
      comparedAgainst: "router-midpoint",
      scheduleReads: "router-maximum",
    });
  }
  return renderCalibrate(result);
}
