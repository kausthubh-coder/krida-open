import { useLayoutEffect, useState, type RefObject } from "react";

/** Whether the element is within a screen of the viewport; once it has been, it stays so. */
export function useNear(ref: RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  // Measured before the first paint, so rows already on screen never show just two cards.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const { top, bottom } = el.getBoundingClientRect();
    if (top < innerHeight * 2 && bottom > -innerHeight) {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setNear(true), { rootMargin: "100% 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}
