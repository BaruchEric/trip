import type { Client } from "@libsql/client";
import { existsSync, writeFileSync } from "node:fs";
import { buildExportView } from "@/export/view";
import { renderMarkdownExport } from "@/export/markdown";
import { renderIcs } from "@/export/ical";
import { renderGeoJson } from "@/export/geojson";

export const EXPORT_FORMATS = ["ics", "md", "geojson"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportDeps {
  /** iCalendar requires a DTSTAMP. Injected so the output is reproducible. */
  now?: () => string;
}

function flag(argv: string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
}

export async function runExportCommand(
  db: Client,
  argv: string[],
  json: boolean,
  deps: ExportDeps = {},
): Promise<string> {
  const format = flag(argv, "--format");
  // Required, never defaulted: a default would silently pick one of three
  // files the user asked for by name.
  if (format === null) {
    throw new Error(
      `--format is required (one of ${EXPORT_FORMATS.join(", ")})`,
    );
  }
  if (!EXPORT_FORMATS.includes(format as ExportFormat)) {
    throw new Error(
      `invalid --format "${format}" (expected ${EXPORT_FORMATS.join(", ")})`,
    );
  }

  const view = await buildExportView(db);
  const now = (deps.now ?? (() => new Date().toISOString()))()
    .replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

  const body =
    format === "md" ? renderMarkdownExport(view)
    : format === "ics" ? renderIcs(view, now)
    : renderGeoJson(view);

  const out = flag(argv, "--out");
  if (out === null) {
    // stdout, so the export composes with a pipe and an agent can read it
    // without touching disk.
    return json
      ? JSON.stringify({ format, wroteTo: null, body })
      : body;
  }

  if (out.trim() === "") throw new Error("--out needs a path");
  // An export that silently replaces a file the user edited is data loss.
  if (existsSync(out) && !argv.includes("--force")) {
    throw new Error(`${out} already exists (pass --force to overwrite)`);
  }
  writeFileSync(out, body);

  const stops = view.days.reduce((n, d) => n + d.stops.length, 0);
  if (json) {
    return JSON.stringify({
      format, wroteTo: out, stops, unplaced: view.unplaced.length,
      bytes: Buffer.byteLength(body, "utf8"),
    });
  }
  // Never silent: it says what it wrote and how much of the trip is in it.
  return `wrote ${out} (${format}): ${stops} stop${stops === 1 ? "" : "s"}, ` +
    `${view.unplaced.length} not planned`;
}
