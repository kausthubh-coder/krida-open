import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BubliFlat, Glass } from "bubli";
import { browserBend } from "bubli/engine";
import { useModalMark } from "./modal";
import { XIcon } from "@phosphor-icons/react";
import { isSideways } from "./sideways";
import { cx, IconButton } from "./ui";

/**
 * A modal panel on <dialog>: focus moves in and returns to the trigger, the page behind is inert,
 * Escape and the backdrop close it. A pane of glass floating with a margin, like the Party panel: rising from the
 * bottom on phones, and from 768px at the right, as tall as what's in it. `scroll={false}` hands scrolling to the
 * children, for lists with a toolbar above; a side sheet like that is full height from the start, so the list
 * arriving or filtering never resizes it.
 * `descriptionAction` sits at the end of the description's line, outside what the dialog is described by.
 * On a phone, a bottom sheet carries a grabber and follows a finger dragging its top down: let go far enough, or
 * flick it, and it closes, as sheets do on iOS and Android.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  descriptionAction,
  leading,
  children,
  footer,
  variant = "side",
  wide = false,
  scroll = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  descriptionAction?: ReactNode;
  leading?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  variant?: "side" | "center";
  /** Centered sheets that hold a grid get more room. */
  wide?: boolean;
  scroll?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setShown(false);
    const t = setTimeout(() => {
      ref.current?.close();
      setMounted(false);
    }, 140);
    return () => clearTimeout(t);
  }, [open]);

  useModalMark(mounted);
  useEffect(() => {
    const el = ref.current;
    if (!mounted || !open || !el) return;
    if (!el.open) el.showModal();
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [mounted, open]);

  const drag = useDragToClose(ref, onClose, variant === "side");
  if (!mounted) return null;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-shown={shown || undefined}
      // For the player turned sideways on an upright phone, which turns its sheets too (styles.css).
      data-sheet=""
      data-tall={(variant === "side" && !scroll) || undefined}
      data-variant={variant}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cx(
        // The dialog only places it; the bubble inside is the panel, with room around it for its rim to swing.
        // Left-aligned whatever it was opened from: a title page centres its text on a phone.
        "fixed m-0 flex flex-col overflow-visible bg-transparent p-0 text-left text-fg",
        "backdrop:bg-black/50 backdrop:transition-opacity backdrop:duration-200",
        "opacity-0 backdrop:opacity-0 data-shown:opacity-100 data-shown:backdrop:opacity-100",
        "transition-[opacity,translate,scale] duration-120 ease-in data-shown:duration-240 data-shown:ease-snappy",
        variant === "side" &&
          "inset-x-3 top-auto bottom-(--dock-bottom) max-h-[88dvh] w-auto max-w-none translate-y-6 data-shown:translate-y-0 " +
            "md:top-3 md:right-3 md:bottom-auto md:left-auto md:max-h-[calc(100dvh-24px)] md:w-[460px] md:translate-x-6 md:translate-y-0 md:data-shown:translate-x-0",
        variant === "side" && !scroll && "h-[88dvh] md:h-[calc(100dvh-24px)]",
        variant === "center" &&
          cx(
            "inset-0 m-auto h-fit max-h-[85dvh] w-[calc(100%-32px)] scale-95 data-shown:scale-100",
            wide ? "max-w-[760px]" : "max-w-[420px]",
          ),
      )}
    >
      <Glass
        name="sheet"
        look="frosted"
        preset="panel"
        family="sheet"
        bend={browserBend() !== "moz"}
        variant="bar"
        material={{ radius: 28 }}
        // Lists that scroll themselves leave the pane unclipped, so their menus can hang below a short one.
        className={cx("bubble-panel flex min-h-0 flex-1 flex-col rounded-[28px]", scroll && "max-h-full")}
      >
      {variant === "side" && (
        <span aria-hidden className="pointer-events-none absolute top-2 left-1/2 h-1 w-9 -translate-x-1/2 rounded-full bg-white/25 stage:hidden" />
      )}
      <BubliFlat>
      <div {...drag} className={cx("flex shrink-0 items-start gap-3 px-6 pt-6 pb-4", variant === "side" && "max-md:touch-none")}>
        {leading && <div className="shrink-0">{leading}</div>}
        <div className={cx("min-w-0 flex-1", !!leading && "self-center")}>
          <h2 id={titleId} className="text-title font-semibold">{title}</h2>
          {description && (
            <div className="mt-1 flex items-center gap-2">
              <div id={descriptionId} className="min-w-0 flex-1 text-body text-pretty text-fg-muted">{description}</div>
              {descriptionAction}
            </div>
          )}
        </div>
        <IconButton label="Close" size="sm" onClick={onClose} className="min-h-11 min-w-11 bg-white/8">
          <XIcon />
        </IconButton>
      </div>
      <div className={cx("min-h-0 flex-1 px-6 pb-6", scroll ? "overflow-y-auto overscroll-contain" : "flex flex-col")}>{children}</div>
      {footer && <div className="shrink-0 border-t border-line px-6 py-4">{footer}</div>}
      </BubliFlat>
      </Glass>
    </dialog>
  );
}

/** Below this the sheet rises from the bottom, and its top can be dragged down to close it. */
const PHONE = "(max-width: 767.98px)";

/**
 * The finger moves the sheet itself, not a copy, through its inline style; the classes take over again once it's
 * let go. Past a third of the way down (or 96px), or flicked, it closes; otherwise it springs back.
 */
function useDragToClose(ref: React.RefObject<HTMLDialogElement | null>, onClose: () => void, enabled: boolean) {
  const drag = useRef<{ y: number; at: number; dy: number } | null>(null);
  const settle = (el: HTMLDialogElement, closing: boolean) => {
    const dy = drag.current?.dy ?? 0;
    drag.current = null;
    if (closing) {
      el.style.transition = "translate 140ms ease-in, opacity 140ms ease-in";
      el.style.translate = `0 ${dy + el.offsetHeight / 3}px`;
      el.style.opacity = "0";
    } else {
      el.style.transition = "translate 240ms var(--ease-snappy)";
      el.style.translate = "";
    }
    // Closed by now, or back where it was: the classes are in charge again.
    setTimeout(() => {
      el.style.removeProperty("transition");
      el.style.removeProperty("translate");
      el.style.removeProperty("opacity");
    }, 300);
    if (closing) onClose();
  };
  if (!enabled) return {};
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      // Turned sideways with the player, it's a centred card, not a sheet from the bottom.
      if (e.pointerType !== "touch" || !matchMedia(PHONE).matches || isSideways()) return;
      drag.current = { y: e.clientY, at: performance.now(), dy: 0 };
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      const el = ref.current;
      if (!d || !el) return;
      d.dy = Math.max(0, e.clientY - d.y);
      if (d.dy < 4) return;
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.setPointerCapture(e.pointerId);
      el.style.transition = "none";
      el.style.translate = `0 ${d.dy}px`;
    },
    onPointerUp: () => {
      const d = drag.current;
      const el = ref.current;
      if (!d || !el) return;
      if (d.dy < 4) {
        drag.current = null;
        return;
      }
      const flick = d.dy / (performance.now() - d.at) > 0.6;
      settle(el, d.dy > Math.min(96, el.offsetHeight / 3) || (flick && d.dy > 24));
    },
    onPointerCancel: () => {
      if (drag.current && ref.current) settle(ref.current, false);
      drag.current = null;
    },
  };
}
