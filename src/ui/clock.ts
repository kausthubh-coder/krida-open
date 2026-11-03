import { useEffect, useState } from "react";

/** Date.now(), ticking every `every` ms. With `null` it stands still, and the component isn't redrawn for it. */
export function useNow(every: number | null = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (every === null) return;
    // Starting again after standing still, catch up at once rather than on the first tick.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), every);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [every]);
  return now;
}
