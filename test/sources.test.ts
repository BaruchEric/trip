import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import {
  upsertSource, getSourceByUrl, getSource, latestSource, listSources,
} from "@/sources";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-src-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  await db.execute({
    sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
    args: ["chongqing", "2026-07-27"],
  });
  return db;
}

const VIDEO = {
  url: "https://www.youtube.com/watch?v=KHHlcCUTwZA",
  title: "4 Days in Chongqing",
  uploader: "Some Traveller",
  durationSeconds: 1694,
  transcript: "[00:42] welcome to Chongqing",
  transcriptSource: "captions",
  fetchedAt: "2026-07-27T10:00:00Z",
};

describe("sources", () => {
  test("a source round-trips", async () => {
    const db = await freshDb("round");
    const id = await upsertSource(db, 1, VIDEO);
    const s = await getSource(db, 1, id);
    expect(s!.title).toBe("4 Days in Chongqing");
    expect(s!.durationSeconds).toBe(1694);
    expect(s!.transcriptSource).toBe("captions");
  });

  test("an absent transcript stays NULL, not empty string", async () => {
    const db = await freshDb("no-transcript");
    const id = await upsertSource(db, 1, {
      ...VIDEO, transcript: null, transcriptSource: null,
    });
    const s = await getSource(db, 1, id);
    expect(s!.transcript).toBeNull();
    expect(s!.transcriptSource).toBeNull();
  });

  test("an empty transcript is a different fact from an absent one", async () => {
    const db = await freshDb("empty-transcript");
    const id = await upsertSource(db, 1, { ...VIDEO, transcript: "" });
    const s = await getSource(db, 1, id);
    expect(s!.transcript).toBe("");
    expect(s!.transcript).not.toBeNull();
  });

  test("re-watching the same url updates the row instead of duplicating it", async () => {
    const db = await freshDb("upsert");
    const first = await upsertSource(db, 1, { ...VIDEO, transcript: null });
    const second = await upsertSource(db, 1, VIDEO);
    expect(second).toBe(first);
    expect((await listSources(db, 1)).length).toBe(1);
    expect((await getSource(db, 1, first))!.transcript).toBe("[00:42] welcome to Chongqing");
  });

  test("lookup by url is scoped to the trip", async () => {
    const db = await freshDb("scoped");
    await db.execute({
      sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
      args: ["other", "2026-07-27"],
    });
    await upsertSource(db, 1, VIDEO);
    expect(await getSourceByUrl(db, 2, VIDEO.url)).toBeNull();
    expect(await getSourceByUrl(db, 1, VIDEO.url)).not.toBeNull();
  });

  test("latestSource returns the most recently fetched", async () => {
    const db = await freshDb("latest");
    await upsertSource(db, 1, { ...VIDEO, url: "a", fetchedAt: "2026-07-01T00:00:00Z" });
    const newer = await upsertSource(db, 1, { ...VIDEO, url: "b", fetchedAt: "2026-07-20T00:00:00Z" });
    expect((await latestSource(db, 1))!.id).toBe(newer);
  });

  test("latestSource is null for a trip with no sources", async () => {
    const db = await freshDb("latest-none");
    expect(await latestSource(db, 1)).toBeNull();
  });
});
