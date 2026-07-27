import { test, expect, describe } from "bun:test";
import { renderIcs, foldLine, escapeText } from "@/export/ical";
import { renderGeoJson } from "@/export/geojson";
import { renderMarkdownExport } from "@/export/markdown";
import type { ExportView, ExportStop } from "@/export/view";

function stop(o: Partial<ExportStop> = {}): ExportStop {
  return {
    segmentId: 1, name: "Hongya Cave", localName: null,
    latitude: 29.5650738, longitude: 106.5753425,
    startMin: 540, endMin: 630, endsNextDay: false, pinned: false,
    hoursKnown: false, price: null, tags: [], arriveBy: null, ...o,
  };
}

function view(o: Partial<ExportView> = {}): ExportView {
  return {
    tripName: "chongqing", startDate: "2026-09-01", currency: "CNY",
    mode: "walking",
    days: [{
      day: 1, date: "2026-09-01", weekday: "tue", startMin: 540, endMin: 1140,
      stops: [stop()], dayTotal: { total: null, unknown: 1 },
    }],
    unplaced: [], travellers: [], perTraveller: [],
    tripTotal: { total: null, unknown: 1 },
    passTotal: { total: 0, unknown: 0 }, calibration: null, ...o,
  };
}

const NOW = "20260727T120000Z";

describe("iCalendar", () => {
  test("unknown hours become TENTATIVE, known hours CONFIRMED", () => {
    // The one place a calendar can natively say "this might be wrong".
    const ics = renderIcs(view({
      days: [{
        day: 1, date: "2026-09-01", weekday: "tue", startMin: 540, endMin: 1140,
        stops: [
          stop({ segmentId: 1, hoursKnown: false }),
          stop({ segmentId: 2, name: "Luohan Temple", hoursKnown: true, startMin: 700, endMin: 760 }),
        ],
        dayTotal: { total: null, unknown: 2 },
      }],
    }), NOW);
    expect(ics.match(/STATUS:TENTATIVE/g)).toHaveLength(1);
    expect(ics.match(/STATUS:CONFIRMED/g)).toHaveLength(1);
  });

  test("an unplaced segment is an all-day event whose SUMMARY leads with the reason", () => {
    // VTODO would be semantically right and Google Calendar ignores it, so
    // the item would vanish silently -- the exact failure this prevents.
    const ics = renderIcs(view({
      unplaced: [{ segmentId: 9, name: "Wulong Karst", reason: "no coordinates" }],
    }), NOW);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260901");
    expect(ics).toContain("DTEND;VALUE=DATE:20260902");
    expect(ics).toMatch(/SUMMARY:Not planned: Wulong Karst - no coordinates/);
    expect(ics).not.toContain("BEGIN:VTODO");
  });

  test("folds at 75 OCTETS, never splitting a UTF-8 sequence", () => {
    // 洪崖洞 is three bytes per character. Folding by character count
    // overruns 75 octets, and splitting mid-sequence is mojibake everywhere.
    const folded = foldLine(`SUMMARY:${"洪崖洞".repeat(40)}`);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(75);
    }
    for (const p of parts.slice(1)) expect(p.startsWith(" ")).toBe(true);
    // And it round-trips: no replacement characters anywhere.
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join(""))
      .toBe(`SUMMARY:${"洪崖洞".repeat(40)}`);
    expect(folded).not.toContain("�");
  });

  test("escapes backslash, semicolon, comma and newline in TEXT", () => {
    expect(escapeText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });

  test("GEO is LATITUDE;LONGITUDE -- the opposite of GeoJSON", () => {
    // Reversed, this is a plausible location in the wrong hemisphere.
    const ics = renderIcs(view(), NOW);
    expect(ics).toContain("GEO:29.5650738;106.5753425");
  });

  test("an unknown price says so and a zero price says free", () => {
    expect(renderIcs(view(), NOW)).toContain("price unknown");
    const free = renderIcs(view({
      days: [{ day: 1, date: "2026-09-01", weekday: "tue", startMin: 540, endMin: 1140,
        stops: [stop({ price: 0 })], dayTotal: { total: 0, unknown: 0 } }],
    }), NOW);
    expect(free).toContain("free");
    expect(free).not.toContain("price unknown");
  });

  test("UID is stable across two renders, so re-import updates", () => {
    const a = renderIcs(view(), NOW), b = renderIcs(view(), NOW);
    expect(a).toBe(b);
    expect(a).toContain("UID:trip-chongqing-seg-1@trip.local");
  });

  test("every line ends CRLF and the object is VCALENDAR-wrapped", () => {
    const ics = renderIcs(view(), NOW);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.split("\r\n").filter((l) => l.endsWith("\n"))).toHaveLength(0);
  });

  test("the unknown-count trailer rides on the VCALENDAR", () => {
    const ics = renderIcs(view({ tripTotal: { total: 10, unknown: 4 } }), NOW);
    expect(ics).toContain("X-TRIP-PRICE-UNKNOWN:4");
    expect(ics).toMatch(/X-WR-CALDESC:.*Markdown/s);
  });

  test("a hop is described as measured or estimated", () => {
    const ics = renderIcs(view({
      days: [{ day: 1, date: "2026-09-01", weekday: "tue", startMin: 540, endMin: 1140,
        stops: [stop(), stop({ segmentId: 2, startMin: 700, endMin: 760,
          arriveBy: { minutes: 22, basis: "measured", mode: "walking" } })],
        dayTotal: { total: null, unknown: 2 } }],
    }), NOW);
    // Three-valued since M12: a station-graph result and the bare constant
    // used to serialise identically as MEASURED:FALSE, and they are not the
    // same claim.
    expect(ics).toContain("X-TRIP-TRAVEL-BASIS:MEASURED");
    expect(ics).toMatch(/22 min walking \(measured\)/);
  });
});

describe("GeoJSON", () => {
  test("an unplaced segment is a Feature with geometry null", () => {
    // RFC 7946: "in the case that the Feature is unlocated, a JSON null value."
    const g = JSON.parse(renderGeoJson(view({
      unplaced: [{ segmentId: 9, name: "Wulong Karst", reason: "no coordinates" }],
    })));
    const f = g.features.find((x: any) => x.properties.kind === "unplaced");
    expect(f).toBeDefined();
    expect(f.geometry).toBeNull();
    expect(f.properties.reason).toBe("no coordinates");
  });

  test("coordinates are LONGITUDE, LATITUDE", () => {
    // Reversed, Chongqing lands in the Indian Ocean and the file still parses.
    const g = JSON.parse(renderGeoJson(view()));
    const p = g.features.find((x: any) => x.properties.kind === "stop");
    expect(p.geometry.coordinates[0]).toBeCloseTo(106.575, 2);
    expect(p.geometry.coordinates[1]).toBeCloseTo(29.565, 2);
  });

  test("each hop is a LineString carrying basis as a known enum string", () => {
    const g = JSON.parse(renderGeoJson(view({
      days: [{ day: 1, date: "2026-09-01", weekday: "tue", startMin: 540, endMin: 1140,
        stops: [stop(), stop({ segmentId: 2, latitude: 29.5537638, longitude: 106.5368476,
          startMin: 700, endMin: 760,
          arriveBy: { minutes: 22, basis: "measured", mode: "walking" } })],
        dayTotal: { total: null, unknown: 2 } }],
    })));
    const hop = g.features.find((x: any) => x.properties.kind === "hop");
    expect(hop.geometry.type).toBe("LineString");
    // An ENUM, not prose. A map client must be able to branch on it without
    // parsing English -- the same reason M10 made this a boolean rather than
    // a sentence. M12 widened it to three values because a station-graph
    // result and the bare straight-line constant are different claims.
    expect(hop.properties.basis).toBe("measured");
    expect(["measured", "osm-graph", "model"]).toContain(hop.properties.basis);
  });

  test("unknown price is null and free is 0", () => {
    const unknown = JSON.parse(renderGeoJson(view()));
    expect(unknown.features[0].properties.price).toBeNull();
    const free = JSON.parse(renderGeoJson(view({
      days: [{ day: 1, date: "2026-09-01", weekday: "tue", startMin: 540, endMin: 1140,
        stops: [stop({ price: 0 })], dayTotal: { total: 0, unknown: 0 } }],
    })));
    expect(free.features[0].properties.price).toBe(0);
  });

  test("no Feature carries a coordinates or features member", () => {
    // RFC 7946 7.1: semantics of GeoJSON members are not changeable.
    const g = JSON.parse(renderGeoJson(view({
      unplaced: [{ segmentId: 9, name: "Wulong Karst", reason: "no coordinates" }],
    })));
    expect(g.type).toBe("FeatureCollection");
    for (const f of g.features) {
      expect(f.type).toBe("Feature");
      expect("geometry" in f).toBe(true);
      expect("properties" in f).toBe(true);
      expect("coordinates" in f).toBe(false);
      expect("features" in f).toBe(false);
    }
  });

  test("the FeatureCollection carries the totals as a foreign member", () => {
    const g = JSON.parse(renderGeoJson(view({ tripTotal: { total: 10, unknown: 4 } })));
    expect(g.trip.unknownPrices).toBe(4);
    expect(g.trip.note).toMatch(/Markdown/);
  });
});

describe("Markdown", () => {
  test("free and unknown are different words", () => {
    expect(renderMarkdownExport(view())).toContain("unknown");
    expect(renderMarkdownExport(view({
      days: [{ day: 1, date: "2026-09-01", weekday: "tue", startMin: 540, endMin: 1140,
        stops: [stop({ price: 0 })], dayTotal: { total: 0, unknown: 0 } }],
    }))).toContain("free");
  });

  test("says the total is a FLOOR when prices are unknown", () => {
    const md = renderMarkdownExport(view({ tripTotal: { total: 10, unknown: 4 } }));
    expect(md).toMatch(/floor, not an estimate/);
  });

  test("lists unplaced segments with their reasons", () => {
    const md = renderMarkdownExport(view({
      unplaced: [{ segmentId: 9, name: "Wulong Karst", reason: "no coordinates" }],
    }));
    expect(md).toContain("Not planned (1)");
    expect(md).toContain("Wulong Karst");
    expect(md).toContain("no coordinates");
  });

  test("with no legs it says how wrong the times are is UNKNOWN", () => {
    const md = renderMarkdownExport(view());
    expect(md).toMatch(/unknown/i);
    expect(md).toContain("trip route");
  });

  test("hours unknown is marked on the stop", () => {
    expect(renderMarkdownExport(view())).toContain("hours unknown");
  });
});
