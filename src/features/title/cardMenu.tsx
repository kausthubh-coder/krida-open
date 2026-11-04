import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useNavigate } from "react-router";
import { BookmarkSimpleIcon, CheckCircleIcon, InfoIcon, LinkIcon, PlayIcon, StarIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { useRate, useRating, useSaved, useSetSaved, useSetStatus, useWatchStatus } from "../../data/mine";
import { useDismiss } from "../../ui/dismiss";
import { Grow } from "../../ui/grow";
import { toast } from "../../ui/toast";
import { useOpenStartParty, useParty } from "../party";
import { usePlayTitle, useSuggest, useTitleTarget } from "../play";
import { RatingEditor } from "./taste";
import type { StatusItem } from "./watchStatus";
import { isLibraryId } from "../../../convex/lib/titleIds";

type Extra = { label: string; icon: ReactNode; onSelect: () => unknown };

/**
 * A card's right-click menu: what it can do, by name. Wrap the card; the wrapper takes no space. Nothing's drawn until
 * it's opened, since Home has hundreds of cards. Touch keeps the long press's peek, and Shift keeps the browser's own menu.
 */
export function CardMenu({ item, to, onPlay, playLabel, extra, children }: {
  item: StatusItem;
  to: string;
  /** Instead of playing the title from where you left off. */
  onPlay?: () => unknown;
  playLabel?: string;
  /** What only this card can do. */
  extra?: Extra;
  children: ReactNode;
}) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [open, setOpen] = useState(false);
  // The keyboard's place in the page, for Escape to go back to.
  const focusBack = useRef<HTMLElement | null>(null);
  const pressed = useRef<Element | null>(null);
  return (
    <div
      className="contents"
      onContextMenu={(e) => {
        const target = e.target as Element;
        // React brings in events from the card's own menus and sheets, which live elsewhere in the page.
        if (e.shiftKey || matchMedia("(hover: none)").matches || !e.currentTarget.contains(target) || target.closest('dialog, [data-bubli="panel"]')) return;
        e.preventDefault();
        focusBack.current = document.activeElement as HTMLElement | null;
        pressed.current = target;
        // The Menu key has no pointer: it opens at what has focus.
        const box = target.getBoundingClientRect();
        setPoint(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: box.left + box.width / 2, y: box.top + box.height / 2 });
        setOpen(true);
      }}
    >
      {children}
      {point && <Panel item={item} to={to} point={point} open={open} focusBack={focusBack} pressed={pressed} onClose={() => setOpen(false)} onClosed={() => setPoint(null)} onPlay={onPlay} playLabel={playLabel} extra={extra} />}
    </div>
  );
}

const row = "flex min-h-10 w-full items-center gap-3 rounded-[14px] px-3 text-left text-body whitespace-nowrap text-fg-muted outline-offset-[-2px] hover:bg-white/8 hover:text-fg focus-visible:bg-white/8 focus-visible:text-fg";

function Panel({ item, to, point, open, focusBack, pressed, onClose, onClosed, onPlay, playLabel = "Play", extra }: {
  item: StatusItem; to: string; point: { x: number; y: number }; open: boolean; focusBack: RefObject<HTMLElement | null>; pressed: RefObject<Element | null>; onClose: () => void; onClosed: () => void;
  onPlay?: () => unknown; playLabel?: string; extra?: Extra;
}) {
  const navigate = useNavigate();
  const playTitle = usePlayTitle();
  const target = useTitleTarget();
  const status = useWatchStatus(item.id);
  const saved = useSaved(item.id);
  const setSaved = useSetSaved();
  const setStatus = useSetStatus();
  const rating = useRating(item.id);
  const rate = useRate();
  const party = useParty();
  const suggest = useSuggest();
  const openStartParty = useOpenStartParty();
  const [rateOpen, setRateOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const none = useRef<HTMLElement>(null);
  const close = (refocus: boolean) => {
    onClose();
    if (refocus) focusBack.current?.focus();
  };
  useDismiss(open, close, none, panel);
  // The card scrolls away from it, in the page or along its row. A scroll that leaves the card where it was (the browser
  // settling a page that's still arriving) is no reason to close.
  useEffect(() => {
    if (!open) return;
    const card = pressed.current;
    const at = card?.getBoundingClientRect();
    const onScroll = () => {
      const now = card?.getBoundingClientRect();
      if (!at || !now || Math.abs(now.top - at.top) > 4 || Math.abs(now.left - at.left) > 4) close(false);
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Runs what was chosen after the menu's on its way: a slow save shouldn't hold it open. */
  const choose = (action: () => unknown, failure = "That didn't work. Try again.") => () => {
    close(false);
    void Promise.resolve().then(action).catch(() => toast.error(failure));
  };
  const savedItem = { type: item.type, imdbId: item.id, name: item.name, poster: item.poster, year: item.year };
  const removeFromPlan = async () => {
    const addedAt = await setSaved(savedItem, false);
    if (addedAt !== null) toast(`Removed ${item.name} from Plan to watch`, { duration: 6000, action: { label: "Undo", onClick: () => void setSaved(savedItem, true, addedAt) } });
  };
  // A title with a status of its own keeps it: the bookmark goes beside it, as it does in the status menu.
  const addToPlan = () => (status ? setSaved(savedItem, true) : setStatus(item, "plantowatch"));

  return <>
    <Grow
      ref={panel}
      open={open}
      from={() => ({ x: point.x, y: point.y, width: 1, height: 1 })}
      placement="bottom-start"
      gap={4}
      radius={22}
      // The rating sheet opens as the menu closes and lives in here, so this stays until that's closed too.
      onClosed={() => { if (!rateOpen) onClosed(); }}
      onPlaced={() => menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()}
      className="pointer-events-auto w-72 max-w-[calc(100vw-16px)]"
    >
      <div
        ref={menu}
        role="menu"
        aria-label={item.name}
        className="p-1.5"
        onKeyDown={(e) => {
          const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
          const at = items.indexOf(document.activeElement as HTMLElement);
          const next = e.key === "ArrowDown" ? (at + 1) % items.length : e.key === "ArrowUp" ? (at - 1 + items.length) % items.length
            : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
          if (next !== null) { e.preventDefault(); items[next]?.focus(); }
          if (e.key === "Tab") { e.preventDefault(); close(true); }
        }}
      >
        <p className="truncate px-3 pt-2 pb-1.5 text-caption text-fg-faint" title={item.name}>{item.name}</p>
        <Item icon={<PlayIcon weight="fill" />} onClick={choose(onPlay ?? (() => playTitle(item.type, item.id)), "Couldn't load that title. Try again.")}>{playLabel}</Item>
        <Item icon={<InfoIcon />} onClick={choose(() => navigate(to))}>Details</Item>
        {isLibraryId(item.id) && <>
          <div role="separator" className="mx-3 my-1 h-px bg-line" />
          {saved ? (
            <Item icon={<BookmarkSimpleIcon weight="fill" />} onClick={choose(removeFromPlan)}>Remove from Plan to watch</Item>
          ) : status !== "plantowatch" && (
            <Item icon={<BookmarkSimpleIcon />} onClick={choose(addToPlan)}>Add to Plan to watch</Item>
          )}
          {status !== "completed" && (
            <Item icon={<CheckCircleIcon />} onClick={choose(() => setStatus(item, "completed"), "Couldn't save your status. Try again.")}>
              {item.type === "series" ? "Mark the whole show watched" : "Mark as watched"}
            </Item>
          )}
          <Item icon={<StarIcon weight={rating ? "fill" : "regular"} />} onClick={choose(() => setRateOpen(true))}>
            {rating ? `Your rating: ${rating}/10` : "Rate"}
          </Item>
        </>}
        <div role="separator" className="mx-3 my-1 h-px bg-line" />
        {!party ? (
          <Item icon={<UsersThreeIcon />} onClick={choose(async () => { const { media, startAt } = await target(item.type, item.id); openStartParty(media, startAt); }, "Couldn't load that title. Try again.")}>Watch together</Item>
        ) : party.status === "idle" && (
          <Item icon={<UsersThreeIcon />} onClick={choose(async () => suggest((await target(item.type, item.id)).media), "Couldn't load that title. Try again.")}>Suggest to the party</Item>
        )}
        <Item icon={<LinkIcon />} onClick={choose(async () => { await navigator.clipboard.writeText(new URL(to, location.origin).href); toast("Link copied"); }, "Couldn't copy the link.")}>Copy link</Item>
        {extra && <>
          <div role="separator" className="mx-3 my-1 h-px bg-line" />
          <Item icon={extra.icon} onClick={choose(extra.onSelect)}>{extra.label}</Item>
        </>}
      </div>
    </Grow>
    {rateOpen && <RatingEditor item={item} instant={false} onClose={() => { setRateOpen(false); onClosed(); }}
      onSave={(change) => rate({ id: item.id, type: item.type, name: item.name, poster: item.poster }, change)} />}
  </>;
}

function Item({ icon, onClick, children }: { icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" tabIndex={-1} onClick={onClick} className={row}>
      <span className="shrink-0 text-[18px]">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}
