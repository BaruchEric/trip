import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import {
  createMention, setCandidates, listMentions, getMention,
  resolveMention, queueMention, rejectMention, renameMention,
  unlinkSegment, deleteUnresolvedMentions,
} from "@/mentions";
import { addSegment } from "@/segments";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-men-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  await db.execute({
    sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
    args: ["chongqing", "2026-07-27"],
  });
  await db.execute({
    sql: `INSERT INTO sources (trip_id, url, fetched_at) VALUES (?, ?, ?)`,
    args: [1, "https://youtu.be/x", "2026-07-27T00:00:00Z"],
  });
  return db;
}

const HOTPOT = {
  text: "hot pot", atSeconds: 272, dwellMinutes: null, tags: ["food"],
  kind: null, price: [],
};

const CANDIDATE = {
  rank: 1, displayName: "夜福火锅", localName: "夜福火锅",
  latitude: 29.5630, longitude: 106.567,
  category: "amenity", type: "restaurant", importance: 0.0001,
  osmType: "node", osmId: 123, kmFromCentre: 1.4,
};

describe("mentions", () => {
  test("kind round-trips, and NULL means none was declared", async () => {
    const db = await freshDb("kind-roundtrip");

    const withKind = await createMention(db, 1, 1, {
      text: "Jiefangbei Pedestrian Street",
      atSeconds: 272, dwellMinutes: null, tags: [], kind: "street", price: [],
    });
    const without = await createMention(db, 1, 1, {
      text: "that ramen spot",
      atSeconds: null, dwellMinutes: null, tags: [], kind: null, price: [],
    });

    expect((await getMention(db, 1, withKind))!.kind).toBe("street");
    // NULL, not "". An undeclared kind is a fact worth keeping distinct: it is
    // what routes the mention to the denylist instead of the kind comparison.
    expect((await getMention(db, 1, without))!.kind).toBeNull();
  });

  test("a new mention is pending and carries its reason", async () => {
    const db = await freshDb("pending");
    const id = await createMention(db, 1, 1, HOTPOT);
    await queueMention(db, id, "5 candidates");
    const m = (await getMention(db, 1, id))!;
    expect(m.state).toBe("pending");
    expect(m.reason).toBe("5 candidates");
    expect(m.segmentId).toBeNull();
    expect(m.name).toBe("hot pot");
  });

  test("an absent timestamp stays NULL, not 0", async () => {
    const db = await freshDb("no-ts");
    const id = await createMention(db, 1, 1, { ...HOTPOT, atSeconds: null });
    expect((await getMention(db, 1, id))!.atSeconds).toBeNull();
  });

  test("resolving sets the segment and clears the reason in one move", async () => {
    const db = await freshDb("resolve");
    const id = await createMention(db, 1, 1, HOTPOT);
    await queueMention(db, id, "5 candidates");
    const segId = await addSegment(db, 1, {
      name: "Yuwei Hot Pot", latitude: 29.54, longitude: 106.56,
      dwellMinutes: 60, freeDays: [], tags: [],
      opensMin: null, closesMin: null, closedDays: [],
    });
    await resolveMention(db, id, segId);
    const m = (await getMention(db, 1, id))!;
    expect(m.state).toBe("resolved");
    expect(m.segmentId).toBe(segId);
    expect(m.reason).toBeNull();
  });

  test("a mention never holds both a segment and a reason", async () => {
    const db = await freshDb("invariant");
    const id = await createMention(db, 1, 1, HOTPOT);
    const segId = await addSegment(db, 1, {
      name: "x", latitude: 1, longitude: 1, dwellMinutes: 30, freeDays: [],
      tags: [], opensMin: null, closesMin: null, closedDays: [],
    });
    await resolveMention(db, id, segId);
    await queueMention(db, id, "back to the queue");
    const m = (await getMention(db, 1, id))!;
    expect(m.segmentId).toBeNull();
    expect(m.reason).toBe("back to the queue");
    expect(m.state).toBe("pending");
  });

  test("rejecting wins over everything and is visible as rejected", async () => {
    const db = await freshDb("reject");
    const id = await createMention(db, 1, 1, HOTPOT);
    await rejectMention(db, id, "2026-07-27T12:00:00Z");
    expect((await getMention(db, 1, id))!.state).toBe("rejected");
  });

  test("renaming keeps the video's original words", async () => {
    const db = await freshDb("rename");
    const id = await createMention(db, 1, 1, { ...HOTPOT, text: "that ramen spot" });
    await renameMention(db, id, "Ichiran Chongqing");
    const m = (await getMention(db, 1, id))!;
    expect(m.text).toBe("that ramen spot");
    expect(m.resolvedName).toBe("Ichiran Chongqing");
    expect(m.name).toBe("Ichiran Chongqing");
  });

  test("candidates come back ranked, and setCandidates replaces rather than appends", async () => {
    const db = await freshDb("cands");
    const id = await createMention(db, 1, 1, HOTPOT);
    await setCandidates(db, id, [
      { ...CANDIDATE, rank: 2, displayName: "second" },
      { ...CANDIDATE, rank: 1, displayName: "first" },
    ]);
    // Read before replacing: inserted 2-then-1, must come back 1-then-2.
    const ranked = (await getMention(db, 1, id))!.candidates;
    expect(ranked.map((c) => c.displayName)).toEqual(["first", "second"]);

    await setCandidates(db, id, [{ ...CANDIDATE, rank: 1, displayName: "only" }]);
    const m = (await getMention(db, 1, id))!;
    expect(m.candidates.length).toBe(1);
    expect(m.candidates[0]!.displayName).toBe("only");
  });

  test("rejection wins over a segment the mention once had", async () => {
    const db = await freshDb("reject-after-resolve");
    const id = await createMention(db, 1, 1, HOTPOT);
    const segId = await addSegment(db, 1, {
      name: "x", latitude: 1, longitude: 1, dwellMinutes: 30, freeDays: [],
      tags: [], opensMin: null, closesMin: null, closedDays: [],
    });
    await resolveMention(db, id, segId);
    await rejectMention(db, id, "2026-07-27T12:00:00Z");

    const m = (await getMention(db, 1, id))!;
    // Both facts are on the row. mentionState checks rejected_at FIRST, so the
    // terminal decision wins over the earlier one. Swapping those two branches
    // would report "resolved" here and no other test would notice.
    expect(m.segmentId).toBe(segId);
    expect(m.rejectedAt).not.toBeNull();
    expect(m.state).toBe("rejected");
  });

  test("deleting a segment returns its mention to the queue", async () => {
    const db = await freshDb("unlink");
    const id = await createMention(db, 1, 1, HOTPOT);
    const segId = await addSegment(db, 1, {
      name: "x", latitude: 1, longitude: 1, dwellMinutes: 30, freeDays: [],
      tags: [], opensMin: null, closesMin: null, closedDays: [],
    });
    await resolveMention(db, id, segId);
    await unlinkSegment(db, segId, "segment deleted");
    const m = (await getMention(db, 1, id))!;
    expect(m.state).toBe("pending");
    expect(m.reason).toBe("segment deleted");
  });

  test("listMentions filters by state and by source", async () => {
    const db = await freshDb("filter");
    const a = await createMention(db, 1, 1, HOTPOT);
    await queueMention(db, a, "no match");
    const b = await createMention(db, 1, 1, { ...HOTPOT, text: "Hongya Cave" });
    await rejectMention(db, b, "2026-07-27T12:00:00Z");
    expect((await listMentions(db, 1, { state: "pending" })).length).toBe(1);
    expect((await listMentions(db, 1, { sourceId: 1 })).length).toBe(2);
    expect((await listMentions(db, 1, { sourceId: 99 })).length).toBe(0);
  });

  test("deleteUnresolvedMentions clears pending and rejected but not resolved", async () => {
    const db = await freshDb("delete-unresolved");
    const pending = await createMention(db, 1, 1, HOTPOT);
    await setCandidates(db, pending, [CANDIDATE]);
    await queueMention(db, pending, "5 candidates");
    const resolved = await createMention(db, 1, 1, { ...HOTPOT, text: "Hongya Cave" });
    const segId = await addSegment(db, 1, {
      name: "Hongya Cave", latitude: 29.565, longitude: 106.575,
      dwellMinutes: 90, freeDays: [], tags: [],
      opensMin: null, closesMin: null, closedDays: [],
    });
    await resolveMention(db, resolved, segId);
    const rejected = await createMention(db, 1, 1, { ...HOTPOT, text: "noodles" });
    await rejectMention(db, rejected, "2026-07-27T12:00:00Z");

    const removed = await deleteUnresolvedMentions(db, 1, 1);
    expect(removed).toBe(2);            // pending AND rejected, not just pending
    const left = await listMentions(db, 1);
    expect(left.length).toBe(1);
    expect(left[0]!.state).toBe("resolved");
    const orphans = await db.execute(`SELECT COUNT(*) AS n FROM mention_candidates`);
    expect(Number(orphans.rows[0]!.n)).toBe(0);
  });
});
