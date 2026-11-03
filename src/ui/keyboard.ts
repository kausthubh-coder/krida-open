import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

/*
 * iOS (where every browser is WebKit, Chrome too) can miss the on-screen keyboard closing: the page keeps the height it
 * had with the keyboard up, so the tab bar floats a keyboard's height above the bottom and nothing is drawn below it.
 * A focused field leaving the page sets it off (Search focuses its field on arrival, then a result or a tab removes it
 * with the keyboard still up), and since iOS 26 an ordinary close sometimes does too.
 */

const iOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const typesInto = (el: Element | null) =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && !/^(button|checkbox|radio|range|color|file|submit|reset|image)$/.test(el.type)) ||
  (el instanceof HTMLElement && el.isContentEditable);

/** Lets go of a field's focus before it leaves the page, so the keyboard closes the ordinary way. */
export function useBlurOnLeave(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (el && el === document.activeElement) el.blur();
    };
  }, [ref]);
}

/**
 * Once the keyboard has closed, scrolling a pixel and back makes iOS measure the screen again. Only after a field loses
 * focus to nothing else you type into: a scroll from code would stop a fling.
 */
export function startKeyboardRepair() {
  const viewport = window.visualViewport;
  if (!iOS || !viewport) return;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const repair = () => {
    clearTimeout(pending);
    viewport.removeEventListener("resize", soon);
    if (typesInto(document.activeElement)) return;
    const { scrollX: x, scrollY: y } = window;
    window.scrollTo(x, y > 0 ? y - 1 : y + 1);
    window.scrollTo(x, y);
  };
  // The keyboard's slide ends with a resize; the timer covers a close that never reports one.
  const soon = () => {
    clearTimeout(pending);
    pending = setTimeout(repair, 100);
  };
  document.addEventListener("focusout", (e) => {
    if (!typesInto(e.target as Element)) return;
    clearTimeout(pending);
    pending = setTimeout(repair, 600);
    viewport.addEventListener("resize", soon);
  });
}

/**
 * How much of the bottom of the window the on-screen keyboard covers. A fixed bar stays behind the keyboard unless it's told:
 * phones resize only the visual viewport.
 */
export function useKeyboardHeight() {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const covered = Math.round(window.innerHeight - viewport.height - viewport.offsetTop);
      // Less than this is a browser's toolbar coming and going, not a keyboard.
      setHeight(covered > 120 ? covered : 0);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return height;
}
