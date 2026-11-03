import { useId, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { ConvexError } from "convex/values";
import { useDismiss } from "../../ui/dismiss";
import { Grow } from "../../ui/grow";
import { toast } from "../../ui/toast";
import { ArrowClockwiseIcon, BookmarkSimpleIcon, CaretDownIcon, CheckIcon, CheckCircleIcon, PauseCircleIcon, PlayCircleIcon, PlusIcon, XCircleIcon } from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { useSaved, useSetSaved, useSetStatus, useWatchStatus } from "../../data/mine";
import { statusLabel, WATCH_STATUSES, type WatchStatus } from "../../data/watchStatus";
import { simklListFor, syncableStatus, type TrackedStatus } from "../../../convex/lib/watchStatus";
import { Button, cx, IconButton } from "../../ui/ui";

export type StatusItem = { id: string; type: "movie" | "series"; name: string; poster?: string; year?: string };
/**
 * A button inside a glass toolbar (the title page's actions). Plain, because glass inside glass can't see the
 * page: 40px in the 48px capsule, round like it, with the hit area reaching the capsule's top and bottom.
 */
export const toolbarItem =
  "press relative inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full px-4 text-body font-medium " +
  "fill-hover whitespace-nowrap text-fg select-none hover:bg-white/10 disabled:opacity-40 after:absolute after:inset-x-0 after:-inset-y-1";
const icons = { plantowatch: BookmarkSimpleIcon, watching: PlayCircleIcon, completed: CheckCircleIcon,
  rewatching: ArrowClockwiseIcon, hold: PauseCircleIcon, dropped: XCircleIcon };

export function StatusButton({ item, size = "lg", undo }: { item: StatusItem; size?: "sm" | "lg"; undo?: boolean }) {
  const { token } = useAuthed();
  const status = useWatchStatus(item.id);
  const [open, setOpen] = useState(false);
  const details = useQuery(api.library.statusFor, open ? { token, id: item.id } : "skip");
  const setStatus = useSetStatus();
  const saved = useSaved(item.id);
  const setSaved = useSetSaved();
  const remove = async () => {
    const savedItem = { type: item.type, imdbId: item.id, name: item.name, poster: item.poster, year: item.year };
    const addedAt = await setSaved(savedItem, false);
    if (undo && addedAt !== null) toast(`Removed ${item.name} from Plan to watch`, { duration: 6000,
      action: { label: "Undo", onClick: () => void setSaved(savedItem, true, addedAt) } });
  };
  return <StatusMenu item={item} size={size} status={status} open={open} onOpenChange={setOpen}
    sync={details?.sync} syncError={details?.syncError} simkl={details?.simkl}
    onRemove={saved ? remove : undefined}
    onChange={(state) => setStatus(item, state)} />;
}

/**
 * The title page's one list control. It names where you stand (Plan to watch, Watching, Watched…) and opens
 * the status menu, which can also add or remove the bookmark. Glass on artwork, solid on a flat page, plain
 * inside a glass toolbar.
 */
export function ListButton({ item, variant = "glass", className }: {
  item: StatusItem; variant?: "glass" | "secondary" | "toolbar"; className?: string;
}) {
  const { token } = useAuthed();
  const status = useWatchStatus(item.id);
  const saved = useSaved(item.id);
  const [open, setOpen] = useState(false);
  const details = useQuery(api.library.statusFor, open ? { token, id: item.id } : "skip");
  const setStatus = useSetStatus();
  const setSaved = useSetSaved();
  const savedItem = { type: item.type, imdbId: item.id, name: item.name, poster: item.poster, year: item.year };
  const add = () => setSaved(savedItem, true);
  const remove = async () => {
    const addedAt = await setSaved(savedItem, false);
    if (addedAt !== null) toast(`Removed ${item.name} from Plan to watch`, { duration: 6000,
      action: { label: "Undo", onClick: () => void setSaved(savedItem, true, addedAt) } });
  };
  return <StatusMenu item={item} variant={variant} className={className} status={status} open={open} onOpenChange={setOpen}
    sync={details?.sync} syncError={details?.syncError} simkl={details?.simkl}
    onAdd={saved === false && status ? add : undefined}
    onRemove={saved ? remove : undefined}
    onChange={(state) => setStatus(item, state)} />;
}

/** "On Simkl, Rewatching shows as Watched, and Watching and On hold as Plan to watch." */
function nearestLists(item: StatusItem, simkl?: TrackedStatus) {
  const groups = new Map<string, string[]>();
  for (const { value, label } of WATCH_STATUSES) if (!syncableStatus(item.type, item.id, value)) {
    const list = statusLabel(simklListFor(item.type, item.id, value, simkl));
    groups.set(list, [...groups.get(list) ?? [], label]);
  }
  const parts = [...groups].map(([list, labels], i) =>
    `${new Intl.ListFormat("en").format(labels)} ${i === 0 ? `show${labels.length === 1 ? "s" : ""} as ` : "as "}${list}`);
  return `On Simkl, ${parts.join(", and ")}.`;
}

/** The menu is a bubble in the top layer, so it escapes a poster's clipping; it grows out of the trigger and shrinks back into it. */
export function StatusMenu({ item, size = "lg", variant = "icon", className, status, open, onOpenChange, loading, sync, syncError, simkl, onChange, onAdd, onRemove }: {
  item: StatusItem; size?: "sm" | "lg"; variant?: "icon" | "glass" | "secondary" | "toolbar"; className?: string; status: WatchStatus | null | undefined; open: boolean;
  onOpenChange: (open: boolean) => void; loading?: boolean; sync?: "on" | "off" | "disconnected" | "reconnect";
  syncError?: string; simkl?: TrackedStatus; onChange: (status: WatchStatus) => Promise<unknown>;
  onAdd?: () => Promise<unknown>;
  onRemove?: () => Promise<unknown>;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const close = (refocus = true) => {
    onOpenChange(false);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(open, close, trigger, panel);
  // Once the bubble's on screen, so its options can take focus.
  const focusIn = () => (menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus();
  const save = async (state: WatchStatus | "add" | null) => {
    if (savingRef.current || loading) return;
    savingRef.current = true; setSaving(true);
    close();
    try { if (state === null) await onRemove?.(); else if (state === "add") await onAdd?.(); else await onChange(state); }
    catch (e) { toast.error(e instanceof ConvexError && typeof e.data === "string" ? e.data : "Couldn't save your status. Try again."); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const CurrentIcon = status ? icons[status] : PlusIcon;
  const icon = <CurrentIcon weight={status ? "fill" : "bold"} className={status ? "text-accent" : undefined} />;
  const triggerProps = {
    "aria-haspopup": "menu" as const, "aria-controls": id, "aria-expanded": open,
    onClick: () => onOpenChange(!open),
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); onOpenChange(true); } },
  };
  const where = <span className="truncate">{status ? statusLabel(status) : "Plan to watch"}</span>;
  const caret = <CaretDownIcon weight="bold" aria-hidden className="-mr-1 shrink-0 text-[0.8em] text-fg-muted" />;
  const labelledProps = {
    "aria-busy": saving || undefined, title: "Watch status",
    "aria-label": status ? `${statusLabel(status)}. Change watch status for ${item.name}` : `Add ${item.name} to Plan to watch or set a watch status`,
  };
  return <>
    {variant === "icon" ? <IconButton ref={trigger} size={size} tone="scrim" className={size === "sm" ? "min-h-11 min-w-11" : undefined}
      label={`${status ? `${statusLabel(status)}. Change` : "Set"} watch status for ${item.name}`}
      aria-busy={saving} {...triggerProps}>
      {icon}
    </IconButton> : variant === "toolbar" ? <button ref={trigger} type="button" className={cx(toolbarItem, "min-w-0 pl-3.5", className)}
      {...labelledProps} {...triggerProps}>
      <span className="inline-flex shrink-0 text-[20px]">{icon}</span>
      {/* Under 360px (a folded Fold) the bar has no room for the word; the icon says it, and the label names it. */}
      <span className="truncate max-[22.5rem]:sr-only">{status ? statusLabel(status) : "Plan to watch"}</span>{caret}
    </button> : <Button ref={trigger} size="lg" variant={variant} icon={icon} className={cx("min-w-0", className)}
      {...labelledProps} {...triggerProps}>
      {where}{caret}
    </Button>}
    <Grow ref={panel} open={open} from={trigger} placement="bottom-end" radius={24} id={id} onPlaced={focusIn} aria-busy={saving || loading} className="pointer-events-auto w-64 max-w-[calc(100vw-16px)]">
    <div ref={menu} className="p-1.5"
      onKeyDown={(e) => {
        const options = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]') ?? [])];
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? (index + 1) % options.length : e.key === "ArrowUp" ? (index - 1 + options.length) % options.length
          : e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : null;
        if (next !== null) { e.preventDefault(); options[next]?.focus(); }
        if (e.key === "Tab") close();
      }}>
      <p className="truncate px-3 pt-2 pb-1 text-caption text-fg-muted" title={item.name}>{item.name}</p>
      <div role="menu" aria-label={`Watch status for ${item.name}`}>
      {WATCH_STATUSES.map(({ value, label }) => {
          const Icon = icons[value];
          const selected = status === value;
          // Inside a bubble the current status is a soft shade, never a bubble in a bubble.
          return <button key={value} role="menuitemradio" aria-checked={selected} aria-disabled={saving} tabIndex={-1}
            onClick={() => void save(value)} className={cx("flex min-h-11 w-full items-center gap-3 rounded-control px-3 py-2 text-left text-body",
              selected ? "lens text-fg" : "text-fg-muted hover:bg-white/8 hover:text-fg", saving && "opacity-60")}>
            <Icon weight={selected ? "fill" : "regular"} className="shrink-0 text-[20px]" /><span className="flex-1">{label}</span>
            {selected && <CheckIcon weight="bold" className="shrink-0" />}
          </button>;
        })}
      {/* Adding or removing the bookmark is a different kind of choice from where you stand. */}
      {!loading && (onAdd || onRemove) && <div role="separator" className="mx-3 my-1 h-px bg-line" />}
      {!loading && onAdd && <button role="menuitem" tabIndex={-1} aria-disabled={saving}
        onClick={() => void save("add")} className="flex min-h-11 w-full items-center gap-3 rounded-control px-3 text-left text-body text-fg-muted hover:bg-white/8 hover:text-fg">
        <BookmarkSimpleIcon className="text-[20px]" />Add to Plan to watch
      </button>}
      {!loading && onRemove && <button role="menuitem" tabIndex={-1} aria-disabled={saving}
        onClick={() => void save(null)} className="flex min-h-11 w-full items-center gap-3 rounded-control px-3 text-left text-body text-fg-muted hover:bg-white/8 hover:text-fg">
        <XCircleIcon className="text-[20px]" />Remove from Plan to watch
      </button>}
      </div>
      <div className="mx-3 mt-1 mb-2 border-t border-line pt-2 text-caption text-fg-faint">
        {sync && <p>{sync === "on" ? "Changes sync to Simkl." : sync === "reconnect" ? "Reconnect Simkl in Settings to sync." : "Saved in Krida."}</p>}
        {/* Down here rather than on each option, so arriving late moves nothing under the pointer. */}
        {sync === "on" && <p className="mt-1">{nearestLists(item, simkl)}</p>}
        {syncError && <p role="alert" className="mt-2 text-warning">{syncError}</p>}
        {item.type === "series" && <p className="mt-1">Watched marks the whole show complete.</p>}
      </div>
    </div>
    </Grow>
  </>;
}
