/** A server that accepts the connection and then never answers.
 *
 *  The fake honors the abort signal for real rather than recording that one was
 *  passed. Asserting "a signal reached fetch" would still pass if the signal
 *  were never armed, which is the only part that matters. */
export function hangingFetch(): typeof fetch {
  return ((_url: string | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal!.reason ?? new Error("aborted"));
      });
    })) as unknown as typeof fetch;
}

/** Bounds a promise that is supposed to give up on its own.
 *
 *  Without this, a regression that drops the request timeout does not fail the
 *  test — it hangs the whole run, because `bun test --timeout` cannot preempt a
 *  pending promise that owns no timer. Verified: removing the AbortSignal made
 *  the suite need a SIGTERM to stop. The rejection message deliberately avoids
 *  the phrase the assertions match on, so a watchdog trip can never be mistaken
 *  for the timeout it is checking for. */
export function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const watchdog = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`test watchdog: no result within ${ms}ms — the request never gave up`)),
      ms,
    );
  });
  return Promise.race([p, watchdog]).finally(() => clearTimeout(timer));
}
