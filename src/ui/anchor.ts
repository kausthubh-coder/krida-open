import { useEffect, useState, type RefObject } from "react";

/** Where something floating over the page is, kept current while it moves or changes size, so menus can rise out of it. */
export function useAnchorRect(anchor: RefObject<HTMLElement | null>, active: boolean) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    const el = anchor.current;
    if (!active || !el) return;
    const update = () => setRect(el.getBoundingClientRect());
    update();
    // The dock changes size while its parts fold, so follow it.
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      // A reopen starts from where it is then, not where it was last time.
      setRect(null);
    };
  }, [anchor, active]);
  return active ? rect : null;
}

/**
 * Where an element sits inside `frame`, one of its positioned ancestors, ignoring transforms: the player turned
 * sideways (sideways.ts) is still one frame, and a pressed button's spring doesn't move its menu.
 */
export function offsetIn(el: HTMLElement, frame: HTMLElement) {
  let x = 0;
  let y = 0;
  for (let at: HTMLElement | null = el; at && at !== frame; at = at.offsetParent as HTMLElement | null) {
    x += at.offsetLeft;
    y += at.offsetTop;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}
