import type { Client } from "@libsql/client";
import { buildExportView } from "@/export/view";
import { listObservations } from "@/observations";
import { buildBudget, combinedTotal } from "@/budget";
import { renderBudget } from "@/render-budget";
import { getActiveTrip } from "@/trips";

function flag(argv: string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
}

function number(argv: string[], name: string): number | null {
  const raw = flag(argv, name);
  if (raw === null) return null;
  // Number("") is 0, not NaN -- the fourth time this has mattered in this
  // repo, and it would silently mean a zero budget here.
  if (raw.trim() === "") throw new Error(`${name} needs a value (e.g. ${name}=500)`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`invalid ${name} "${raw}"`);
  return n;
}

export async function runBudgetCommand(
  db: Client,
  argv: string[],
  json: boolean,
): Promise<string> {
  const trip = await getActiveTrip(db);
  if (!trip) throw new Error("no active trip - run `trip use <name>` first");

  // The same view every export format reads, so a budget and an export can
  // never disagree about what the plan costs.
  const view = await buildExportView(db);
  const observations = await listObservations(db, trip.id);

  const limit = number(argv, "--limit");
  const dailyRaw = number(argv, "--daily");
  if (dailyRaw !== null && !Number.isInteger(dailyRaw)) {
    throw new Error(`invalid --daily "${dailyRaw}" (expected an observation id)`);
  }

  const report = buildBudget({
    tripName: view.tripName,
    currency: view.currency,
    days: view.days.length,
    travellers: view.travellers.length,
    admissions: view.tripTotal,
    // Real, not a hardcoded zero. A budget that silently omitted transport
    // passes would understate the total, which is the quiet understatement
    // this whole project refuses.
    passes: view.passTotal,
    observations,
    dailyId: dailyRaw,
    limit,
  });

  if (json) {
    return JSON.stringify({
      trip: report.tripName,
      currency: report.currency,
      days: report.days,
      travellers: report.travellers,
      admissions: report.admissions,
      daily: report.daily && {
        observationId: report.daily.observation.id,
        label: report.daily.observation.label,
        currency: report.daily.observation.currency,
        perPersonPerDay: report.daily.perPersonPerDay,
        projected: report.daily.projected,
        coversDays: report.daily.observation.coversDays,
        coversPeople: report.daily.observation.coversPeople,
      },
      limit: report.limit,
      // null means NO SINGLE FIGURE IS AVAILABLE, and `blockers` says why.
      // Never 0, which would read as a free trip.
      total: combinedTotal(report),
      blockers: report.blockers,
      observations: report.observations.map((o) => ({
        id: o.id, label: o.label, amount: o.amount, currency: o.currency,
        coversDays: o.coversDays, coversPeople: o.coversPeople,
      })),
    });
  }
  return renderBudget(report);
}
