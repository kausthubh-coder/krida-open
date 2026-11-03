import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { Glass } from "bubli";
import type { Bubble } from "bubli/engine";
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  BooksIcon,
  CornersInIcon,
  CornersOutIcon,
  DownloadSimpleIcon,
  EyeSlashIcon,
  PopcornIcon,
  GearSixIcon,
  HouseIcon,
  MagnifyingGlassIcon,
  SignOutIcon,
  UserSwitchIcon,
} from "@phosphor-icons/react";
import { useSession } from "../data/session";
import { useUpdateProfile } from "../data/profile";
import { PartyNavButton, usePartyEntry } from "../features/party";
import { DockTip } from "../ui/dockTip";
import { NavSearch } from "../features/search";
import { useLiquidLens } from "../ui/lens";
import { usePrefetchPlace } from "../data/prefetch";
import { onProduction } from "../data/backend";
import { canFullscreen, toggleFullscreen, useFullscreen } from "../ui/fullscreen";
import { Avatar, cx, IconButton, Kbd } from "../ui/ui";
import { Wordmark } from "../ui/wordmark";
import { canGoBack } from "../ui/history";
import { detent, tick } from "../ui/haptics";
import { useKeyboardHeight } from "../ui/keyboard";
import { barBubble } from "../ui/barBubble";
import { Grow } from "../ui/grow";
import { type AppUpdate, useAppUpdate } from "../ui/appUpdate";

const links = [
  { to: "/", id: "home", label: "Home", icon: HouseIcon, end: true },
  { to: "/search", id: "search", label: "Search", icon: MagnifyingGlassIcon, end: false },
  { to: "/library", id: "library", label: "Library", icon: BooksIcon, end: false },
];

/** The pages the nav goes to; every other page has a way back. Settings' sections have their own, back to its list. */
const isTopLevel = (pathname: string) => ["/", "/search", "/library"].includes(pathname) || pathname.startsWith("/settings");

/**
 * Pressing the tab you're already on takes its page back to the top, as every phone app's tab bar does. The page
 * stays as it was otherwise: the press doesn't reload it.
 */
function backToTop(here: boolean) {
  if (!here || window.scrollY === 0) return;
  window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

/** Which nav item the current page belongs to: the lens sits there. Title pages belong to none. */
function usePlace() {
  const { pathname } = useLocation();
  if (pathname === "/") return "home";
  if (pathname === "/search") return "search";
  if (pathname.startsWith("/library")) return "library";
  if (pathname.startsWith("/settings")) return "you";
  return null;
}

/**
 * The item just pressed, until the page changes. Navigations render in a transition, so this lands first:
 * the lens leaves at once instead of waiting for the next page to render.
 */
function usePressed() {
  const { pathname } = useLocation();
  const [pressed, setPressed] = useState<{ id: string; from: string } | null>(null);
  // Forgotten once the page changes: kept, it came back the next time you were on the page you pressed it
  // from, and the lens sat on Home while you were on Search.
  if (pressed && pressed.from !== pathname) setPressed(null);
  const press = (id: string) => setPressed({ id, from: pathname });
  return [pressed?.from === pathname ? pressed.id : null, press] as const;
}

function useScrolled(past = 60) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > past);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [past]);
  return scrolled;
}

/**
 * The top of every page: a way back on detail pages and the wordmark. The rest of the nav lives in the
 * dock at the bottom (the tab bar on phones). The wordmark belongs to the top of the page and steps
 * aside once you scroll into the rows; the back button stays.
 */
export function TopNav() {
  const scrolled = useScrolled();
  const top = isTopLevel(useLocation().pathname);
  return (
    <header className="pointer-events-none fixed top-0 right-0 left-(--rail-pad,0px) z-40 pt-[var(--inset-top)]">
      {/* The scroll edge: what scrolls up under the wordmark and the back button dims away instead of meeting them.
          It runs on under a sideways phone's rail, so the artwork there dims with the rest. */}
      <div aria-hidden className="absolute top-0 right-0 left-[calc(var(--rail-pad,0px)*-1)] h-28 bg-linear-to-b from-page/90 via-page/50 to-transparent" />
      <div className="relative flex h-16 items-center gap-2 px-4 md:h-20 md:px-12 short:h-16">
        <BackButton />
        <Link
          to="/"
          aria-label="Krida home"
          tabIndex={scrolled ? -1 : undefined}
          // A sideways phone has Home on its rail and no height to spare, so the wordmark steps aside there.
          className={cx(
            "-ml-1 flex h-10 items-center rounded-control px-1 text-title transition-[opacity,translate] duration-300 ease-snappy short:hidden",
            scrolled ? "pointer-events-none -translate-y-2 opacity-0" : "pointer-events-auto",
            // A title page leads with its way back and its own logo; on a phone there's no room for a second name.
            !top && "max-md:hidden",
          )}
        >
          <Wordmark className="drop-shadow-[0_1px_12px_oklch(0_0_0/0.5)]" />
        </Link>
        {/* A branch preview running on your real account says so, so it's never mistaken for Krida itself. */}
        {onProduction && (
          <span className="glass ml-auto flex h-8 items-center gap-2 rounded-full px-3 text-caption font-medium text-fg-muted">
            <span aria-hidden className="size-2 rounded-full bg-warning" />
            Preview on your real account
          </span>
        )}
      </div>
    </header>
  );
}

/**
 * The bottom's scroll edge: rows dim as they pass under the dock (the tab bar on phones), so its glass can stay
 * clear and its labels still read over the brightest poster. A still gradient, so scrolling costs nothing.
 */
export function BottomEdge() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed right-0 bottom-0 left-0 z-30 h-32 bg-linear-to-t from-page from-30% via-page/70 via-55% to-transparent short:hidden"
    />
  );
}

/** Detail pages get a way back to wherever you came from. */
function BackButton() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  if (isTopLevel(pathname)) return null;
  return (
    <IconButton
      label="Back"
      tone="glass"
      className="pointer-events-auto size-11"
      onClick={() => (canGoBack() ? navigate(-1) : navigate("/"))}>
      <ArrowLeftIcon />
    </IconButton>
  );
}

/** How far from the left edge a swipe back has to start, and how far it has to come before letting go goes back. */
const EDGE_PX = 24;
const BACK_PX = 72;

/**
 * Krida opened from an iPhone's home screen has no browser around it, and so no swipe from the left edge to go
 * back. This puts it back on detail pages: an arrow follows the finger in from the edge, fills once letting go would
 * go back (with a tick on Android), and does what Back does. Safari, and Android with its own back gesture, keep
 * theirs.
 */
export function EdgeBack() {
  const navigate = useNavigate();
  const [pull, setPull] = useState(0);
  useEffect(() => {
    if ((navigator as Navigator & { standalone?: boolean }).standalone !== true) return;
    let start: { x: number; y: number } | null = null;
    let pulling = false;
    let armed = false;
    const reset = () => {
      start = null;
      pulling = false;
      armed = false;
      setPull(0);
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t || t.clientX > EDGE_PX) return;
      if (isTopLevel(location.pathname) || document.querySelector("dialog[open]")) return;
      start = { x: t.clientX, y: t.clientY };
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!pulling) {
        // Mostly up or down, it's the page scrolling.
        if (Math.abs(dy) > 10 && Math.abs(dy) > dx) return reset();
        if (dx < 10) return;
        pulling = true;
      }
      // The finger is going back now, not scrolling a row under it.
      e.preventDefault();
      setPull(Math.max(0, dx));
      if (dx >= BACK_PX !== armed) {
        armed = dx >= BACK_PX;
        if (armed) tick();
      }
    };
    const onEnd = () => {
      const back = pulling && armed;
      reset();
      if (back) void (canGoBack() ? navigate(-1) : navigate("/"));
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", reset);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", reset);
    };
  }, [navigate]);
  if (!pull) return null;
  const armed = pull >= BACK_PX;
  return (
    <div
      aria-hidden
      className={cx(
        "glass pointer-events-none fixed top-1/2 left-0 z-50 grid size-11 -translate-y-1/2 place-items-center rounded-full transition-[background-color,scale] duration-150",
        armed ? "scale-110 bg-white/25 text-fg" : "text-fg-muted",
      )}
      // Follows the finger, slowing as it passes the point of going back.
      style={{ translate: `${Math.min(pull, BACK_PX) * 0.6 + Math.max(0, pull - BACK_PX) * 0.15 - 44}px 0` }}
    >
      <ArrowLeftIcon weight="bold" />
    </div>
  );
}

/**
 * The nav on wide screens: a bubble dock at the bottom, the same on every page, like the tab bar on phones.
 * One pill holds the places (Home, Library, the party and you) as icons, with the lens on where you are; each
 * names itself in a tooltip on hover or focus. Search is its own round bubble beside it; focused (click, Tab,
 * / or ⌘K), it stretches into a field. Nothing else changes shape, so the dock never jumps under the pointer.
 */
export function NavDock() {
  const place = usePlace();
  const [pressed, press] = usePressed();
  // The lens stays on the page you're on. The Party panel opens beside the page rather than over it, so
  // moving the lens there made it fly to each page you picked and straight back.
  const here = pressed ?? place;
  const { ref, lens } = useLiquidLens<HTMLDivElement>(here === "search" ? null : here);
  const search = useRef<HTMLElement>(null);
  const searchBubble = useRef<Bubble | null>(null);

  return (
    <nav
      aria-label="Main"
      // w-max: centred with left 50%, it would otherwise get only half the window.
      className="fixed bottom-5 left-1/2 z-40 hidden w-max -translate-x-1/2 items-center gap-3 md:flex"
    >
      <Glass {...barBubble()} ref={ref as React.Ref<HTMLElement>} className="bubble-bar relative flex h-16 items-center gap-1 rounded-full p-1.5">
        {lens}
        {links
          .filter((l) => l.id !== "search")
          .map((l) => (
            <DockLink key={l.id} {...l} onPress={press} />
          ))}
        <PartyNavButton />
        <ProfileMenu />
      </Glass>
      <Glass {...barBubble()} ref={search} onBubble={(b: Bubble) => (searchBubble.current = b)} className="bubble-bar relative flex h-16 items-center rounded-full p-1.5">
        <NavSearch anchor={search} bubble={searchBubble} />
      </Glass>
    </nav>
  );
}

function DockLink({ to, id, end, label, icon: Icon, onPress }: (typeof links)[number] & { onPress: (id: string) => void }) {
  const prefetch = usePrefetchPlace(id);
  const place = usePlace();
  return (
    <NavLink
      to={to}
      end={end}
      data-lens={id}
      aria-label={label}
      {...prefetch}
      onClick={() => {
        backToTop(place === id);
        onPress(id);
      }}
      className={({ isActive }) =>
        cx("dock-item press relative z-1 grid size-13 place-items-center rounded-full", isActive ? "text-fg" : "fill-hover text-fg-muted hover:text-fg")
      }
    >
      {({ isActive }) => (
        <>
          <Icon aria-hidden size={24} weight={isActive ? "fill" : "regular"} />
          <DockTip>{label}</DockTip>
        </>
      )}
    </NavLink>
  );
}

/** Your avatar, marked while private mode is on so it isn't left on by mistake. */
function YouAvatar({ size }: { size: number }) {
  const { me } = useSession();
  if (!me) return null;
  return (
    <span className="relative inline-grid">
      <Avatar name={me.name} hue={me.hue} size={size} />
      {me.prefs.private && (
        <span className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-page text-fg ring-1 ring-line">
          <EyeSlashIcon aria-hidden size={10} weight="bold" />
        </span>
      )}
    </span>
  );
}

const UPDATE_HINT: Partial<Record<AppUpdate["status"]["state"], string>> = {
  checking: "Checking…",
  downloading: "Downloading…",
  current: "Up to date",
  failed: "Couldn't check",
};

/**
 * Krida's apps: the version waiting to install, or a look for one now. It stays open while it looks, so you see the
 * answer. Nothing in a browser, or in an app that can't be asked to look and has nothing waiting.
 */
function UpdateItem({ close }: { close: () => void }) {
  const update = useAppUpdate();
  if (!update) return null;
  const { state, version } = update.status;
  if (state === "ready") {
    return (
      <MenuItem
        icon={<DownloadSimpleIcon />}
        hint={version ?? undefined}
        onClick={() => {
          close();
          update.install();
        }}
      >
        {update.installLabel}
      </MenuItem>
    );
  }
  if (!update.check) return null;
  const busy = state === "checking" || state === "downloading";
  return (
    <MenuItem icon={<ArrowClockwiseIcon className={cx(busy && "animate-spin")} />} hint={UPDATE_HINT[state]} disabled={busy} onClick={update.check}>
      Check for updates
    </MenuItem>
  );
}

function ProfileMenu() {
  const { token, me, signOut, signOutAccount } = useSession();
  const update = useUpdateProfile();
  const navigate = useNavigate();
  const fullscreen = useFullscreen();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (!me) return null;
  const go = (to: string) => {
    close(false);
    navigate(to);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const to =
      e.key === "ArrowDown" ? (i + 1) % items.length
        : e.key === "ArrowUp" ? (i - 1 + items.length) % items.length
          : e.key === "Home" ? 0
            : e.key === "End" ? items.length - 1
              : null;
    if (to !== null) {
      e.preventDefault();
      items[to]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close();
    }
  };

  return (
    <>
      <button
        ref={trigger}
        data-lens="you"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${me.name}${me.prefs.private ? ", private mode on" : ""}, profile menu`}
        onClick={() => setOpen(!open)}
        className={cx("dock-item press relative z-1 grid size-13 place-items-center rounded-full", open ? "fill-raised" : "fill-hover")}
      >
        <YouAvatar size={30} />
        {!open && <DockTip>{me.prefs.private ? `${me.name} · Private` : me.name}</DockTip>}
      </button>
      <Grow
        open={open}
        from={trigger}
        placement="top"
        gap={18}
        radius={26}
        // Focus goes into the menu once it's on screen, so arrow keys and Tab work from the first item.
        onPlaced={() => menu.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()}
        className="w-64 max-w-none"
      >
        <div ref={menu} role="menu" aria-label={me.name} onKeyDown={onKeyDown} className="p-1.5">
          <div className="flex items-center gap-3 px-3 pt-2 pb-2.5">
            <Avatar name={me.name} hue={me.hue} size={32} />
            <span className="min-w-0 truncate text-body font-medium text-fg">{me.name}</span>
          </div>
          <div className="mb-1 h-px bg-line" />
          <MenuItem
            icon={<EyeSlashIcon />}
            checked={!!me.prefs.private}
            onClick={() => token && void update({ token, prefsPatch: { private: !me.prefs.private } })}
          >
            Private mode
          </MenuItem>
          <MenuItem icon={<GearSixIcon />} onClick={() => go("/settings")}>
            Settings
          </MenuItem>
          {canFullscreen() && (
            <MenuItem
              icon={fullscreen ? <CornersInIcon /> : <CornersOutIcon />}
              shortcut="F"
              onClick={() => {
                close(false);
                toggleFullscreen();
              }}
            >
              {fullscreen ? "Exit full screen" : "Full screen"}
            </MenuItem>
          )}
          <UpdateItem close={() => close(false)} />
          <MenuItem
            icon={<UserSwitchIcon />}
            onClick={() => {
              close(false);
              void signOut();
            }}
          >
            Switch profile
          </MenuItem>
          <div className="my-1 h-px bg-line" />
          <MenuItem
            icon={<SignOutIcon />}
            onClick={() => {
              close(false);
              void signOutAccount();
            }}
          >
            Sign out
          </MenuItem>
        </div>
      </Grow>
    </>
  );
}

function MenuItem({
  icon,
  shortcut,
  hint,
  checked,
  disabled,
  children,
  onClick,
}: {
  icon: React.ReactNode;
  shortcut?: string;
  /** A word on where it stands, at the right. */
  hint?: string;
  disabled?: boolean;
  /** A setting the item turns on and off; it stays open so you see it change. */
  checked?: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      aria-disabled={disabled}
      tabIndex={-1}
      onClick={disabled ? undefined : onClick}
      className="flex h-11 w-full items-center gap-3 rounded-[14px] px-3 text-left text-body whitespace-nowrap text-fg-muted outline-offset-[-2px] hover:bg-white/8 hover:text-fg focus-visible:bg-white/8 focus-visible:text-fg"
    >
      <span className="text-[18px]">{icon}</span>
      {children}
      {shortcut && (
        <span className="ml-auto">
          <Kbd>{shortcut}</Kbd>
        </span>
      )}
      {hint && <span className="ml-auto text-caption text-fg-faint tabular-nums">{hint}</span>}
      {checked !== undefined && (
        <span aria-hidden className={cx("relative ml-auto h-5 w-8 rounded-full transition-colors duration-150", checked ? "bg-accent" : "bg-white/15")}>
          <span
            className={cx(
              "absolute top-0.5 left-0.5 size-4 rounded-full transition-[translate,background-color] duration-300 ease-spring",
              checked ? "translate-x-3 bg-on-accent" : "bg-white",
            )}
          />
        </span>
      )}
    </button>
  );
}

/**
 * Phones: the same dock as on a wide screen. A floating bubble of places, icons only so nothing's written under them, and
 * search as its own round bubble beside it, in reach of the thumb. Pressed, search stretches into the field across the
 * whole bar and rises with the keyboard, its suggestions growing above it. The lens follows your finger if you slide along
 * the bar and lets go onto the tab you stop on. Held sideways the bar stands as a rail at the left (`rail`), where the phone
 * has width to spare and no height, and search goes to its page, since there's no room for a keyboard.
 */
export function BottomNav({ rail = false }: { rail?: boolean }) {
  const place = usePlace();
  const { entry, go, panelOpen, unread } = usePartyEntry();
  const live = entry.kind !== "none";
  const current = entry.kind !== "theirs" && panelOpen;
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [pressed, press] = usePressed();
  const { ref, lens } = useLiquidLens<HTMLUListElement>(dragKey ?? pressed ?? (current ? "party" : place), rail ? "y" : "x");
  const drag = useRef<{ at: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const [searching, setSearching] = useState(false);
  const search = useRef<HTMLElement>(null);
  const searchBubble = useRef<Bubble | null>(null);
  const keyboard = useKeyboardHeight();
  const tab = "press relative z-1 flex h-14 w-full items-center justify-center rounded-full";
  const places = links.filter((l) => rail || l.id !== "search");

  const itemAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-lens]") ?? null;

  return (
    <nav
      aria-label="Main"
      className={cx(
        "fixed z-40 flex items-center",
        rail ? "top-1/2 left-[calc(8px+var(--inset-left))] -translate-y-1/2" : "inset-x-3 gap-2 md:hidden",
      )}
      style={rail ? undefined : { bottom: keyboard ? keyboard + 8 : "var(--dock-bottom)" }}
      onPointerDown={(e) => {
        drag.current = { at: rail ? e.clientY : e.clientX, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || (!d.moved && Math.abs((rail ? e.clientY : e.clientX) - d.at) < 8)) return;
        d.moved = true;
        const item = itemAt(e.clientX, e.clientY);
        if (item && ref.current?.contains(item) && item.dataset.lens !== dragKey) {
          // Sliding along the bar clicks past each place, as a dial does.
          detent();
          setDragKey(item.dataset.lens ?? null);
        }
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d?.moved) return;
        // The tap's own click would land on the tab you started on; take the one you let go on instead.
        swallowClick.current = true;
        const item = itemAt(e.clientX, e.clientY);
        setTimeout(() => {
          swallowClick.current = false;
          setDragKey(null);
          if (item && ref.current?.contains(item)) item.click();
        }, 0);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragKey(null);
      }}
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Sliding along the bar moves the lens, not the page: a tab bar still lets the page scroll up and down. */}
      <div className={cx("dock-fold", !rail && "min-w-0 flex-1")} data-folded={searching || undefined} inert={searching}>
        <Glass
          {...barBubble()}
          as="ul"
          ref={ref as React.Ref<HTMLElement>}
          className={cx(
            "bubble-bar relative grid rounded-full p-1",
            rail ? "w-16 touch-none gap-1" : "h-16 touch-pan-y",
          )}
          style={rail ? undefined : { gridTemplateColumns: `repeat(${places.length + 2}, minmax(0, 1fr))` }}
        >
          {lens}
          {places.map((l) => (
            <li key={l.to} className="contents">
              <NavLink
                to={l.to}
                end={l.end}
                data-lens={l.id}
                aria-label={l.label}
                onClick={() => {
                  backToTop(place === l.id);
                  press(l.id);
                }}
                className={({ isActive }) => cx(tab, isActive ? "text-fg" : "text-fg-muted")}
              >
                {({ isActive }) => <l.icon aria-hidden size={26} weight={isActive ? "fill" : "regular"} />}
              </NavLink>
            </li>
          ))}
          <li className="contents">
            <button
              onClick={go}
              data-lens="party"
              aria-expanded={entry.kind !== "theirs" ? panelOpen : undefined}
              aria-controls={entry.kind !== "theirs" ? "party-panel" : undefined}
              aria-label={unread ? `Party, ${unread} new message${unread === 1 ? "" : "s"}` : entry.kind === "theirs" ? "Join the party" : "Party"}
              className={cx(tab, current || live ? "text-fg" : "text-fg-muted")}
            >
              <span className="relative">
                <PopcornIcon aria-hidden size={26} weight={live ? "fill" : "regular"} className="block" />
                {/* Green while the party is live, white when there's chat you haven't read. */}
                {live && (
                  <span className={cx("absolute -top-0.5 -right-1 size-2.5 rounded-full ring-2 ring-black/40", unread ? "bg-accent" : "bg-success")} />
                )}
              </span>
            </button>
          </li>
          <li className="contents">
            <NavLink
              to="/settings"
              data-lens="you"
              aria-label="You"
              onClick={() => {
                backToTop(place === "you");
                press("you");
              }}
              className={({ isActive }) => cx(tab, isActive ? "text-fg" : "text-fg-muted")}
            >
              <YouAvatar size={28} />
            </NavLink>
          </li>
        </Glass>
      </div>
      {!rail && (
        <Glass
          {...barBubble()}
          ref={search}
          onBubble={(b: Bubble) => (searchBubble.current = b)}
          data-expanded={searching || undefined}
          className="dock-search bubble-bar relative flex h-16 items-center rounded-full p-1"
        >
          <NavSearch anchor={search} bubble={searchBubble} onExpanded={setSearching} phone />
        </Glass>
      )}
    </nav>
  );
}
