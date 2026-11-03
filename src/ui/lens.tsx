import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Glass } from "bubli";
import { motionSprings, runSpring, type Bubble, type RunningSpring } from "bubli/engine";
import { useReducedMotion } from "motion/react";

/** How far the lifted lens overhangs its item. */
const LIFT_SWELL = 1.18;

/**
 * bubli's sliding lens for bars whose items aren't all its own (a dock with a menu in it, tabs that scroll): at rest a
 * quiet lit pill on the selected item. A press lifts it into a bubble that overhangs the bar, it slides there stretching
 * along its travel, and settles back into the pill as it lands. Mark items with `data-lens="<key>"`, put `ref` on their
 * positioned container and render `lens` first inside it. With nothing selected it fades away.
 */
export function useLiquidLens<T extends HTMLElement>(active: string | null | undefined, axis: "x" | "y" = "x") {
  const ref = useRef<T>(null);
  const element = useRef<HTMLElement>(null);
  const bubble = useRef<Bubble | null>(null);
  const spring = useRef<RunningSpring | null>(null);
  const reduce = useReducedMotion();
  const still = useRef(false);
  still.current = !!reduce;
  const pressed = useRef(false);
  const placed = useRef(false);
  const latest = useRef(active);
  latest.current = active;
  const [shown, setShown] = useState(false);

  const find = (key: string | null | undefined) =>
    key ? ref.current?.querySelector<HTMLElement>(`[data-lens="${CSS.escape(key)}"]`) ?? null : null;
  // Offsets are summed up to the bar, so an item inside a positioned wrapper is still measured from the bar, and they
  // ignore movement, so the lens aims at where the item lands.
  const measure = (item: HTMLElement) => {
    let x = 0;
    let y = 0;
    for (let at: HTMLElement | null = item; at && at !== ref.current; at = at.offsetParent as HTMLElement | null) {
      x += at.offsetLeft;
      y += at.offsetTop;
    }
    return { x, y, width: item.offsetWidth, height: item.offsetHeight };
  };
  const cross = useRef(0);
  const place = (along: number) => {
    const lens = element.current;
    if (lens) lens.style.transform = axis === "x" ? `translate3d(${along}px, ${cross.current}px, 0)` : `translate3d(${cross.current}px, ${along}px, 0)`;
  };
  const lift = (on: boolean) => {
    const lens = element.current;
    if (!lens) return;
    lens.toggleAttribute("data-lifted", on);
    bubble.current?.setDormant(!on);
    bubble.current?.setSwell(on ? LIFT_SWELL : 1);
  };
  const aim = (item: HTMLElement, jump: boolean) => {
    const lens = element.current;
    if (!lens) return;
    const box = measure(item);
    lens.style.width = `${box.width}px`;
    lens.style.height = `${box.height}px`;
    cross.current = axis === "x" ? box.y : box.x;
    const along = axis === "x" ? box.x : box.y;
    if (jump) {
      spring.current?.set(along);
      place(along);
      if (!pressed.current) lift(false);
    } else spring.current?.to(along);
  };

  useEffect(() => {
    const running = runSpring({
      from: 0,
      config: motionSprings.lens,
      still: () => still.current,
      epsilon: 0.05,
      onUpdate: (value, velocity) => {
        place(value);
        if (axis === "x") bubble.current?.moveWith(velocity, 0);
        else bubble.current?.moveWith(0, velocity);
      },
      onRest: () => {
        if (!pressed.current) lift(false);
      },
    });
    spring.current = running;
    const item = find(latest.current);
    if (item) aim(item, true);
    return () => running.stop();
    // The lens lives as long as the bar does; the axis of a bar doesn't change while it's up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const item = find(active);
    setShown(!!item);
    if (!item) {
      placed.current = false;
      return;
    }
    // Measured on the next frame, not here: here, a new page is still half built, and reading where an item sits would
    // lay the whole page out once now and again after React finishes.
    const frame = requestAnimationFrame(() => {
      const first = !placed.current;
      placed.current = true;
      if (!first && !still.current) lift(true);
      aim(item, first || !!still.current);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // A resize moves the items; the lens stays glued to them. A slide in flight lands on its own.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const follow = () => {
      const item = find(latest.current);
      if (item && !element.current?.hasAttribute("data-lifted")) aim(item, true);
    };
    const observer = new ResizeObserver(follow);
    observer.observe(root);
    root.querySelectorAll("[data-lens]").forEach((item) => observer.observe(item));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  // A press answers at once: the lens lifts and goes to the pressed item. If the press doesn't change the selection it goes back.
  useEffect(() => {
    const root = ref.current;
    if (!root || reduce) return;
    const up = () => {
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      pressed.current = false;
      window.setTimeout(() => {
        if (pressed.current) return;
        const item = find(latest.current);
        if (item) aim(item, false);
      });
    };
    const down = (event: PointerEvent) => {
      if (event.button > 0 || !(event.target instanceof Element)) return;
      const item = event.target.closest<HTMLElement>("[data-lens]");
      if (!item || !root.contains(item) || !find(latest.current)) return;
      // A menu's button changes no selection: the lens would fly to it and straight back.
      if (item.hasAttribute("aria-haspopup")) return;
      pressed.current = true;
      lift(true);
      aim(item, false);
      addEventListener("pointerup", up);
      addEventListener("pointercancel", up);
    };
    root.addEventListener("pointerdown", down);
    return () => {
      root.removeEventListener("pointerdown", down);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduce]);

  const lens = (
    <Glass
      as="span"
      ref={element}
      name="lens"
      preset="lens"
      look="liquid"
      material={{ radius: 9999, bevel: 12, iridescence: 0.5, tint: "auto", opacity: 0.12 }}
      onBubble={(created: Bubble) => {
        bubble.current = created;
        created.setDormant(!element.current?.hasAttribute("data-lifted"));
      }}
      aria-hidden
      className={`bubli-lens krida-lens transition-opacity duration-150 ${shown ? "opacity-100" : "opacity-0"}`}
    />
  );
  return { ref, lens };
}
