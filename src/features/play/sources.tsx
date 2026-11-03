import { useEffect, useMemo, useRef, useState } from "react";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  FilmSlateIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { currentScreen } from "../../ui/screen";
import { useAuthed } from "../../data/session";
import { ago, episodeLabel, plural } from "../../ui/format";
import { errorMessage, type Media } from "./play";
import { Sheet } from "../../ui/sheet";
import { Button, cx, EmptyState, Segmented } from "../../ui/ui";
import { AudioMenu, Loading, PickCard, SortHeader, SourceRow } from "./sourceRows";
import { ANY, BEST, COLS, RES_ORDER, type Sort, compare, pickReason, realLanguages, resKey, resLabel } from "./sourceLabels";

type SourceList = FunctionReturnType<typeof api.sources.listRanked>;

export type SourceOption = SourceList["options"][number];

export type SourcesState = { key?: string; data?: SourceList; error?: string; loading: boolean };

/** `onPick` gets the file's list position and its key; send both, the position alone can point elsewhere once the
 * list is fetched again. */
type Pick = (index: number, key: string) => void;

/** What is playing: by key when the stream has one, else by list position (streams prepared before keys). */
type Current = { currentIndex?: number; currentKey?: string };

/** Handing one listed file to another player: its link, by its key, and the title to name it by. */
export type External = { title: string; link: (key: string) => Promise<string> };

export function SourcesSheet({
  media,
  onClose,
  onPick,
  currentIndex,
  currentKey,
}: {
  media: Media | null;
  onClose: () => void;
  onPick: Pick;
} & Current) {
  const { token } = useAuthed();
  const list = useAction(api.sources.listRanked);
  const fileLink = useAction(api.sources.fileLink);
  const [state, setState] = useState<SourcesState>({ loading: false });
  const key = media ? `${media.type}:${media.videoId}` : undefined;

  const load = (refresh = false) => {
    if (!media || !key) return;
    setState({ key, loading: true });
    list({
      token,
      type: media.type,
      videoId: media.videoId,
      name: media.name,
      season: media.season,
      episode: media.episode,
      refresh,
      screen: currentScreen(),
    }).then(
      (data) => setState({ key, data, loading: false }),
      (error) => setState({ key, error: errorMessage(error, "Couldn't load sources. Try again."), loading: false }),
    );
  };

  useEffect(() => {
    if (key) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const subtitle = media?.episodeTitle ? `${media.name} · ${episodeLabel(media.season, media.episode)}` : media?.name;
  const external: External | undefined = media
    ? { title: subtitle ?? media.name, link: async (key) => (await fileLink({ token, type: media.type, videoId: media.videoId, key })).url }
    : undefined;

  return (
    <Sheet
      open={!!media}
      onClose={onClose}
      scroll={false}
      title="Choose a source"
      description={<span className="block truncate">{subtitle}</span>}
      descriptionAction={
        state.data && (
          <button
            onClick={() => load(true)}
            className="relative inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-caption text-fg-faint after:absolute after:-inset-2.5 hover:bg-white/8 hover:text-fg"
          >
            <ArrowClockwiseIcon /> Refresh
          </button>
        )
      }
    >
      <SourcesPanel
        key={state.key}
        state={state}
        art={media?.background}
        currentIndex={currentIndex}
        currentKey={currentKey}
        onPick={onPick}
        onRetry={() => load(true)}
        external={external}
      />
    </Sheet>
  );
}

/** Everything inside the sheet, driven only by props. */
export function SourcesPanel({
  state,
  art,
  currentIndex,
  currentKey,
  onPick,
  onRetry,
  external,
}: {
  state: SourcesState;
  /** The title's backdrop, behind Krida's pick. */
  art?: string;
  onPick: Pick;
  onRetry: () => void;
  external?: External;
} & Current) {
  if (state.loading || (!state.data && !state.error)) return <Loading />;
  if (state.error) {
    return (
      <EmptyState
        className="flex-1 pb-28"
        icon={<WarningCircleIcon />}
        title="Couldn’t load sources"
        description={state.error}
        action={<Button onClick={onRetry}>Try again</Button>}
      />
    );
  }
  if (state.data!.options.length === 0) {
    return (
      <EmptyState
        className="flex-1 pb-28"
        icon={<FilmSlateIcon />}
        title="No sources found"
        description="Nothing cached on TorBox matches this yet. New releases can take a day to show up."
      />
    );
  }
  return (
    <SourceList data={state.data!} art={art} currentIndex={currentIndex} currentKey={currentKey} onPick={onPick} external={external} />
  );
}

function SourceList({
  data,
  art,
  currentIndex,
  currentKey,
  onPick,
  external,
}: {
  data: SourceList;
  art?: string;
  onPick: Pick;
  external?: External;
} & Current) {
  const { options } = data;
  const [res, setRes] = useState("all");
  const [audio, setAudio] = useState(ANY);
  const [sort, setSort] = useState<Sort>(BEST);
  const [open, setOpen] = useState<number | null>(null);
  const [showOdd, setShowOdd] = useState(false);
  // A tab picked at the clipped edge scrolls fully into view.
  const resTabs = useRef<HTMLDivElement>(null);
  useEffect(() => {
    resTabs.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }, [res]);

  const isCurrent = (o: SourceOption) =>
    currentKey !== undefined
      ? o.keys.includes(currentKey)
      : currentIndex !== undefined && o.indices.includes(currentIndex);
  const pick = options.find((o) => o.index === data.pick);

  const resolutions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of options) counts.set(resKey(o), (counts.get(resKey(o)) ?? 0) + 1);
    return [...RES_ORDER, "other"]
      .filter((r) => counts.has(r))
      .map((r) => ({ value: r, label: resLabel(r === "other" ? undefined : r), count: counts.get(r)! }));
  }, [options]);

  const audioChoices = useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of options) for (const l of new Set(realLanguages(o))) counts.set(l, (counts.get(l) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  }, [options]);

  const matches = options.filter(
    (o) =>
      (res === "all" || resKey(o) === res) &&
      (audio === ANY ||
        o.languages.includes(audio) ||
        (o.languages.includes("Dual Audio") && (audio === "English" || audio === "Japanese"))),
  );
  const sorted = [...matches].sort(compare(sort));
  const likely = sorted.filter((o) => !o.mismatch || isCurrent(o));
  const odd = sorted.filter((o) => o.mismatch && !isCurrent(o));

  const row = (o: SourceOption) => (
    <SourceRow
      key={o.index}
      option={o}
      current={isCurrent(o)}
      open={open === o.index}
      onToggle={() => setOpen(open === o.index ? null : o.index)}
      onPick={() => onPick(o.index, o.key)}
      external={external && { title: external.title, link: () => external.link(o.key) }}
      direct={data.direct}
    />
  );

  return (
    // The pick, the tabs and the column headers stay put; only the rows under them scroll. A sheet as short as a
    // phone held sideways has no room under them for a row, so there it all scrolls together.
    <div className="flex min-h-0 flex-1 flex-col low-sheet:-mx-6 low-sheet:overflow-y-auto low-sheet:overscroll-contain low-sheet:px-6 low-sheet:scroll-fade-y">
      {data.olderFrom !== undefined && (
        <p className="flex shrink-0 items-center gap-2 pb-3 text-caption text-fg-muted">
          <WarningCircleIcon className="shrink-0" size={16} />
          Your addons aren’t answering. Sources from {ago(data.olderFrom)}.
        </p>
      )}
      {pick && (
        <PickCard
          option={pick}
          art={art}
          reason={data.direct ? "The sharpest file this browser plays as it is." : pickReason(pick, options, currentScreen() === "app")}
          current={isCurrent(pick)}
          onPick={() => onPick(pick.index, pick.key)}
        />
      )}

      {resolutions.length > 1 && (
        <div ref={resTabs} className="flex shrink-0 flex-col pt-4">
          <Segmented
            label="Filter by resolution"
            value={res}
            onChange={setRes}
            // Scrolls under the pane's edge, where it fades, with the tabs on the content's edge.
            className="-mx-6 px-6 scroll-px-6"
            options={[{ value: "all", label: "All", count: options.length }, ...resolutions]}
          />
        </div>
      )}

      {/* On the rows' columns: the same padding, grid and caret slot. */}
      <div className={cx("-mx-2 flex shrink-0 pl-2", resolutions.length > 1 ? "mt-2" : "mt-4")}>
        <div className={cx(COLS, "min-w-0 flex-1 pr-3 narrow:pr-2")}>
          <SortHeader label="Quality" column="quality" sort={sort} onSort={setSort} className="justify-self-start" />
          <AudioMenu value={audio} onChange={setAudio} choices={audioChoices} />
          <SortHeader label="Speed" column="speed" sort={sort} onSort={setSort} className="justify-self-center" />
          <SortHeader label="Size" column="size" sort={sort} onSort={setSort} className="justify-self-end" />
        </div>
        <span className="w-8 shrink-0" />
      </div>

      <div className="-mx-6 min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 scroll-fade-y low-sheet:flex-none low-sheet:overflow-visible low-sheet:mask-none">
        {likely.length === 0 && odd.length === 0 ? (
          <EmptyState
            title="No files match"
            description={`Nothing here has ${[
              audio !== ANY && `${audio} audio`,
              res !== "all" && (res === "other" ? "without a listed resolution" : `in ${resLabel(res)}`),
            ]
              .filter(Boolean)
              .join(", ")}.`}
            action={
              <Button
                onClick={() => {
                  setAudio(ANY);
                  setRes("all");
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <>
            <ul className="source-list -mx-2 flex flex-col">{likely.map(row)}</ul>
            {odd.length > 0 && (
              <>
                <button
                  onClick={() => setShowOdd(!showOdd)}
                  aria-expanded={showOdd}
                  className="-mx-2 mt-2 flex h-10 items-center gap-2 rounded-control px-2 text-left text-caption text-fg-faint hover:bg-white/6 hover:text-fg"
                >
                  <CaretDownIcon className={cx("transition-transform duration-150 ease-out", showOdd && "rotate-180")} />
                  {showOdd ? "Hide" : "Show"} {plural(odd.length, "file", "files")} that look like another episode
                </button>
                {showOdd && <ul className="source-list -mx-2 flex flex-col">{odd.map(row)}</ul>}
              </>
            )}
            {audio !== ANY && (
              <p className="mt-4 text-caption text-fg-faint">
                {plural(matches.length, "file matches", "files match")} out of {options.length}.
              </p>
            )}
            {!!data.hidden && (
              <p className="mt-4 text-caption text-fg-faint">
                {plural(data.hidden, "listing", "listings")} hidden by “Hide sources containing” in Settings → Playback.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
