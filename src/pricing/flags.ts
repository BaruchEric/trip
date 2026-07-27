import { parsePriceRule, type PriceRule } from "@/pricing/rules";

/** Read the repeatable `--price` flags, with `--cost` as an exact alias for a
 *  single bare `--price`.
 *
 *  Shared by `seg add`, `seg price` and `pass add` rather than copied into
 *  each: the `--cost`/`--price` conflict rule below must be identical in all
 *  three, and three copies would drift.
 *
 *  `--cost` survives its own column's removal because it is documented in
 *  USAGE and carries the F5 empty-value regression test. Supplying BOTH is an
 *  error rather than a silent precedence rule — a silent winner would price a
 *  place differently from what the user typed, with nothing saying so. */
export function parsePriceFlags(
  argv: string[],
  flags: (argv: string[], name: string) => string[],
  flag: (argv: string[], name: string) => string | null,
): PriceRule[] {
  const priceRaw = flags(argv, "--price");
  const costRaw = flag(argv, "--cost");

  if (costRaw !== null && priceRaw.length > 0) {
    throw new Error("--cost and --price are the same thing; supply only one");
  }
  if (costRaw !== null) {
    // F5 lives on: Number("") is 0, not NaN, so `--cost=` would silently
    // store a real 0 and declare the place FREE.
    if (costRaw.trim() === "") throw new Error(`invalid --cost "${costRaw}"`);
    return [parsePriceRule(costRaw)];
  }
  return priceRaw.map(parsePriceRule);
}
