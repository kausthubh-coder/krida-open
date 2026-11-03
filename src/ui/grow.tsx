import { useState, type ComponentProps, type ReactNode } from "react";
import { MorphPanel } from "bubli";

type GrowProps = Omit<ComponentProps<typeof MorphPanel>, "open" | "children"> & {
  open: boolean;
  children: ReactNode;
};

/**
 * A menu or popover: a frosted bubble that grows out of what opened it and shrinks back into it (bubli's MorphPanel).
 * It lives only from the moment it's first opened to the moment it has shrunk away, so a page full of cards holds no
 * idle bubbles. What's inside keeps rendering while it shrinks, so give `children` what was showing, not `open && …`.
 */
export function Grow({ open, onClosed, children, ...rest }: GrowProps) {
  const [alive, setAlive] = useState(open);
  if (open && !alive) setAlive(true);
  if (!alive && !open) return null;
  return (
    <MorphPanel
      {...rest}
      open={open}
      onClosed={() => {
        setAlive(false);
        onClosed?.();
      }}
    >
      {children}
    </MorphPanel>
  );
}
