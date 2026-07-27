import type { ExportView } from "@/export/view";

/** RFC 7946 GeoJSON.
 *
 *  The interesting property is that a Feature may be UNLOCATED: "the value of
 *  the geometry member SHALL be either a Geometry object ... or, in the case
 *  that the Feature is unlocated, a JSON null value." That is a first-class
 *  representation of a place whose location is unknown, which is exactly a
 *  segment the tool could not geocode.
 *
 *  Coordinates are LONGITUDE, LATITUDE. Reversed, Chongqing lands in the
 *  Indian Ocean and the file still parses — the failure mode is a plausible
 *  wrong answer rather than an error, which is why it is asserted separately
 *  from iCalendar's GEO, whose order is the opposite. */

export function renderGeoJson(v: ExportView): string {
  const features: unknown[] = [];

  for (const d of v.days) {
    for (const s of d.stops) {
      const properties = {
        kind: "stop",
        segmentId: s.segmentId,
        name: s.name,
        localName: s.localName,
        day: d.day,
        date: d.date,
        startMinute: s.startMin,
        endMinute: s.endMin,
        // null is UNKNOWN and 0 is free. Emitting 0 for unknown here would
        // put a free museum and an unpriced one on the same map layer.
        price: s.price,
        currency: v.currency,
        // false means the plan scheduled this without knowing when it opens.
        hoursKnown: s.hoursKnown,
        pinned: s.pinned,
        tags: s.tags,
      };
      features.push(
        s.latitude === null || s.longitude === null
          ? { type: "Feature", geometry: null, properties }
          : {
              type: "Feature",
              geometry: { type: "Point", coordinates: [s.longitude, s.latitude] },
              properties,
            },
      );
    }
  }

  // One LineString per hop, so a map shows what M8 measured: Testbed 2 and
  // Liziba look 360 m apart and are 22 minutes apart on foot.
  for (const d of v.days) {
    for (let i = 1; i < d.stops.length; i++) {
      const from = d.stops[i - 1]!, to = d.stops[i]!;
      const hop = to.arriveBy;
      if (!hop) continue;
      if (from.latitude === null || from.longitude === null) continue;
      if (to.latitude === null || to.longitude === null) continue;
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [from.longitude, from.latitude],
            [to.longitude, to.latitude],
          ],
        },
        properties: {
          kind: "hop",
          day: d.day,
          from: from.name,
          to: to.name,
          minutes: hop.minutes,
          mode: hop.mode,
          // A boolean, never a string: an agent must be able to tell a
          // measured leg from a modelled one without parsing prose. The
          // straight line drawn here is NOT the route walked.
          basis: hop.basis,
        },
      });
    }
  }

  for (const u of v.unplaced) {
    // RFC 7946's unlocated Feature, used for exactly what it is for.
    features.push({
      type: "Feature",
      geometry: null,
      properties: {
        kind: "unplaced",
        segmentId: u.segmentId,
        name: u.name,
        reason: u.reason,
      },
    });
  }

  // A foreign member on the FeatureCollection, which RFC 7946 permits. Like
  // the ICS X- properties this is carried but invisible in most clients, so
  // it names the Markdown export as the complete record.
  return `${JSON.stringify({
    type: "FeatureCollection",
    features,
    trip: {
      name: v.tripName,
      mode: v.mode,
      startDate: v.startDate,
      currency: v.currency,
      total: v.tripTotal.total,
      unknownPrices: v.tripTotal.unknown,
      unplacedCount: v.unplaced.length,
      note: "Per-traveller costs are not represented here. " +
        "The Markdown export is the complete record.",
    },
  }, null, 2)}\n`;
}
