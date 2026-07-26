/** Every outbound request in `trip` goes through here.
 *
 *  Two reasons this is shared rather than inlined at each call site:
 *
 *  1. Without a timeout, a stalled connection hangs the CLI forever — no
 *     output, no exit code, nothing an agent driving it can react to. A hang is
 *     strictly worse than an error here.
 *  2. The two clients had drifted on error handling: one checked `res.ok`
 *     before parsing, the other parsed first, so an HTML 502 from a proxy
 *     surfaced as a JSON SyntaxError with the status thrown away. The order
 *     below is the correct one, in one place, for both.
 */

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** Open-Meteo reports failures as `{"error": true, "reason": "..."}` on both
 *  4xx and 200. The reason is the only human-readable part, so it is worth
 *  digging out of a body we already have. */
function reasonOf(json: unknown): string | null {
  const r = (json as { reason?: unknown } | null)?.reason;
  return typeof r === "string" && r.length > 0 ? r : null;
}

export async function fetchJson(
  url: string,
  label: string,
  opts: FetchOptions = {},
): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw new Error(`${label} request failed: ${(err as Error).message}`);
  }

  // Status first, body second — but the body is still worth reading on the
  // failure path, because that is where Open-Meteo puts the reason. A body that
  // will not parse (proxy HTML) must not displace the status in the message.
  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const reason = reasonOf(json);
    throw new Error(
      `${label} failed (HTTP ${res.status})${reason ? `: ${reason}` : ""}`,
    );
  }

  if (json === null) {
    throw new Error(
      `${label} returned an unreadable body (HTTP ${res.status})`,
    );
  }

  return json;
}
