// Settings → Home: which rows show, in what order, under what names, and which one the banner draws from.
import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, CaretDownIcon, EyeIcon, EyeSlashIcon, PushPinIcon } from "@phosphor-icons/react";
import { useAuthed } from "../../data/session";
import { useUpdateProfile } from "../../data/profile";
import type { PrefsPatch } from "../../../convex/lib/prefs";
import { Button, cx, IconButton, Spinner } from "../../ui/ui";
import { allRowsInOrder, rowTitle, useHome } from "../home";
import { Switch } from "./settingsParts";
import { inputClass, Select } from "../../ui/select";

type EditableRow = { key: string; title: string; type?: string; from?: string };

/** Every row this profile could see, with where it comes from. */
function useEditableRows(): EditableRow[] | undefined {
  const { token } = useAuthed();
  const home = useHome(token);
  if (!home) return undefined;
  return [
    { key: "continue", title: "Continue watching" },
    { key: "mylist", title: "Plan to watch" },
    ...home.rows.map((r) => ({ key: r.key, title: r.title })),
    ...home.addonRows.map((r) => ({ key: r.key, title: r.title, type: r.type, from: r.addon })),
    ...home.friends.map((r) => ({ key: r.key, title: r.title })),
  ];
}

/** The banner and the release filter, above the list of rows. */
export function HomeDisplay() {
  const { token, me } = useAuthed();
  const update = useUpdateProfile();
  const rows = useEditableRows();
  const names = me.prefs.rowNames ?? [];
  const choices = (rows ?? []).filter((r) => r.key !== "continue");
  return (
    <>
      <Switch
        label="Hide titles that aren’t out yet"
        hint="Leaves next year’s films and shows off every row."
        checked={!!me.prefs.hideUnreleased}
        onChange={(hideUnreleased) => void update({ token, prefsPatch: { hideUnreleased } })}
      />
      <div className="flex min-h-12 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <span className="min-w-0 flex-1">
          <label htmlFor="hero-row" className="block text-body font-medium">
            Banner
          </label>
          <span className="block text-body text-fg-faint">What the big picture at the top of Home shows, after where you left off.</span>
        </span>
        <span className="sm:w-64">
          <Select
            id="hero-row"
            value={me.prefs.heroRow ?? ""}
            onChange={(v) => void update({ token, prefsPatch: { heroRow: v || null } })}
            options={[
              { value: "", label: "Your picks and the Top 10" },
              ...choices.map((r) => ({ value: r.key, label: rowTitle(r, names, me.prefs.typeHiddenRows) })),
            ]}
          />
        </span>
      </div>
    </>
  );
}

/** One row's line: pin, move, hide, and (opened) its name and whether it says what kind it is. */
function RowLine({
  row,
  title,
  index,
  count,
  canUp,
  canDown,
  onMove,
}: {
  row: EditableRow;
  title: string;
  index: number;
  count: number;
  canUp: boolean;
  canDown: boolean;
  onMove: (by: number) => void;
}) {
  const { token, me } = useAuthed();
  const update = useUpdateProfile();
  const [open, setOpen] = useState(false);
  const names = me.prefs.rowNames ?? [];
  const own = names.find((n) => n.key === row.key)?.name ?? "";
  const [name, setName] = useState(own);
  const hidden = (me.prefs.hiddenRows ?? []).includes(row.key);
  const pinned = (me.prefs.pinnedRows ?? []).includes(row.key);
  const typeHidden = me.prefs.typeHiddenRows ?? [];
  const save = (patch: PrefsPatch) => void update({ token, prefsPatch: patch });
  const toggle = (list: string[], on: boolean) => (on ? [...list.filter((k) => k !== row.key), row.key] : list.filter((k) => k !== row.key));
  const rename = (value: string) => {
    const others = names.filter((n) => n.key !== row.key);
    save({ rowNames: value.trim() ? [...others, { key: row.key, name: value.trim().slice(0, 60) }] : others });
  };

  return (
    <li className="flex flex-col rounded-control hover:bg-white/4">
      <div className="flex min-h-12 items-center gap-1 px-2">
        <span className="min-w-0 flex-1">
          <span className={cx("block truncate text-body", hidden ? "text-fg-faint line-through decoration-fg-faint/60" : "text-fg")}>{title}</span>
          {(row.from || pinned) && (
            <span className="block truncate text-caption text-fg-faint">
              {[pinned && "Pinned to the top", row.from && `From ${row.from}`].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
        <IconButton size="sm" label={pinned ? `Unpin ${title}` : `Pin ${title} to the top`} aria-pressed={pinned} onClick={() => save({ pinnedRows: toggle(me.prefs.pinnedRows ?? [], !pinned) })}>
          <PushPinIcon weight={pinned ? "fill" : "regular"} />
        </IconButton>
        <IconButton size="sm" label={`Move ${title} up`} disabled={!canUp || index === 0} onClick={() => onMove(-1)}>
          <ArrowUpIcon />
        </IconButton>
        <IconButton size="sm" label={`Move ${title} down`} disabled={!canDown || index === count - 1} onClick={() => onMove(1)}>
          <ArrowDownIcon />
        </IconButton>
        <IconButton size="sm" label={hidden ? `Show ${title}` : `Hide ${title}`} aria-pressed={hidden} onClick={() => save({ hiddenRows: toggle(me.prefs.hiddenRows ?? [], !hidden) })}>
          {hidden ? <EyeSlashIcon /> : <EyeIcon />}
        </IconButton>
        <IconButton size="sm" label={`${open ? "Close" : "Rename or change"} ${title}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          <CaretDownIcon className={cx("transition-transform duration-150", open && "rotate-180")} />
        </IconButton>
      </div>
      {open && (
        <div className="flex flex-col gap-3 px-2 pt-1 pb-4">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              rename(name);
            }}
          >
            <label htmlFor={`name-${row.key}`} className="sr-only">
              Name for {title}
            </label>
            <input
              id={`name-${row.key}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={row.title}
              maxLength={60}
              autoComplete="off"
              className={inputClass}
            />
            <span className="flex shrink-0 gap-2">
              <Button type="submit" className="h-11" disabled={name.trim() === own}>
                Rename
              </Button>
              {own && (
                <Button
                  variant="ghost"
                  className="h-11"
                  onClick={() => {
                    setName("");
                    rename("");
                  }}
                >
                  Use its own name
                </Button>
              )}
            </span>
          </form>
          {row.type && (
            <Switch
              label="Say what kind it is"
              hint={`Shows “${rowTitle({ ...row, title: own || row.title }, [], [])}” rather than just its name.`}
              checked={!typeHidden.includes(row.key)}
              onChange={(on) => save({ typeHiddenRows: toggle(typeHidden, !on) })}
            />
          )}
        </div>
      )}
    </li>
  );
}

/** Which rows Home shows for this profile, in what order and under what names. */
export function HomeRows() {
  const { token, me } = useAuthed();
  const update = useUpdateProfile();
  const editable = useEditableRows();
  const [all, setAll] = useState(false);
  if (!editable)
    return (
      <div className="grid h-24 place-items-center">
        <Spinner className="text-fg-faint" />
      </div>
    );
  const prefs = me.prefs;
  const pinned = prefs.pinnedRows ?? [];
  const rows = allRowsInOrder(editable, { order: prefs.rowOrder ?? [], pinned });
  const save = (patch: PrefsPatch) => void update({ token, prefsPatch: patch });
  // Pinned rows move among themselves; the rest keep the profile's order.
  const move = (i: number, by: number) => {
    const keys = rows.map((r) => r.key);
    const [k] = keys.splice(i, 1);
    keys.splice(i + by, 0, k);
    if (pinned.includes(k)) save({ pinnedRows: keys.filter((x) => pinned.includes(x)) });
    else save({ rowOrder: keys.filter((x) => !pinned.includes(x)) });
  };
  const FOLD = 8;
  const visible = all ? rows : rows.slice(0, FOLD);
  const changed = [prefs.hiddenRows, prefs.rowOrder, prefs.pinnedRows, prefs.rowNames, prefs.typeHiddenRows].some((x) => x?.length);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body text-fg-muted">
        Your addons’ catalogs sit here with Krida’s own rows. Picks and “Because you watched” update as you watch; new rows appear at the end.
      </p>
      <ul className="-mx-2 flex flex-col">
        {visible.map((r, i) => {
          const isPinned = pinned.includes(r.key);
          const next = rows[i + 1];
          const prev = rows[i - 1];
          return (
            <RowLine
              key={r.key}
              row={r}
              title={rowTitle(r, prefs.rowNames, prefs.typeHiddenRows)}
              index={i}
              count={rows.length}
              canUp={!!prev && pinned.includes(prev.key) === isPinned}
              canDown={!!next && pinned.includes(next.key) === isPinned}
              onMove={(by) => move(i, by)}
            />
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        {rows.length > FOLD && (
          <Button variant="ghost" className="-ml-3" onClick={() => setAll((a) => !a)}>
            {all ? "Show fewer" : `Show all ${rows.length} rows`}
          </Button>
        )}
        {changed && (
          <Button
            variant="ghost"
            className={cx(rows.length <= FOLD && "-ml-3")}
            onClick={() => save({ hiddenRows: [], rowOrder: [], pinnedRows: [], rowNames: [], typeHiddenRows: [] })}
          >
            Reset to the default rows
          </Button>
        )}
      </div>
    </div>
  );
}
