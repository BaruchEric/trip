import { expect, test, describe } from "bun:test";
import { fetchJson, DEFAULT_TIMEOUT_MS } from "@/http";
import { hangingFetch, within } from "./helpers";

function respondWith(body: string, status: number): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe("fetchJson", () => {
  test("returns the parsed body on success", async () => {
    const out = await fetchJson("https://example.test/x", "test call", {
      fetchFn: respondWith(JSON.stringify({ hello: "world" }), 200),
    });
    expect(out).toEqual({ hello: "world" });
  });

  test("gives up on a connection that never answers", async () => {
    // A hang is worse than an error for an agent-driven CLI: no output, no exit
    // code, nothing to react to. The caller waits forever.
    await expect(
      within(1000, fetchJson("https://example.test/x", "test call", {
        fetchFn: hangingFetch(),
        timeoutMs: 30,
      })),
    ).rejects.toThrow(/timed out/i);
  });

  test("the timeout error names the call and the wait", async () => {
    // An agent reading stderr has to be able to tell a timeout apart from a
    // rejection, and to know whether waiting longer would have helped.
    await expect(
      within(1000, fetchJson("https://example.test/x", "geocoding", {
        fetchFn: hangingFetch(),
        timeoutMs: 30,
      })),
    ).rejects.toThrow(/geocoding.*timed out after 30ms/i);
  });

  test("keeps the API's reason when an error body is JSON", async () => {
    await expect(
      fetchJson("https://example.test/x", "archive", {
        fetchFn: respondWith(JSON.stringify({ reason: "bad date" }), 400),
      }),
    ).rejects.toThrow(/bad date/);
  });

  test("keeps the HTTP status when an error body is not JSON", async () => {
    // A proxy 502 returns HTML. Parsing before checking res.ok surfaced a
    // SyntaxError ("Unexpected token <") and threw the status away — the one
    // piece of information that says whether to retry.
    const failing = respondWith("<html><body>502 Bad Gateway</body></html>", 502);
    const err = await fetchJson("https://example.test/x", "archive", {
      fetchFn: failing,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("502");
    expect((err as Error).message).not.toMatch(/JSON|Unexpected token/i);
  });

  test("a successful response with an unparseable body fails naming the call", async () => {
    const err = await fetchJson("https://example.test/x", "archive", {
      fetchFn: respondWith("not json at all", 200),
    }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/archive/);
  });

  test("a transport failure is reported, not swallowed", async () => {
    const broken = (async () => {
      throw new TypeError("Unable to connect");
    }) as unknown as typeof fetch;
    await expect(
      fetchJson("https://example.test/x", "geocoding", { fetchFn: broken }),
    ).rejects.toThrow(/geocoding.*Unable to connect/);
  });

  test("the default timeout is bounded and non-zero", async () => {
    // Pinned because an undefined or 0 default silently disables the timeout in
    // production while every injected-timeout test above still passes.
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
