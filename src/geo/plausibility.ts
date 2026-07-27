import type { PoiCandidate } from "@/geo/poi";

/** What kind of thing a place IS, coarse enough that OSM's tagging habits do
 *  not have to be memorised, fine enough that a hotel is not a street.
 *
 *  Eleven, and the set is closed. A twelfth would need a row in every kind's
 *  acceptable list, which is the point: adding one is a deliberate act. */
export type Family =
  | "lodging" | "food" | "retail" | "worship" | "transport"
  | "greenspace" | "culture" | "road" | "water" | "natural" | "civic";

/** Exact `category/type` pairs.
 *
 *  ANYTHING ABSENT FROM THIS MAP AND `CATEGORY_FAMILY` IS UNINFORMATIVE, and
 *  an uninformative type never contradicts anything. That default is the
 *  design, not an oversight: an incomplete map then yields false negatives —
 *  M3's status quo — rather than queueing correct matches.
 *
 *  `tourism/attraction` is DELIBERATELY ABSENT. It records THAT a place draws
 *  visitors, not WHAT it is: OSM applies it to scenic areas, pedestrian
 *  streets, temples and stations alike, so as an informative type it would
 *  contradict `park`, `street`, `station`, `nature`, `viewpoint` and
 *  `neighbourhood` — six of the thirteen kinds, on correct matches.
 *  `building/yes` is absent for the same reason, and is the case that killed
 *  the naive form of this check: Hongya Cave, correct, comes back that way. */
const TYPE_FAMILY: Record<string, Family> = {
  "tourism/hotel": "lodging",
  "tourism/hostel": "lodging",
  "tourism/guest_house": "lodging",
  "tourism/motel": "lodging",
  "tourism/apartment": "lodging",

  "amenity/restaurant": "food",
  "amenity/cafe": "food",
  "amenity/fast_food": "food",
  "amenity/bar": "food",
  "amenity/pub": "food",
  "amenity/food_court": "food",
  "amenity/ice_cream": "food",

  "amenity/marketplace": "retail",

  "amenity/place_of_worship": "worship",
  "historic/wayside_shrine": "worship",

  "railway/station": "transport",
  "railway/halt": "transport",
  "railway/subway_entrance": "transport",
  "amenity/bus_station": "transport",
  "amenity/ferry_terminal": "transport",
  "aeroway/aerodrome": "transport",

  "leisure/park": "greenspace",
  "leisure/garden": "greenspace",
  "leisure/nature_reserve": "greenspace",

  "tourism/museum": "culture",
  "tourism/gallery": "culture",
  "tourism/artwork": "culture",
  "historic/monument": "culture",
  "historic/memorial": "culture",
  "historic/castle": "culture",
  "amenity/theatre": "culture",
  "amenity/arts_centre": "culture",

  "place/square": "road",

  // `natural` splits, so it CANNOT be a whole-category mapping below.
  "natural/water": "water",
  "natural/bay": "water",
  "waterway/river": "water",

  "natural/peak": "natural",
  "natural/cave_entrance": "natural",
  "natural/cliff": "natural",
  "natural/beach": "natural",
  "natural/volcano": "natural",

  "amenity/university": "civic",
  "amenity/hospital": "civic",
  "amenity/townhall": "civic",
  "amenity/library": "civic",
};

/** Categories where every type shares one family, so listing OSM's hundreds of
 *  `shop/*` values would be busywork. Consulted only after `TYPE_FAMILY`. */
const CATEGORY_FAMILY: Record<string, Family> = {
  shop: "retail",
  highway: "road",
  public_transport: "transport",
};

/** NULL means uninformative — we have no opinion about what this place is. */
export function familyOf(
  category: string | null,
  type: string | null,
): Family | null {
  if (category === null || type === null) return null;
  return TYPE_FAMILY[`${category}/${type}`] ?? CATEGORY_FAMILY[category] ?? null;
}

/** What the extractor says the place is. Closed, so the compatibility table
 *  below is finite and every row of it is testable. */
export const KINDS = [
  "street", "temple", "park", "museum", "station", "restaurant", "market",
  "shop", "hotel", "viewpoint", "nature", "neighbourhood", "landmark",
] as const;

export type Kind = (typeof KINDS)[number];

export function isKind(v: string): v is Kind {
  return (KINDS as readonly string[]).includes(v);
}

/** Every family except the three commercial ones — `landmark`'s allowance.
 *  Spelled by subtraction so adding a Family cannot silently narrow it. */
const NON_COMMERCIAL: Family[] = [
  "worship", "transport", "greenspace", "culture",
  "road", "water", "natural", "civic",
];

/** A precise kind is checked more strictly than a vague one, and that is the
 *  intended asymmetry: a stronger claim can be contradicted by more evidence.
 *  Under-declaring costs coverage, never correctness. */
const KIND_FAMILIES: Record<Kind, Family[]> = {
  street: ["road"],
  temple: ["worship", "culture"],
  park: ["greenspace", "natural"],
  museum: ["culture"],
  station: ["transport"],
  restaurant: ["food"],
  market: ["retail", "food"],
  shop: ["retail"],
  hotel: ["lodging"],
  viewpoint: ["natural", "greenspace", "culture"],
  nature: ["natural", "greenspace", "water"],
  neighbourhood: ["road"],
  // The escape hatch for a place whose type the extractor cannot name — the
  // Hongya Cave case. Excludes exactly the families where a lone
  // name-containment match is most often wrong, so it would have caught
  // Jiefangbei too: the check does not depend on picking the most precise kind.
  landmark: NON_COMMERCIAL,
};

/** Families flagged when NOBODY declared a kind. Independent of the comparison
 *  above and subordinate to it — see `plausibilityReason`.
 *
 *  `food` is deliberately absent: a travel video recommending one restaurant
 *  by name is the ordinary case, not a suspicious one. */
const DENYLIST: Family[] = ["lodging", "retail"];

/** NULL means plausible. A string is the reason to queue the mention.
 *
 *  Three ordered gates, and the order is the design:
 *    1. An uninformative type never contradicts.
 *    2. A declared kind incompatible with an informative family contradicts.
 *    3. The denylist fires ONLY when no kind was declared.
 *
 *  Gate 3's precedence is why `{"text": "Hello Hotel", "kind": "hotel"}`
 *  matching `tourism/hotel` stays confident. Without it we would flag a video
 *  that genuinely recommends a hotel — the weakness that argued against a
 *  denylist-only design in the first place. */
export function plausibilityReason(
  declaredKind: Kind | null,
  c: PoiCandidate,
): string | null {
  const family = familyOf(c.category, c.type);
  if (family === null) return null;

  const osm = `${c.category}/${c.type}`;

  if (declaredKind === null) {
    return DENYLIST.includes(family)
      ? `unverified type: ${osm}, no kind declared`
      : null;
  }

  return KIND_FAMILIES[declaredKind].includes(family)
    ? null
    : `type mismatch: expected ${declaredKind}, got ${osm}`;
}
