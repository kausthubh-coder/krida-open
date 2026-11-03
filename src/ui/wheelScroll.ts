import { useEffect, type RefObject } from "react";

/**
 * A mouse wheel turns a horizontal tab strip, which hides its scrollbar, so tabs past the edge can be reached
 * without a trackpad. At either end the wheel goes back to scrolling the page.
 */
export function useWheelScrollsX(ref: RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? el.clientWidth : 1;
      const delta = event.deltaY * unit;
      const max = el.scrollWidth - el.clientWidth;
      if ((delta < 0 && el.scrollLeft <= 0) || (delta > 0 && el.scrollLeft >= max - 1)) return;
      event.preventDefault();
      el.scrollLeft += delta;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref, enabled]);
}
