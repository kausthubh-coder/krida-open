// This device's clock against the server's. Countdowns that end on the server (invites, switch requests,
// "starting in 3") and anything compared with a server time (presence, reactions, chat) read the server's
// time, so a phone whose clock is off still shows the right thing.

/** Asks the server's time three times; the quickest round trip says most. Null when no answer came back. */
export async function measureOffset(clock: () => Promise<number>, now: () => number): Promise<number | null> {
  let best = Infinity;
  let offset: number | null = null;
  for (let i = 0; i < 3; i++) {
    const t0 = now();
    const server = await clock().catch(() => null);
    const t1 = now();
    if (server !== null && t1 - t0 < best) {
      best = t1 - t0;
      offset = server - (t0 + t1) / 2;
    }
  }
  return offset;
}

/** A laptop that slept or a tab left in the background may have drifted, but not by much within a minute. */
const REMEASURE_MS = 60_000;

/**
 * The server's clock as this device knows it. Measured once per session, again when the page comes
 * back on screen (`again`, at most once a minute), and until an answer comes back: with none, the
 * device's own clock stands in.
 */
export function createServerClock(now: () => number = () => Date.now()) {
  let offset = 0;
  let measuring: Promise<void> | null = null;
  let busy = false;
  let startedAt = -Infinity;
  return {
    /** The server's time less this device's. */
    offset: () => offset,
    now: () => now() + offset,
    measure(clock: () => Promise<number>, again = false) {
      const stale = again && !busy && now() - startedAt >= REMEASURE_MS;
      if (measuring && !stale) return measuring;
      busy = true;
      startedAt = now();
      measuring = measureOffset(clock, now).then((measured) => {
        busy = false;
        if (measured !== null) offset = measured;
        // Nothing came back: the next screen to ask tries again.
        else measuring = null;
      });
      return measuring;
    },
  };
}
