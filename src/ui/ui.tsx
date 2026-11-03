import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router";
import { Glass, Toggle as BubliToggle } from "bubli";
import type { Material } from "bubli/engine";
import { HoverFilm } from "./film";
import { ON_PICTURE, QUIET, WHITE } from "./materials";
import { useLiquidLens } from "./lens";
import { useWheelScrollsX } from "./wheelScroll";
import { initials } from "./format";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "overlay" | "glass";
type Size = "md" | "lg";

/** What each variant's bubble is made of. Ghost has none: it's a plain shade under the pointer. */
const MATERIALS: Record<Exclude<Variant, "ghost">, () => Partial<Material>> = {
  primary: () => WHITE,
  secondary: () => QUIET,
  // The token, read when it's drawn, since a canvas can't read a CSS variable.
  danger: () => ({ tint: getComputedStyle(document.documentElement).getPropertyValue("--color-danger").trim(), opacity: 0.3, iridescence: 1, clearCenter: 0.9 }),
  overlay: () => ON_PICTURE,
  glass: () => ON_PICTURE,
};

const variants: Record<Variant, string> = {
  primary: "bubble-white text-on-accent",
  secondary: "text-fg",
  ghost: "fill-hover text-fg-muted hover:bg-white/8 hover:text-fg",
  danger: "text-danger",
  overlay: "text-white",
  glass: "text-fg",
};

const sizes: Record<Size, string> = {
  // 44px on touch screens, where it's a finger.
  md: "h-10 pointer-coarse:h-11 px-4 gap-2 text-body",
  lg: "h-13 px-6 gap-2 text-subhead",
};

/** The look of a button that isn't a bubble itself: for one inside another bubble, and for links a Glass can't wrap. */
function buttonClass({
  variant = "secondary",
  size = "md",
  withIcon,
  className,
}: { variant?: Variant; size?: Size; withIcon?: boolean; className?: string } = {}) {
  return cx(
    "relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold whitespace-nowrap select-none disabled:opacity-40",
    variant === "ghost" ? "press" : "bubli-button",
    variants[variant],
    sizes[size],
    // The icon side carries its own air, so it gets a little less padding.
    withIcon && (size === "lg" ? "pl-5" : "pl-3.5"),
    className,
  );
}

export function ButtonLink({
  to,
  variant = "secondary",
  size,
  icon,
  className,
  children,
  ...rest
}: {
  to: string;
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
} & Omit<React.ComponentProps<typeof Link>, "to" | "className" | "children">) {
  const body = (
    <span className="inline-flex items-center gap-2">
      {icon && <span className="-mb-px inline-flex text-[1.15em]">{icon}</span>}
      {children}
    </span>
  );
  if (variant === "ghost")
    return (
      <Link {...rest} to={to} className={buttonClass({ variant, size, withIcon: !!icon, className })}>
        {body}
      </Link>
    );
  return (
    <Glass {...rest} as={Link} to={to} name="button" material={MATERIALS[variant]()} className={buttonClass({ variant, size, withIcon: !!icon, className })}>
      {body}
    </Glass>
  );
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, onClick, type = "button", ...rest },
  ref,
) {
  const body = (
    <>
      {/* min-w-0 lets a squeezed button truncate a label wrapped in `truncate`. */}
      <span className={cx("inline-flex min-w-0 items-center gap-2", loading && "invisible")}>
        {icon && <span className="-mb-px inline-flex text-[1.15em]">{icon}</span>}
        {children}
      </span>
      {loading && (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner />
        </span>
      )}
    </>
  );
  const props = {
    ...rest,
    type,
    "aria-busy": loading || undefined,
    onClick: loading ? undefined : onClick,
    className: buttonClass({ variant, size, withIcon: !!icon, className }),
  };
  if (variant === "ghost")
    return (
      <button ref={ref} {...props}>
        {body}
      </button>
    );
  return (
    <Glass as="button" ref={ref as React.Ref<HTMLElement>} name="button" material={MATERIALS[variant]()} {...props}>
      {body}
    </Glass>
  );
});

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  size?: "sm" | "md" | "lg" | "xl";
  /** plain: a shade under the pointer. glass: a bubble, for floating over a picture. scrim: on every card in a row, a bubble only while its card is under the pointer. */
  tone?: "plain" | "glass" | "scrim";
  /** A scrim a touch screen keeps showing. */
  shownOnTouch?: boolean;
};

const iconSizes = {
  sm: "size-8 text-[16px]",
  md: "size-10 text-[20px]",
  lg: "size-13 text-[24px]",
  xl: "size-16 text-[30px]",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "md", tone = "plain", shownOnTouch, className, children, type = "button", ...rest },
  ref,
) {
  const shape = cx("inline-grid shrink-0 place-items-center rounded-full text-fg disabled:opacity-40", iconSizes[size]);
  if (tone === "glass")
    return (
      <Glass
        as="button"
        ref={ref as React.Ref<HTMLElement>}
        name="icon-button"
        material={ON_PICTURE}
        type={type}
        aria-label={label}
        title={label}
        className={cx("bubli-button bubli-icon-button min-h-0 p-0", shape, className)}
        {...rest}
      >
        {children}
      </Glass>
    );
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        "press",
        shape,
        tone === "plain" && "fill-hover hover:bg-white/10",
        tone === "scrim" && "fill-scrim bg-black/60 hover:bg-black/75",
        className,
      )}
      {...rest}
    >
      {tone === "scrim" && <HoverFilm shownOnTouch={shownOnTouch} />}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cx(
        "inline-block size-4 rounded-full border-2 border-current border-r-transparent",
        "[animation:spin_600ms_linear_infinite]",
        className,
      )}
    />
  );
}

export function Avatar({
  name,
  hue,
  size = 32,
  ring,
  className,
}: {
  name: string;
  hue: number;
  size?: number;
  ring?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-grid shrink-0 place-items-center rounded-full font-semibold text-white select-none",
        ring && "ring-2 ring-page",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `linear-gradient(140deg in oklch, oklch(0.72 0.13 ${hue}), oklch(0.5 0.14 ${hue + 30}))`,
        boxShadow: "inset 0 0 0 1px oklch(1 0 0 / 0.12)",
      }}
    >
      {initials(name)}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center justify-center gap-3 px-6 py-16 text-center", className)}>
      {icon && <div className="mb-1 text-[32px] text-fg-faint">{icon}</div>}
      <p className="text-subhead font-medium text-fg">{title}</p>
      {description && <p className="max-w-[44ch] text-body text-fg-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const { ref, lens } = useLiquidLens<HTMLDivElement>(value);
  useWheelScrollsX(ref);
  return (
    // The padding gives focus rings and the lens's shadow room inside the scroller, which clips both ways; the
    // negative margin keeps the tabs on the page's edges. An edge that hides more tabs fades.
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      // The lens's canvas stays inside that padding, or its room would count as more to scroll.
      className={cx("relative -m-1.5 flex scroll-px-1.5 gap-1 overflow-x-auto scrollbar-none scroll-fade-x p-1.5 [--bubli-control-bleed:6px]", className)}
    >
      {lens}
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            data-lens={o.value}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(event) => {
              const index = options.findIndex((option) => option.value === value);
              const next = event.key === "ArrowRight" ? (index + 1) % options.length
                : event.key === "ArrowLeft" ? (index + options.length - 1) % options.length
                  : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              onChange(options[next].value);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}
            className={cx(
              "press relative z-1 h-11 shrink-0 rounded-full px-4 text-body font-medium",
              active ? "text-fg" : "fill-hover text-fg-muted hover:bg-white/8 hover:text-fg",
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span className={cx("ml-1.5 tabular-nums", active ? "text-fg-muted" : "text-fg-faint")}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="keycap inline-grid h-5 min-w-5 place-items-center rounded-[5px] bg-white/10 px-1 font-sans text-caption text-fg-muted">
      {children}
    </kbd>
  );
}

/** A switch. Wrap it in a <label> with the setting’s name, or pass `label`. */
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <BubliToggle checked={checked} onCheckedChange={onChange} aria-label={label} color="oklch(0.97 0.004 60)" />;
}
