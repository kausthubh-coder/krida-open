import type { ReactNode } from "react";
import { cx } from "./ui";

/** A place's name, shown above it on hover or keyboard focus. Its control carries the same name for screen readers. */
export function DockTip({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className={cx(
        "dock-tip pointer-events-none absolute bottom-[calc(100%+16px)] left-1/2 w-max max-w-64 -translate-x-1/2 truncate rounded-full px-3 py-1.5",
        "bg-[oklch(0.22_0.008_60/0.94)] text-caption font-medium text-fg shadow-[0_6px_20px_-6px_oklch(0_0_0/0.6)] ring-1 ring-white/10",
      )}
    >
      {children}
    </span>
  );
}
