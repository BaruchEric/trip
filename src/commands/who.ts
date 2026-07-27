import type { Client } from "@libsql/client";
import { getActiveTrip } from "@/trips";
import { addTraveller, listTravellers, removeTraveller } from "@/travellers";
import { ageOn } from "@/pricing/party";

function flag(argv: string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
}

export async function runWhoCommand(
  db: Client,
  argv: string[],
  json: boolean,
): Promise<string> {
  const trip = await getActiveTrip(db);
  if (!trip) throw new Error("no active trip - run `trip use <name>` first");

  const [sub, ...rest] = argv;

  if (sub === "add") {
    const label = rest.find((a) => !a.startsWith("--"));
    const born = flag(argv, "--born");
    if (!label) throw new Error("usage: trip who add <label> --born=YYYY-MM-DD");
    if (born === null) {
      throw new Error(`traveller "${label}" needs --born=YYYY-MM-DD`);
    }
    await addTraveller(db, trip.id, label, born);
    if (json) return JSON.stringify(await listTravellers(db, trip.id));
    return `Added ${label.trim()} (b.${born.trim()}).`;
  }

  if (sub === "ls") {
    const all = await listTravellers(db, trip.id);
    if (json) return JSON.stringify(all);
    if (all.length === 0) {
      return "No travellers yet. Add one with: trip who add <label> --born=YYYY-MM-DD";
    }
    // Age TODAY, shown for orientation only, and labelled as such. Every
    // PRICE is computed against the day the plan visits the place, never
    // against today -- which is the whole reason birth dates are stored
    // instead of ages.
    const today = new Date().toISOString().slice(0, 10);
    return all
      .map((t) =>
        `  ${t.label.padEnd(12)} b.${t.birthDate}  ` +
        `age ${ageOn(t.birthDate, today)} today`)
      .join("\n");
  }

  if (sub === "rm") {
    const label = rest[0];
    if (!label) throw new Error("usage: trip who rm <label>");
    const gone = await removeTraveller(db, trip.id, label);
    if (!gone) throw new Error(`no traveller called "${label}" on this trip`);
    // No cascade, and no replan needed: prices are DERIVED at render time and
    // stored nowhere, so removing a traveller cannot leave a stale number
    // behind. Every total simply changes on the next command.
    if (json) return JSON.stringify(await listTravellers(db, trip.id));
    return `Removed ${label}. Totals change on the next plan; no replan needed.`;
  }

  throw new Error(`unknown command: trip who ${sub ?? ""}`);
}
