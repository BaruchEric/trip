import { expect, test, describe } from "bun:test";
import {
  familyOf, plausibilityReason, isKind, KINDS,
} from "@/geo/plausibility";
import type { PoiCandidate } from "@/geo/poi";

/** A candidate carrying only the two fields the rule reads. The rest are
 *  filled with values no assertion depends on. */
function poi(category: string | null, type: string | null): PoiCandidate {
  return {
    displayName: "somewhere", localName: null,
    latitude: 29.56, longitude: 106.55,
    category, type, importance: 0.0001,
    osmType: "node", osmId: 1, kmFromCentre: 1.2,
  };
}

describe("familyOf", () => {
  test("maps an exact category/type pair", () => {
    expect(familyOf("tourism", "hotel")).toBe("lodging");
    expect(familyOf("amenity", "place_of_worship")).toBe("worship");
  });

  test("maps a whole category where every type shares a family", () => {
    // `shop/*` is retail whatever the shop sells; OSM has hundreds of values.
    expect(familyOf("shop", "bakery")).toBe("retail");
    expect(familyOf("shop", "anything_at_all")).toBe("retail");
    expect(familyOf("highway", "pedestrian")).toBe("road");
  });

  test("an unmapped type has NO family", () => {
    // This is gate 1 and the reason the whole design has a family layer.
    // `building/yes` is OSM's catch-all: Hongya Cave, a CORRECT match in M3's
    // acceptance run, comes back this way.
    expect(familyOf("building", "yes")).toBeNull();
    expect(familyOf("place", "city")).toBeNull();
    expect(familyOf(null, null)).toBeNull();
  });

  test("`natural` splits by type, so it is not a whole-category mapping", () => {
    expect(familyOf("natural", "peak")).toBe("natural");
    expect(familyOf("natural", "water")).toBe("water");
    // Unlisted natural types stay uninformative rather than defaulting.
    expect(familyOf("natural", "spring")).toBeNull();
  });
});

describe("plausibilityReason", () => {
  test("an unmapped type never contradicts, whatever the kind", () => {
    // Hongya Cave. If this regresses, correct matches get queued.
    expect(plausibilityReason("landmark", poi("building", "yes"))).toBeNull();
    expect(plausibilityReason("park", poi("building", "yes"))).toBeNull();
    expect(plausibilityReason("street", poi("building", "yes"))).toBeNull();
  });

  test("a compatible family passes", () => {
    // Luohan Temple, correct in M3's acceptance run.
    expect(plausibilityReason("temple", poi("amenity", "place_of_worship")))
      .toBeNull();
  });

  test("an incompatible informative family contradicts", () => {
    // Jiefangbei Pedestrian Street -> a hotel whose NAME contains the street's.
    // The one wrong confident match M3 measured. This is the milestone.
    expect(plausibilityReason("street", poi("tourism", "hotel")))
      .toBe("type mismatch: expected street, got tourism/hotel");
  });

  test("tourism/attraction passes against every kind it could describe", () => {
    // It means "notable", not "of this type" — OSM applies it to scenic areas,
    // pedestrian streets, temples and stations alike. Filed under `culture` it
    // would flag correct matches in six of thirteen kinds. A later contributor
    // "completing" the map by refiling it fails here.
    for (const k of ["park", "street", "station", "nature", "viewpoint", "neighbourhood"] as const) {
      expect(plausibilityReason(k, poi("tourism", "attraction"))).toBeNull();
    }
  });

  test("landmark accepts everything except the three commercial families", () => {
    expect(plausibilityReason("landmark", poi("historic", "monument"))).toBeNull();
    expect(plausibilityReason("landmark", poi("railway", "station"))).toBeNull();
    expect(plausibilityReason("landmark", poi("tourism", "hotel"))).not.toBeNull();
    expect(plausibilityReason("landmark", poi("amenity", "restaurant"))).not.toBeNull();
    expect(plausibilityReason("landmark", poi("shop", "gift"))).not.toBeNull();
  });

  test("with no kind declared, the denylist covers lodging and retail only", () => {
    expect(plausibilityReason(null, poi("tourism", "hotel")))
      .toBe("unverified type: tourism/hotel, no kind declared");
    expect(plausibilityReason(null, poi("shop", "gift")))
      .toBe("unverified type: shop/gift, no kind declared");
    // food is deliberately NOT on the denylist: a video recommending one
    // restaurant by name is the ordinary case, not a suspicious one.
    expect(plausibilityReason(null, poi("amenity", "restaurant"))).toBeNull();
    expect(plausibilityReason(null, poi("building", "yes"))).toBeNull();
  });

  test("a declared compatible kind beats the denylist", () => {
    // A video that genuinely recommends a hotel. If the denylist fired anyway
    // we would have rebuilt the weakness that argued against a denylist-only
    // design in the first place.
    expect(plausibilityReason("hotel", poi("tourism", "hotel"))).toBeNull();
    expect(plausibilityReason("shop", poi("shop", "gift"))).toBeNull();
  });
});

describe("the kind vocabulary is closed", () => {
  test("isKind accepts every listed kind and nothing else", () => {
    for (const k of KINDS) expect(isKind(k)).toBe(true);
    expect(isKind("cave")).toBe(false);
    expect(isKind("")).toBe(false);
    expect(isKind("STREET")).toBe(false);
  });

  test("there are thirteen kinds", () => {
    // The spec's compatibility table has thirteen rows. A kind added to the
    // type union but not to KIND_FAMILIES would not compile; one added to both
    // but not documented fails here, which is the prompt to update the spec.
    expect(KINDS).toHaveLength(13);
  });
});
