import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpDb(name: string): string {
  const p = join(tmpdir(), `trip-test-${name}-${process.pid}.db`);
  rmSync(p, { force: true });
  return p;
}

describe("db", () => {
  test("migrate creates all M1 tables", async () => {
    const db = openDb(tmpDb("tables"));
    await migrate(db);
    const r = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = r.rows.map((row) => row.name as string);
    expect(names).toContain("trips");
    expect(names).toContain("destinations");
    expect(names).toContain("climate_months");
    expect(names).toContain("app_state");
  });

  test("migrate is idempotent", async () => {
    const db = openDb(tmpDb("idem"));
    await migrate(db);
    await migrate(db);
    const r = await db.execute("SELECT COUNT(*) AS n FROM trips");
    expect(r.rows[0]!.n).toBe(0);
  });

  test("climate_months enforces one row per city-month", async () => {
    const db = openDb(tmpDb("unique"));
    await migrate(db);
    // Seed the parent row: destination_id is a FK, and @libsql/client
    // enables `PRAGMA foreign_keys` by default, so an orphan destination_id
    // would fail on the FK check before ever reaching the PK/UNIQUE
    // constraint this test is actually asserting.
    await db.execute({
      sql: `INSERT INTO destinations (name, latitude, longitude) VALUES (?, ?, ?)`,
      args: ["Testville", 0, 0],
    });
    const args = [1, 5, 14.2, 22.1, 4, "2026-07-26"];
    await db.execute({
      sql: `INSERT INTO climate_months
            (destination_id, month, dew_point_mean, temp_max_mean, rain_days, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args,
    });
    await expect(
      db.execute({
        sql: `INSERT INTO climate_months
              (destination_id, month, dew_point_mean, temp_max_mean, rain_days, fetched_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args,
      }),
    ).rejects.toThrow();
  });
});
