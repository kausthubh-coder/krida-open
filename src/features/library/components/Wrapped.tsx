import { useEffect, useRef, useState } from "react";
import { useModalMark } from "../../../ui/modal";
import { ArrowDownIcon, DownloadSimpleIcon, XIcon } from "@phosphor-icons/react";
import { toast } from "../../../ui/toast";
import type { Stats } from "../../../../convex/lib/statsShape";
import { art } from "../../../data/cinemeta";
import { hoursLabel } from "../filters";
import { Art } from "../../../ui/artwork";
import { Button, cx, EmptyState, IconButton } from "../../../ui/ui";
import { plural } from "../../../ui/format";
import { KindBar } from "./Stats";

/** A scrollable retrospective. Nothing advances on a timer, and every chapter has a real record behind it. */
export function Wrapped({ stats, name, computing, onClose, onRefresh }: {
  stats?: Stats; name: string; computing?: boolean; onClose: () => void; onRefresh: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
  useModalMark(true);
  useEffect(() => {
    const el = ref.current;
    const trigger = document.activeElement as HTMLElement | null;
    el?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { el?.close(); document.body.style.overflow = overflow; trigger?.focus(); };
  }, []);
  const all = stats?.periods[0];
  const enough = !!all && (all.minutes > 0 || (stats?.coverage.titles ?? 0) > 0);
  const top = all?.top[0];
  const save = async () => {
    if (!stats || !all || saving) return;
    setSaving(true);
    try {
      await document.fonts.ready;
      const canvas = document.createElement("canvas");
      canvas.width = 1080; canvas.height = 1350;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      // Opaque export colors match the dark theme; no remote art or account identifiers enter the card.
      ctx.fillStyle = "#191916"; ctx.fillRect(0, 0, 1080, 1350);
      ctx.fillStyle = "#bdbbb3"; ctx.font = '500 28px "Inter Variable", sans-serif'; ctx.fillText("KRIDA / WRAPPED", 80, 110);
      const wrap = (text: string, y: number, font: string, line = 72) => {
        ctx.font = font;
        let row = "";
        for (const word of text.split(/\s+/)) {
          const next = row ? `${row} ${word}` : word;
          if (ctx.measureText(next).width > 920 && row) { ctx.fillText(row, 80, y); y += line; row = word; } else row = next;
        }
        ctx.fillText(row, 80, y); return y + line;
      };
      ctx.fillStyle = "#f4f2eb";
      wrap(`${name.slice(0, 40)}'s watch story`, 215, '500 52px "Inter Variable", sans-serif', 62);
      wrap(stats.persona.name, 415, '650 84px "Inter Variable", sans-serif', 96);
      ctx.fillStyle = "#bdbbb3";
      wrap(stats.persona.line, 650, '400 32px "Inter Variable", sans-serif', 48);
      ctx.fillStyle = "#f4f2eb";
      ctx.font = '600 92px "Inter Variable", sans-serif'; ctx.fillText(Math.round(all.minutes / 60).toLocaleString(), 80, 925);
      ctx.font = '400 30px "Inter Variable", sans-serif'; ctx.fillText("estimated hours · all time", 80, 980);
      ctx.font = '400 28px "Inter Variable", sans-serif'; ctx.fillText(`${all.episodes.toLocaleString()} episodes · ${all.movies.toLocaleString()} movies`, 80, 1080);
      ctx.fillStyle = "#bdbbb3"; ctx.font = '400 23px "Inter Variable", sans-serif';
      ctx.fillText("Based on recorded history. Includes runtime estimates.", 80, 1210);
      ctx.fillText("Repeat viewings are not counted separately.", 80, 1250);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("Couldn't create image")), "image/png"));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "krida-wrapped.png"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch { toast.error("Couldn't save your card. Try again."); }
    finally { setSaving(false); }
  };
  // The posters behind the cover: what you watched most, then what Krida noticed, repeated to fill the wall.
  const wall = (() => {
    if (!stats || !all) return [];
    const refs = [...all.top, ...stats.insights.flatMap((i) => (i.ref ? [i.ref] : [])), ...(stats.friend?.ask ?? [])];
    const urls = [...new Set(refs.flatMap((r) => r.poster ?? art.poster(r.id) ?? []))];
    return urls.length ? Array.from({ length: 24 }, (_, i) => urls[i % urls.length]) : [];
  })();
  const chapter = "relative isolate flex min-h-dvh snap-start flex-col justify-center overflow-hidden px-6 py-24 md:px-16";
  const eyebrow = "text-caption font-semibold tracking-[0.08em] text-fg-faint uppercase";
  return <dialog ref={ref} aria-labelledby="wrapped-title" onCancel={(e) => { e.preventDefault(); onClose(); }} className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none snap-y snap-proximity overflow-y-auto overscroll-contain bg-page p-0 text-fg backdrop:bg-page">
    <div className="fixed inset-x-0 top-0 z-20 flex items-center justify-between bg-linear-to-b from-page/90 to-transparent px-5 pt-3 pb-8 md:px-12"><span className="text-caption font-semibold tracking-[0.08em] text-fg-muted uppercase">Krida Wrapped · All time</span><IconButton label="Close Wrapped" onClick={onClose}><XIcon /></IconButton></div>
    {!stats || !enough ? <div className="mx-auto max-w-xl px-6 py-24"><h1 id="wrapped-title" className="sr-only">Your Wrapped</h1><EmptyState title={!stats ? computing ? "Finding your story…" : "Your Wrapped isn’t ready yet" : "A few watches make a story"}
      description={!stats ? "Krida is gathering your history and title details. Large libraries can take a few minutes." : "Finish something or connect Simkl to bring your history into Krida."}
      action={!stats && !computing ? <Button onClick={onRefresh}>Try again</Button> : <Button onClick={onClose}>Back to Library</Button>} /></div> : <>
      <section className={cx(chapter, "justify-end")}>
        {wall.length > 0 && <div aria-hidden className="absolute -inset-16 -z-20 grid rotate-[-4deg] grid-cols-4 gap-2 opacity-50 sm:grid-cols-6 lg:grid-cols-8">
          {wall.map((src, i) => <Art key={i} src={src} alt="" className="aspect-2/3 rounded-control" />)}
        </div>}
        <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-t from-page from-15% via-page/60 to-page/20" />
        <p className="text-caption font-semibold tracking-[0.08em] text-fg-muted uppercase">{name}’s Krida Wrapped</p>
        <h1 id="wrapped-title" className="mt-4 max-w-[14ch] font-display text-[clamp(3rem,8vw,5.5rem)] leading-[1.02] font-semibold tracking-[-0.035em] text-balance">
          <span className="tabular-nums">{Math.round(all!.minutes / 60).toLocaleString()}</span> hours in other worlds.</h1>
        <p className="mt-6 max-w-[44ch] text-title font-normal text-fg-muted">{[all!.episodes && plural(all!.episodes, "episode", "episodes"), all!.movies && plural(all!.movies, "movie", "movies")].filter(Boolean).join(" and ")}{all!.episodes || all!.movies ? ". " : ""}Scroll to see what stayed with you.</p>
        <ArrowDownIcon aria-hidden className="mt-10 text-2xl text-fg-faint" />
      </section>
      {top && <section className={chapter}>
        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 md:grid-cols-[1fr_280px]">
          <div><p className={eyebrow}>Your number one</p>
            <h2 className="mt-4 font-display text-[clamp(2.5rem,6vw,5rem)] leading-[1.05] font-semibold tracking-[-0.03em] text-balance">{top.name}</h2>
            <p className="mt-6 text-title font-normal text-fg-muted tabular-nums">{hoursLabel(top.minutes)}{top.episodes > 0 && `, ${plural(top.episodes, "episode", "episodes")}`}. More of your time than anything else.</p></div>
          <Art src={top.poster ?? art.poster(top.id)} alt={top.name} fallbackTitle={top.name} className="aspect-2/3 w-48 rounded-sheet img-outline shadow-overlay md:w-full" />
        </div>
      </section>}
      {all!.top.length > 1 && <section className={chapter}>
        <div className="mx-auto w-full max-w-6xl"><p className={eyebrow}>The rest of your top five</p>
          <ol className="mt-8 grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-4">{all!.top.slice(1, 5).map((t, i) => <li key={t.id} className="min-w-0">
            <Art src={t.poster ?? art.poster(t.id)} alt="" fallbackTitle={t.name} className="aspect-2/3 w-full rounded-card img-outline" />
            <p className="mt-3 truncate text-subhead font-semibold"><span className="mr-2 text-fg-faint tabular-nums">{i + 2}</span>{t.name}</p>
            <p className="text-body text-fg-faint tabular-nums">{hoursLabel(t.minutes)}</p>
          </li>)}</ol></div>
      </section>}
      <section className={chapter}>
        <div className="mx-auto w-full max-w-6xl"><p className={eyebrow}>Where your time went</p>
          {all!.animeShare >= 0.3 ? <h2 className="mt-4 font-display text-[clamp(3rem,8vw,5.5rem)] leading-none font-semibold tracking-[-0.035em]"><span className="tabular-nums">{Math.round(all!.animeShare * 100)}%</span> anime.</h2>
            : <h2 className="mt-4 font-display text-[clamp(2.5rem,6vw,4.5rem)] leading-[1.05] font-semibold tracking-[-0.03em]">{all!.genres[0] ? `Mostly ${all!.genres[0].name.toLowerCase()}.` : "A bit of everything."}</h2>}
          {stats.finish.animeStarted + stats.finish.showsStarted > 0 && <p className="mt-6 max-w-[44ch] text-title font-normal text-fg-muted">
            You finished {stats.finish.animeFinished + stats.finish.showsFinished} of the {stats.finish.animeStarted + stats.finish.showsStarted} series you settled on.</p>}
          <KindBar period={all!} className="mt-10 max-w-3xl" />
        </div>
      </section>
      {stats.insights.filter((i) => i.ref).slice(0, 2).map((insight) => <section key={insight.key} className={chapter}>
        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 md:grid-cols-[1fr_220px]">
          <div><p className={eyebrow}>Something Krida noticed</p>
            <h2 className="mt-4 max-w-[20ch] font-display text-[clamp(2rem,5vw,3.5rem)] leading-[1.1] font-semibold tracking-[-0.025em] text-balance">{insight.title}</h2>
            {insight.detail && <p className="mt-6 max-w-[44ch] text-title font-normal text-fg-muted">{insight.detail}</p>}</div>
          <Art src={insight.ref!.poster ?? art.poster(insight.ref!.id)} alt="" fallbackTitle={insight.ref!.name} className="aspect-2/3 w-40 rounded-card img-outline md:w-full" />
        </div>
      </section>)}
      <section className={cx(chapter, "items-center text-center")}>
        <div className="relative isolate aspect-4/5 w-full max-w-sm overflow-hidden rounded-sheet bg-surface text-left shadow-overlay">
          {wall.length > 0 && <div aria-hidden className="absolute -inset-8 -z-10 grid rotate-[-4deg] grid-cols-5 gap-1.5 opacity-45">
            {wall.slice(0, 20).map((src, i) => <Art key={i} src={src} alt="" className="aspect-2/3 rounded-[6px]" />)}</div>}
          <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-surface from-55% to-transparent p-6 pt-20">
            <p className={eyebrow}>Your viewing persona</p>
            <h2 className="mt-2 font-display text-[2.5rem] leading-[1.1] font-semibold tracking-[-0.03em]">{stats.persona.name}</h2>
            <p className="mt-2 text-body text-fg-muted">{[...stats.persona.tags, `${Math.round(all!.minutes / 60).toLocaleString()} hours`].join(" · ")}</p>
          </div>
        </div>
        <p className="mt-6 max-w-[44ch] text-body text-fg-muted">{stats.persona.line}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3"><Button variant="primary" icon={<DownloadSimpleIcon />} onClick={() => void save()} loading={saving}>Save your card</Button><Button variant="ghost" onClick={onClose}>Back to Library</Button></div>
        <p className="mt-4 text-caption text-fg-faint">Downloads a picture with your name and these stats. Nothing is posted.</p>
      </section>
    </>}
  </dialog>;
}
