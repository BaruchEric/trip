import type { Client } from "@libsql/client";
import { createTrip, listTrips, setActiveTrip, getActiveTrip } from "@/trips";

export async function runTripsCommand(
  db: Client,
  argv: string[],
  json: boolean,
): Promise<string> {
  const [sub, ...rest] = argv;

  if (sub === "new") {
    const name = rest[0];
    if (!name) throw new Error("usage: trip new <name>");
    const t = await createTrip(db, name, new Date().toISOString().slice(0, 10));
    await setActiveTrip(db, name);
    return json ? JSON.stringify(t) : `Created "${t.name}" and made it active.`;
  }

  if (sub === "use") {
    const name = rest[0];
    if (!name) throw new Error("usage: trip use <name>");
    await setActiveTrip(db, name);
    return json ? JSON.stringify({ active: name }) : `Active trip: ${name}`;
  }

  if (sub === "ls") {
    const all = await listTrips(db);
    const active = await getActiveTrip(db);
    if (json) return JSON.stringify({ trips: all, active: active?.name ?? null });
    if (all.length === 0) return "No trips yet. Create one with: trip new <name>";
    return all
      .map((t) => `${t.name === active?.name ? "*" : " "} ${t.name}`)
      .join("\n");
  }

  if (sub === "show") {
    const t = await getActiveTrip(db);
    if (!t) return json ? JSON.stringify(null) : "No active trip.";
    if (json) return JSON.stringify(t);
    return [
      `Trip:     ${t.name}`,
      `Dates:    ${t.startDate ?? "not set"} - ${t.endDate ?? "not set"}`,
      `Mode:     ${t.mode}`,
      `Pace:     ${t.pace}`,
      `Lodging:  ${t.lodgingTier}`,
      `Food:     ${t.foodTier}`,
    ].join("\n");
  }

  throw new Error(`unknown command: trip ${sub ?? ""}`);
}
