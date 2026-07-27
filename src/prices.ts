import type { Client } from "@libsql/client";
import { validateRuleSet, type PriceRule } from "@/pricing/rules";

/** One rule table, two owners. A pass is a priced thing with age rules and a
 *  validity window; it differs from a segment in what owns it and when it is
 *  counted, not in how it is priced. */
export type OwnerKind = "segment" | "pass";

/** Replace an owner's rule set wholesale.
 *
 *  Validation happens HERE rather than only in the CLI parser, because M3 and
 *  M4 both shipped defects that were unreachable through the CLI and live
 *  through `ingest`. This is the seam every writer crosses. */
export async function setPriceRules(
  db: Client,
  kind: OwnerKind,
  ownerId: number,
  rules: PriceRule[],
): Promise<void> {
  validateRuleSet(rules);
  await db.batch(
    [
      {
        sql: `DELETE FROM price_rules WHERE owner_kind = ? AND owner_id = ?`,
        args: [kind, ownerId],
      },
      ...rules.map((r) => ({
        sql: `INSERT INTO price_rules (owner_kind, owner_id, min_age, max_age, price)
              VALUES (?, ?, ?, ?, ?)`,
        args: [kind, ownerId, r.minAge, r.maxAge, r.price] as (string | number | null)[],
      })),
    ],
    "write",
  );
}

export async function deletePriceRules(
  db: Client,
  kind: OwnerKind,
  ownerId: number,
): Promise<void> {
  await db.execute({
    sql: `DELETE FROM price_rules WHERE owner_kind = ? AND owner_id = ?`,
    args: [kind, ownerId],
  });
}

/** Rules for many owners at once, so renderers do not issue one query per
 *  segment.
 *
 *  An owner with no rules is ABSENT from the map rather than present with an
 *  empty array. Callers read `?? []`, which is unknown, which is correct —
 *  and the absence is itself readable, so a caller that wants to distinguish
 *  "no rules" from "never asked" can. */
export async function readPriceRules(
  db: Client,
  kind: OwnerKind,
  ownerIds: number[],
): Promise<Map<number, PriceRule[]>> {
  const out = new Map<number, PriceRule[]>();
  if (ownerIds.length === 0) return out;
  const placeholders = ownerIds.map(() => "?").join(",");
  const r = await db.execute({
    sql: `SELECT owner_id, min_age, max_age, price FROM price_rules
          WHERE owner_kind = ? AND owner_id IN (${placeholders})
          ORDER BY id`,
    args: [kind, ...ownerIds],
  });
  for (const row of r.rows) {
    const id = Number(row.owner_id);
    const list = out.get(id) ?? [];
    list.push({
      minAge: row.min_age === null ? null : Number(row.min_age),
      maxAge: row.max_age === null ? null : Number(row.max_age),
      price: Number(row.price),
    });
    out.set(id, list);
  }
  return out;
}
