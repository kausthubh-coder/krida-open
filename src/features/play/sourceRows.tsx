// The sources sheet's parts: the pick, the rows with their details, the sort headers, the speed meter, the audio menu.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowSquareOutIcon,
  ArrowUpIcon,
  CaretDownIcon,
  CheckIcon,
  PlayIcon,
  SparkleIcon,
  SubtitlesIcon,
} from "@phosphor-icons/react";
import { currentScreen } from "../../ui/screen";
import { formatSize, plural } from "../../ui/format";
import { Button, cx, Spinner } from "../../ui/ui";
import { ANY, COLS, ORDER_TEXT, SPEED, SPEED_IN_APP, SUBS_SHOWN, type Sort, type SortKey, audioLabel, hdrName, hdrTag, mbps, mismatchLabel, nextSort, realLanguages, resLabel, subsLabel, widestChannels } from "./sourceLabels";
import type { SourceOption } from "./sources";
import { ExternalPlayersFor } from "./externalPlayers";
import { useFileLink } from "./fileLink";
import { containerOf, fileKind, isBrowserContainer } from "../../../shared/formats";

// ---------- pieces

/** The pick's own shape and the rows' columns while the list loads, so nothing jumps when it arrives. */
export function Loading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section className="flex h-44 shrink-0 flex-col justify-between rounded-menu bg-surface p-4 shadow-[inset_0_1px_0_oklch(1_0_0/0.1)]">
        <p className="flex items-center gap-1.5 text-caption font-medium text-fg-faint">
          <SparkleIcon weight="fill" aria-hidden />
          Krida’s pick
        </p>
        <p className="flex items-center gap-2.5 text-body text-fg-muted">
          <Spinner />
          Asking your addons for sources…
        </p>
        <div className="h-13 rounded-control bg-white/4" />
      </section>
      <div className="mt-6 flex flex-col">
        {[96, 72, 120, 64, 88, 104].map((width, i) => (
          // Ends where a row's columns end, before its caret.
          <div key={i} className={cx(COLS, "min-h-12 pr-9 narrow:pr-8")}>
            <span className="flex flex-col gap-1.5">
              <span className="skeleton h-3 w-9 rounded-sm" />
              <span className="skeleton h-2.5 w-12 rounded-sm" />
            </span>
            <span className="flex flex-col gap-1.5">
              <span className="skeleton h-3 rounded-sm" style={{ width }} />
              <span className="skeleton h-2.5 w-18 rounded-sm" />
            </span>
            <span className="skeleton h-3 w-3 justify-self-center rounded-sm" />
            <span className="skeleton h-3 w-12 justify-self-end rounded-sm" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** What's on now, on the pane: a small bubble with the bars of something playing. */
function PlayingNow() {
  return (
    <span className="glass relative inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-3.5 text-body font-medium text-fg">
      <span aria-hidden className="playing-bars flex h-3.5 items-end gap-0.5">
        <i />
        <i />
        <i />
      </span>
      Playing
    </span>
  );
}

/** Krida's pick: the title's art, with what you need to know floating on it. */
function BubblePick({ option: o, art, reason, current, onPick, picture, facts }: PickProps & { picture: string; facts: [string, string][] }) {
  const [artFailed, setArtFailed] = useState(false);
  return (
    <section aria-label="Krida’s pick" className="relative isolate flex min-h-60 shrink-0 flex-col justify-between overflow-hidden rounded-[24px] bg-surface p-4 img-outline">
      {art && !artFailed && (
        <>
          <img src={art} alt="" decoding="async" onError={() => setArtFailed(true)} className="absolute inset-0 -z-10 size-full object-cover object-[60%_30%]" />
          <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-t from-black/85 via-black/45 to-black/20" />
        </>
      )}
      <div className="flex items-start justify-between gap-3">
        <p className="glass relative inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-body font-medium text-fg">
          <SparkleIcon weight="fill" aria-hidden />
          Krida’s pick
        </p>
        {current ? (
          <PlayingNow />
        ) : (
          <Button variant="primary" icon={<PlayIcon weight="fill" />} onClick={onPick}>
            Play
          </Button>
        )}
      </div>
      <div>
        <p className="truncate text-title font-semibold drop-shadow-[0_1px_8px_oklch(0_0_0/0.6)]">
          {picture || o.quality || <span className="font-normal text-fg-muted">Format not listed</span>}
          {picture && o.quality && <span className="font-normal text-fg-muted"> · {o.quality}</span>}
        </p>
        <p className="mt-0.5 text-body text-pretty text-fg-muted drop-shadow-[0_1px_8px_oklch(0_0_0/0.6)]">{reason}</p>
        <dl className="mt-3 flex flex-wrap gap-2">
          {facts.map(([label, value]) => (
            <div key={label} className="glass relative min-w-0 max-w-full rounded-2xl px-3 py-1.5">
              <dt className="text-caption text-fg-muted">{label}</dt>
              <dd className="max-w-44 truncate text-body font-medium tabular-nums" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

type PickProps = {
  option: SourceOption;
  art?: string;
  reason: string;
  current: boolean;
  onPick: () => void;
};

export function PickCard({
  option: o,
  art,
  reason,
  current,
  onPick,
}: PickProps) {
  const picture = [o.resolution && resLabel(o.resolution), hdrName(o)].filter(Boolean).join(" ");
  const facts = [
    // Channels only with one language: "English, Italian 5.1" reads as if only Italian had it.
    ["Audio", [audioLabel(o) ?? "Not listed", realLanguages(o).length <= 1 && widestChannels(o)].filter(Boolean).join(" ")],
    ["Subtitles", subsLabel(o) ?? "None"],
    ["Playback", SPEED[o.speed].word],
    ["Size", formatSize(o.size) ?? "Unknown"],
  ].filter((fact): fact is [string, string] => !!fact[1]);
  return <BubblePick option={o} art={art} reason={reason} current={current} onPick={onPick} picture={picture} facts={facts} />;
}

const BARS = [5, 9, 13];

/**
 * How well a file keeps up in the browser, as signal bars, so the column compares at a glance. Only a file that may
 * buffer gets a color: that one is a warning. The playing file's bars move instead.
 */
function SpeedMeter({ speed, playing }: { speed: SourceOption["speed"]; playing: boolean }) {
  if (!playing && speed === "unknown") {
    return (
      <span title={SPEED.unknown.note} className="text-caption text-fg-faint">
        <span aria-hidden>–</span>
        <span className="sr-only">{SPEED.unknown.note}</span>
      </span>
    );
  }
  const { bars, note } = SPEED[speed];
  const label = playing ? "Playing" : note;
  return (
    <span role="img" aria-label={label} title={label} className="flex h-3.25 items-end gap-0.5">
      {BARS.map((height, i) => (
        <span
          key={height}
          style={playing ? { height: 13, animationDelay: `${-0.35 * i}s` } : { height }}
          className={cx(
            "w-0.75 rounded-full",
            playing ? "origin-bottom animate-[playing-bar_1s_ease-in-out_infinite_alternate] bg-fg motion-reduce:animate-none"
            : i >= bars ? "bg-white/16"
            : bars === 3 ? "bg-fg"
            : bars === 2 ? "bg-fg-muted"
            : "bg-warning",
          )}
        />
      ))}
    </span>
  );
}

export function SortHeader({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: Exclude<SortKey, "best">;
  sort: Sort;
  onSort: (sort: Sort) => void;
  className?: string;
}) {
  const on = sort.key === column;
  const state = on ? `${label}, ${ORDER_TEXT[column][sort.dir === 1 ? 0 : 1]}` : `Sort by ${label.toLowerCase()}`;
  return (
    <button
      onClick={() => onSort(nextSort(sort, column))}
      aria-label={state}
      title={state}
      className={cx(
        // Taller to the touch than it looks.
        "relative -mx-2 inline-flex h-8 items-center gap-0.5 rounded-full px-2 text-caption font-medium whitespace-nowrap after:absolute after:-inset-y-1.5 after:inset-x-0",
        on ? "text-fg" : "text-fg-faint hover:bg-white/6 hover:text-fg",
        className,
      )}
    >
      {label}
      {on && (sort.dir === 1 ? <ArrowDownIcon aria-hidden className="size-3" /> : <ArrowUpIcon aria-hidden className="size-3" />)}
    </button>
  );
}

export function SourceRow({
  option: o,
  current,
  open,
  onToggle,
  onPick,
  external,
  direct,
}: {
  option: SourceOption;
  current: boolean;
  open: boolean;
  onToggle: () => void;
  onPick: () => void;
  /** This file's link for another player, and what to call it. */
  external?: { title: string; link: () => Promise<string> };
  /** The account's files play as they are here (another debrid service in a browser). */
  direct?: boolean;
}) {
  const audio = audioLabel(o);
  const subs = subsLabel(o);
  const kind = [hdrTag(o), o.upscale && "AI upscale", o.quality ?? o.codec].filter(Boolean).join(" · ");
  const detailsId = `source-${o.index}`;

  // Two lines, each column the same thing on every row: the picture, what it sounds like, how it plays, its size.
  // Codecs, bitrates and where it was found are in the details.
  return (
    // Open, the row and its details are one card, so it's clear which file they describe.
    <li className={cx("rounded-card", open && "bg-white/4")}>
      <div className={cx("flex rounded-card", current ? "lens" : "fill-hover hover:bg-white/6")}>
        <button
          onClick={onPick}
          disabled={o.unavailable}
          aria-current={current || undefined}
          className={cx(COLS, "press-soft min-h-12 min-w-0 flex-1 py-2 pr-3 pl-2 text-left disabled:opacity-50 narrow:pr-2")}
        >
          <span className="flex min-w-0 flex-col">
            <span className={cx("text-body font-semibold", o.resolution === "2160p" ? "text-fg" : "text-fg-muted")}>
              {o.resolution ? resLabel(o.resolution) : (
                <span title="Resolution not listed" className="font-normal text-fg-faint">
                  <span aria-hidden>–</span>
                  <span className="sr-only">Resolution not listed</span>
                </span>
              )}
            </span>
            {kind && <span className="truncate text-caption text-fg-faint">{kind}</span>}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-body text-fg" title={o.languages.join(", ")}>
              {audio ?? (o.audio.length ? o.audio.join(", ") : <span className="text-fg-faint">Audio not listed</span>)}
            </span>
            {o.unavailable ? (
              <span className="truncate text-caption text-fg-muted">{o.needsDebrid ? "Needs a debrid service" : "Unavailable right now"}</span>
            ) : o.mismatch ? (
              <span className="truncate text-caption font-medium text-danger">{mismatchLabel(o.mismatch)}</span>
            ) : (
              <span className="flex min-w-0 items-center gap-1 text-caption text-fg-faint" title={o.subtitles.join(", ")}>
                <SubtitlesIcon className="shrink-0" aria-label="Subtitles" />
                <span className="truncate">{subs ?? "None"}</span>
              </span>
            )}
          </span>
          <span className="justify-self-center">
            <SpeedMeter speed={o.speed} playing={current} />
          </span>
          <span className="text-right text-body text-fg-muted tabular-nums">
            {o.size ? formatSize(o.size) : (
              <span title="Size unknown" className="text-fg-faint">
                <span aria-hidden>–</span>
                <span className="sr-only">Size unknown</span>
              </span>
            )}
          </span>
        </button>
        <button
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label="Details"
          className="grid w-8 shrink-0 place-items-center self-stretch rounded-card text-fg-faint hover:text-fg"
        >
          <CaretDownIcon className={cx("transition-transform duration-150 ease-out", open && "rotate-180")} />
        </button>
      </div>
      {open && <SourceDetails id={detailsId} option={o} current={current} onPick={onPick} external={external} direct={direct} />}
    </li>
  );
}

function SourceDetails({
  id,
  option: o,
  current,
  onPick,
  external,
  direct,
}: {
  id: string;
  option: SourceOption;
  current: boolean;
  onPick: () => void;
  external?: { title: string; link: () => Promise<string> };
  direct?: boolean;
}) {
  const container = containerOf(o.filename);
  const [handOff, setHandOff] = useState(false);
  const video = [
    resLabel(o.resolution),
    o.codec,
    o.tenBit && "10-bit",
    ...o.hdr,
    o.bitrate && mbps(o.bitrate),
    o.upscale && "AI upscale",
  ]
    .filter(Boolean)
    .join(" · ");
  const [allSubs, setAllSubs] = useState(false);
  // Packs can list thirty subtitle languages; a few, then the rest on request, keep the details scannable.
  const subsShown = allSubs || o.subtitles.length <= SUBS_SHOWN + 1 ? o.subtitles : o.subtitles.slice(0, SUBS_SHOWN);
  const audio = [realLanguages(o).join(", "), o.audio.join(", "), o.channels.join(", ")].filter(Boolean).join(" · ");
  const found = `${o.foundOn.join(", ")}${o.indices.length > 1 ? ` · ${plural(o.indices.length, "copy", "copies")}` : ""}`;
  // Rows without a value are left out.
  const rows: [string, ReactNode][] = [
    ["Episode", o.mismatch && mismatchLabel(o.mismatch)],
    ["Video", video],
    ["Audio", audio || "Not listed"],
    [
      "Subtitles",
      o.subtitles.length === 0 ? (
        "None listed"
      ) : (
        <>
          {subsShown.join(", ")}
          {/* The same button stays to fold the list back, so focus isn't dropped when it opens. */}
          {o.subtitles.length > SUBS_SHOWN + 1 && (
            <>
              {" "}
              <button
                aria-expanded={allSubs}
                onClick={() => setAllSubs(!allSubs)}
                className="relative font-medium text-fg underline decoration-fg-faint underline-offset-2 after:absolute after:-inset-2 hover:decoration-fg"
              >
                {allSubs ? "Show fewer" : `and ${o.subtitles.length - SUBS_SHOWN} more`}
              </button>
            </>
          )}
        </>
      ),
    ],
    o.needsDebrid
      ? ["To play", "This copy is a torrent, which needs a debrid service. Add one in Settings → Connections."]
      : currentScreen() === "app"
      ? ["In the app", <>The original file, picture and sound as they are. {SPEED_IN_APP[o.speed]}</>]
      : direct
        ? [
            "In the browser",
            isBrowserContainer(container)
              ? "Plays as it is, straight from its link."
              : `This is ${fileKind(container)}, which browsers can’t play: it plays in Krida for Mac and Windows, or another player.`,
          ]
        : [
          "In the browser",
          <>
            H.264 with stereo sound. {SPEED[o.speed].text}
            {o.dvOnly && " Dolby Vision without HDR10, so colors can look off."}
            {!o.dvOnly && o.hdr.length > 0 &&
              (currentScreen() === "hdr"
                ? " HDR is kept in 8-bit, so dark scenes can band."
                : " This screen isn’t showing HDR, so it plays darker than an SDR copy.")}
          </>,
        ],
    [
      "Size",
      <span key="size" className="tabular-nums">
        {o.size ? formatSize(o.size) : "Unknown"}
        {o.packSize && ` from a ${formatSize(o.packSize)} pack`}
      </span>,
    ],
    ["Release group", o.group],
    ["Service", o.service],
    ["Found on", found],
    ["File", <span key="file" className="[overflow-wrap:anywhere]">{o.filename ?? "Unknown"}</span>],
  ];
  return (
    // On the audio column's edge (row padding 8 + quality 76 + gap 12); phones keep the width for the values.
    <div id={id} className="flex flex-col gap-3 px-2 pt-2 pb-3 sm:pl-24">
      <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-2 text-caption">
        {rows.filter(([, value]) => value).map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-fg-faint">{label}</dt>
            <dd className="text-fg-muted">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        {!current && !o.unavailable && (
          <Button icon={<PlayIcon weight="fill" />} onClick={onPick}>
            Play this source
          </Button>
        )}
        {external && !o.unavailable && !handOff && (
          <Button variant="ghost" icon={<ArrowSquareOutIcon />} onClick={() => setHandOff(true)}>
            Open in another player
          </Button>
        )}
      </div>
      {external && handOff && <HandOff title={external.title} link={external.link} />}
    </div>
  );
}

/** The players this file can go to, once its link is in. */
function HandOff({ title, link }: { title: string; link: () => Promise<string> }) {
  const state = useFileLink(link, true);
  return <ExternalPlayersFor link={state} title={title} />;
}

// ---------- audio menu

/** The Audio column's header: filters the list by audio language. */
export function AudioMenu({
  value,
  onChange,
  choices,
}: {
  value: string;
  onChange: (value: string) => void;
  choices: { value: string; count: number }[];
}) {
  const [open, setOpen] = useState(false);
  // Opens upward when the screen ends before the menu would.
  const [up, setUp] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const all = [{ value: ANY, label: "Any audio", count: undefined }, ...choices.map((c) => ({ ...c, label: c.value }))];
  const active = value !== ANY;
  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];

  useEffect(() => {
    if (!open) return;
    // Focus moves in, onto the current choice.
    (items().find((b) => b.getAttribute("aria-checked") === "true") ?? items()[0])?.focus();
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    const height = menu.current?.offsetHeight ?? 0;
    if (rect) setUp(rect.bottom + 4 + height > window.innerHeight - 8 && rect.top - 4 - height >= 8);
    setOpen(true);
  };

  return (
    <div
      ref={root}
      className="relative min-w-0 justify-self-start"
      // Tabbing out closes it, like a click outside.
      onBlur={(e) => {
        if (open && !root.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={active ? `Audio: ${value}` : "Filter by audio"}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          show();
        }}
        className={cx(
          "relative -mx-2 flex h-8 max-w-[calc(100%+16px)] items-center gap-1 rounded-full px-2 text-caption font-medium whitespace-nowrap after:absolute after:-inset-y-1.5 after:inset-x-0",
          active ? "fill-raised bg-white/10 text-fg hover:bg-white/15" : "fill-hover text-fg-faint hover:bg-white/6 hover:text-fg",
        )}
      >
        <span className="truncate">{active ? `${value} audio` : "Audio"}</span>
        <CaretDownIcon className="size-3 shrink-0" aria-hidden />
      </button>
      <div
        ref={menu}
        role="menu"
        aria-label="Audio"
        data-open={open || undefined}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // Closes the menu, not the sheet around it.
            e.stopPropagation();
            e.preventDefault();
            close();
            return;
          }
          const list = items();
          const at = list.indexOf(document.activeElement as HTMLButtonElement);
          const to =
            e.key === "ArrowDown" ? (at + 1) % list.length
            : e.key === "ArrowUp" ? (at - 1 + list.length) % list.length
            : e.key === "Home" ? 0
            : e.key === "End" ? list.length - 1
            : null;
          if (to === null) return;
          e.preventDefault();
          list[to]?.focus();
        }}
        className={cx(
          // Solid: it opens inside the glass sheet, and glass inside glass can't see the page.
          "absolute -left-2 z-20 max-h-80 w-56 overflow-y-auto overscroll-contain rounded-menu bg-overlay p-1 shadow-overlay",
          up ? "bottom-full mb-1 origin-bottom-left" : "top-full mt-1 origin-top-left",
          "invisible scale-95 opacity-0 transition-[opacity,scale,visibility] duration-100 ease-in",
          // Visible at once on open (only the fade and scale animate), or focus can't move in.
          "data-open:visible data-open:scale-100 data-open:opacity-100 data-open:transition-[opacity,scale] data-open:duration-200 data-open:ease-snappy",
        )}
      >
        {all.map((c) => {
          const selected = c.value === value;
          return (
            <button
              key={c.value}
              role="menuitemradio"
              aria-checked={selected}
              tabIndex={open ? 0 : -1}
              onClick={() => {
                onChange(c.value);
                close();
              }}
              className="flex h-9 w-full items-center gap-2 rounded-control px-2 text-left text-body pointer-coarse:h-11 hover:bg-white/8 focus-visible:bg-white/8"
            >
              <span className="grid size-4 shrink-0 place-items-center text-accent">
                {selected && <CheckIcon weight="bold" />}
              </span>
              <span className={cx("min-w-0 flex-1 truncate", selected ? "text-fg" : "text-fg-muted")}>{c.label}</span>
              {c.count !== undefined && <span className="shrink-0 text-caption text-fg-faint tabular-nums">{c.count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
