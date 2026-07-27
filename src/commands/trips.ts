import type { Client } from "@libsql/client";
import {
  createTrip, listTrips, setActiveTrip, getActiveTrip, setTripSettings,
} from "@/trips";
import { listTravellers } from "@/travellers";
import { MODES, PACES, type Mode, type Pace } from "@/plan/types";

function flag(argv: string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
}

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

  if (sub === "set") {
    const t = await getActiveTrip(db);
    if (!t) throw new Error("no active trip - run `trip use <name>` first");

    const currency = flag(rest, "--currency");
    const mode = flag(rest, "--mode");
    const pace = flag(rest, "--pace");
    if (currency === null && mode === null && pace === null) {
      throw new Error("nothing to set: give --currency, --mode or --pace");
    }
    // Validated against the SAME lists `plan` resolves against, so a value
    // that stores here cannot fail later inside the compiler -- which would
    // be a trip permanently unable to plan, with the bad value invisible.
    if (mode !== null && !MODES.includes(mode as Mode)) {
      throw new Error(`invalid mode "${mode}" (expected one of: ${MODES.join(", ")})`);
    }
    if (pace !== null && !PACES.includes(pace as Pace)) {
      throw new Error(`invalid pace "${pace}" (expected one of: ${PACES.join(", ")})`);
    }
    if (currency !== null && currency.trim() === "") {
      throw new Error("--currency may not be empty (omit it to leave it unset)");
    }

    await setTripSettings(db, t.id, {
      ...(currency === null ? {} : { currency: currency.trim() }),
      ...(mode === null ? {} : { mode }),
      ...(pace === null ? {} : { pace }),
    });
    const after = await getActiveTrip(db);
    return json ? JSON.stringify(after) : "Updated.";
  }

  if (sub === "show") {
    const t = await getActiveTrip(db);
    if (!t) return json ? JSON.stringify(null) : "No active trip.";
    const travellers = await listTravellers(db, t.id);
    if (json) return JSON.stringify({ ...t, travellers });
    const lines = [
      `Trip:     ${t.name}`,
      `Dates:    ${t.startDate ?? "not set"} - ${t.endDate ?? "not set"}`,
      `Mode:     ${t.mode}`,
      `Pace:     ${t.pace}`,
    ];
    // Omitted entirely when unset. A "Currency: not set" line would be noise
    // on every trip that predates M5, and NULL already renders as bare
    // numbers everywhere a price appears.
    if (t.currency !== null) lines.push(`Currency: ${t.currency}`);
    // Always shown, even when empty: a trip with no travellers can compute no
    // prices at all, and that is worth stating rather than leaving to be
    // discovered at `trip plan`.
    lines.push(
      `Travellers: ${travellers.length === 0 ? "none" :
        travellers.map((v) => `${v.label} (b.${v.birthDate})`).join(", ")}`,
    );
    return lines.join("\n");
  }

  throw new Error(`unknown command: trip ${sub ?? ""}`);
}
