import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { runReviewCommand } from "@/commands/review";
import { createMention, setCandidates, queueMention, rejectMention } from "@/mentions";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function queued(tag: string) {
  const p = join(tmpdir(), `trip-review-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  await db.execute({
    sql: `INSERT INTO destinations (name, country_code, latitude, longitude)
          VALUES (?, ?, ?, ?)`,
    args: ["Chongqing", "cn", 29.5630, 106.5516],
  });
  await db.execute({
    sql: `INSERT INTO trips (name, destination_id, created_at) VALUES (?, ?, ?)`,
    args: ["chongqing", 1, "2026-07-27"],
  });
  // active_trip stores the trip's NAME (see trips.ts getActiveTrip), not its id —
  // the brief's own snippet used '1' here, which getTripByName would never match
  // against a trip named "chongqing"; every test would fail on "no active trip"
  // before ever reaching the code under test.
  await db.execute({
    sql: `INSERT INTO app_state (key, value) VALUES ('active_trip','chongqing')`,
  });
  await db.execute({
    sql: `INSERT INTO sources (trip_id, url, fetched_at) VALUES (?, ?, ?)`,
    args: [1, "https://youtu.be/x", "2026-07-27T00:00:00Z"],
  });
  const id = await createMention(db, 1, 1, {
    text: "hot pot", atSeconds: 272, dwellMinutes: null, tags: [],
  });
  await setCandidates(db, id, [{
    rank: 1, displayName: "夜福火锅, 渝中区, 重庆市", localName: "夜福火锅",
    latitude: 29.563, longitude: 106.567,
    category: "amenity", type: "restaurant", importance: 0.0001,
    osmType: "node", osmId: 1, kmFromCentre: 1.4,
  }]);
  await queueMention(db, id, "1 candidate");
  return { db, id };
}

describe("trip review ls", () => {
  test("lists pending mentions", async () => {
    const { db } = await queued("ls");
    const out = await runReviewCommand(db, ["ls"], false);
    expect(out).toContain("hot pot");
    expect(out).toContain("夜福火锅");
  });

  test("json carries the candidates an agent picks from", async () => {
    const { db, id } = await queued("ls-json");
    const out = JSON.parse(await runReviewCommand(db, ["ls"], true));
    expect(out.pending.length).toBe(1);
    expect(out.pending[0].id).toBe(id);
    expect(out.pending[0].candidates[0].rank).toBe(1);
    expect(out.searchRadiusKm).toBe(25);
  });

  test("resolved and rejected mentions are not listed", async () => {
    const { db, id } = await queued("ls-filter");
    await rejectMention(db, id, "2026-07-27T12:00:00Z");
    const out = JSON.parse(await runReviewCommand(db, ["ls"], true));
    expect(out.pending).toEqual([]);
  });

  test("--source scopes the queue to one video", async () => {
    const { db } = await queued("ls-source");
    const out = JSON.parse(await runReviewCommand(db, ["ls", "--source=99"], true));
    expect(out.pending).toEqual([]);
  });

  test("an unknown subcommand is a usage error", async () => {
    const { db } = await queued("ls-bad");
    await expect(runReviewCommand(db, ["frobnicate"], false)).rejects.toThrow(/usage/i);
  });
});
