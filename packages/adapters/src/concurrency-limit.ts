/** Marks a task a full queue refused, so callers can tell "too busy" from a real answer. */
export const BUSY = Symbol("busy");

/**
 * At most `max` tasks at once; a bounded number wait a bounded time, the rest are BUSY.
 *
 * Shared by the outbound-metadata resolvers (site icons, link previews) so a burst of links in
 * one message cannot fan out into unbounded requests to third-party sites.
 */
export function concurrencyLimit(max: number, maxWaiting: number, maxWaitMs: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    // Hand the slot straight to the next waiter so a newcomer cannot slip in between.
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return async <T>(task: () => Promise<T>): Promise<T | typeof BUSY> => {
    if (active < max) {
      active += 1;
    } else {
      if (waiting.length >= maxWaiting) return BUSY;
      const admitted = await new Promise<boolean>((resolve) => {
        const admit = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(admit), 1);
          resolve(false);
        }, maxWaitMs);
        waiting.push(admit);
      });
      if (!admitted) return BUSY;
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}
