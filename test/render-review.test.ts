import { expect, test, describe } from "bun:test";
import { renderReviewQueue } from "@/render-review";
import type { Mention } from "@/mentions";

function mention(over: Partial<Mention> = {}): Mention {
  return {
    id: 4, tripId: 1, sourceId: 1,
    text: "hot pot", resolvedName: null,
    atSeconds: 272, dwellMinutes: null, tags: [], kind: null, price: [],
    reason: "2 candidates", segmentId: null, rejectedAt: null,
    state: "pending",
    candidates: [
      {
        id: 1, mentionId: 4, rank: 1,
        displayName: "夜福火锅, 北区路, 解放碑, 渝中区, 重庆市, 中国",
        localName: "夜福火锅",
        latitude: 29.563, longitude: 106.567,
        category: "amenity", type: "restaurant", importance: 0.0001,
        osmType: "node", osmId: 1, kmFromCentre: 1.4,
      },
      {
        id: 2, mentionId: 4, rank: 2,
        displayName: "地下之城老火锅, 五红路, 两江新区, 重庆市, 中国",
        localName: "地下之城老火锅",
        latitude: 29.588, longitude: 106.548,
        category: "amenity", type: "restaurant", importance: 0.0001,
        osmType: "node", osmId: 2, kmFromCentre: 3.8,
      },
    ],
    ...over,
    // DERIVED, exactly as toMention derives it, and after the spread so a
    // test that sets resolvedName gets a matching name without restating it.
    // Hardcoding it here made the factory produce a Mention shape the storage
    // layer can never produce.
    name: over.name ?? over.resolvedName ?? over.text ?? "hot pot",
  };
}

describe("renderReviewQueue", () => {
  test("states the search box, so the confidence rule is never silent", () => {
    const out = renderReviewQueue([mention()], "Chongqing", 25);
    expect(out).toContain("25 km box around Chongqing");
  });

  test("numbers candidates from 1, matching --pick", () => {
    const out = renderReviewQueue([mention()], "Chongqing", 25);
    expect(out).toContain("1. 夜福火锅");
    expect(out).toContain("2. 地下之城老火锅");
  });

  test("shows the timestamp so a mention can be checked against the video", () => {
    expect(renderReviewQueue([mention()], "Chongqing", 25)).toContain("04:32");
  });

  test("a mention with no timestamp says so rather than showing 00:00", () => {
    const out = renderReviewQueue([mention({ atSeconds: null })], "Chongqing", 25);
    expect(out).not.toContain("00:00");
    expect(out).toContain("no timestamp");
  });

  test("a no-match mention shows its reason and the way out", () => {
    const out = renderReviewQueue(
      [mention({ reason: "no match", candidates: [] })], "Chongqing", 25,
    );
    expect(out).toContain("no match");
    expect(out).toContain("--rename");
  });

  test("a no-match mention does not offer --pick, since there is no candidate list to pick from", () => {
    const out = renderReviewQueue(
      [mention({ reason: "no match", candidates: [] })], "Chongqing", 25,
    );
    expect(out).not.toContain("--pick");
  });

  test("an empty queue says so", () => {
    expect(renderReviewQueue([], "Chongqing", 25)).toContain("nothing pending");
  });

  test("distance from centre is shown so a far candidate is visible as one", () => {
    expect(renderReviewQueue([mention()], "Chongqing", 25)).toContain("3.8 km");
  });

  test("a candidate with no local name identifies by its display name instead of printing null", () => {
    const out = renderReviewQueue(
      [mention({
        candidates: [{
          id: 1, mentionId: 4, rank: 1,
          displayName: "Some Restaurant, Some Street, Some City",
          localName: null,
          latitude: 29.563, longitude: 106.567,
          category: "amenity", type: "restaurant", importance: 0.0001,
          osmType: "node", osmId: 1, kmFromCentre: 1.4,
        }],
      })],
      "Chongqing", 25,
    );
    expect(out).toContain("1. Some Restaurant, Some Street, Some City");
    expect(out).not.toContain("null");
  });

  test("the header pluralizes 'mentions' when more than one is pending", () => {
    const out = renderReviewQueue(
      [mention({ id: 4 }), mention({ id: 5 })], "Chongqing", 25,
    );
    expect(out).toContain("2 mentions pending review");
  });

  test("a candidate with no type still shows its distance without a stray separator", () => {
    const out = renderReviewQueue(
      [mention({
        candidates: [{
          id: 1, mentionId: 4, rank: 1,
          displayName: "夜福火锅, 渝中区, 重庆市",
          localName: "夜福火锅",
          latitude: 29.563, longitude: 106.567,
          category: null, type: null, importance: 0.0001,
          osmType: "node", osmId: 1, kmFromCentre: 1.4,
        }],
      })],
      "Chongqing", 25,
    );
    expect(out).toContain("1. 夜福火锅 - 1.4 km");
  });
});

describe("M6: a renamed mention shows both names", () => {
  test("a renamed mention shows the new name AND what the video said", () => {
    // Found by the first real end-to-end run: after a --rename that still
    // failed, the queue showed the name you had just replaced, so you could
    // not see what was stored or what was queried -- and a second attempt
    // looked like it was operating on the original.
    const out = renderReviewQueue([mention({
      text: "Longman how old street",
      resolvedName: "Longmenhao Old Street",
      reason: "no match",
      candidates: [],
    })], "Chongqing", 25);
    expect(out).toContain("Longmenhao Old Street");
    expect(out).toContain("Longman how old street");
    expect(out).toMatch(/said/);
  });

  test("a mention nobody renamed renders exactly as before", () => {
    // The half that matters more: this must not churn every queue line or
    // every existing review test.
    const out = renderReviewQueue([mention({
      text: "hot pot", resolvedName: null,
    })], "Chongqing", 25);
    expect(out).toContain(`"hot pot"`);
    expect(out).not.toMatch(/said/);
  });

  test("a rename to the same string adds no parenthetical", () => {
    const out = renderReviewQueue([mention({
      text: "Shibati", resolvedName: "Shibati", reason: "2 candidates",
    })], "Chongqing", 25);
    expect(out).toContain(`"Shibati"`);
    expect(out).not.toMatch(/said/);
  });
});
