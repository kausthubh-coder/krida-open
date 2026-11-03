import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Stats } from "../../../../convex/lib/statsShape";
import { monthName } from "../filters";
import { cx } from "../../../ui/ui";

type Period = Stats["periods"][number];
const SERIES = [
  { key: "anime", label: "Anime", color: "var(--color-anime)" },
  { key: "show", label: "Shows", color: "var(--color-show)" },
  { key: "movie", label: "Movies", color: "var(--color-movie)" },
] as const;

/** Charts are drawn at their real width so text never stretches. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function Legend({ only }: { only?: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-fg-faint">
      {SERIES.filter((s) => !only || only.includes(s.key)).map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5"><i className="size-2 rounded-[2px]" style={{ background: s.color }} />{s.label}</span>
      ))}
    </div>
  );
}

function Tip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(8, x - 80), width - 168);
  // Solid: the chart behind is flat, and glass that follows the pointer would blur again on every move.
  return (
    <div role="status" className="pointer-events-none absolute z-10 w-40 rounded-control bg-overlay px-3 py-2 text-caption shadow-overlay" style={{ left, top: Math.max(0, y - 8), transform: "translateY(-100%)" }}>
      {children}
    </div>
  );
}

const hrs = (m: number) => (m >= 600 ? `${Math.round(m / 60)} h` : m >= 60 ? `${Math.round(m / 6) / 10} h` : `${Math.round(m)} min`);

/** Hours per month, stacked by kind. Bulk-logged history gets one "Before" column instead of a fake spike. */
export function HoursByMonth({ period, height = 220 }: { period: Period; height?: number }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const months = period.months;
  const bulk = period.bulkMinutes;
  const lead = bulk > 0 ? 76 : 0;
  const axis = 40, top = 12, bottom = 36;
  const plot = height - top - bottom;
  const max = Math.max(60, ...months.map((m) => m.anime + m.show + m.movie));
  const step = [60, 300, 600, 1200, 3000, 6000, 12000].find((s) => max / s <= 4) ?? 24000;
  const ceil = Math.ceil(max / step) * step;
  const y = (m: number) => (m / ceil) * plot;
  const bw = width ? (width - axis - lead) / Math.max(1, months.length) : 0;
  const total = months.reduce((a, m) => a + m.anime + m.show + m.movie, 0);
  return (
    <div ref={ref} className="relative" style={{ height }}>
      {width > 0 && <svg width={width} height={height} role="img" aria-label={`Hours watched by month. ${hrs(total)} across the months shown${bulk ? `, plus ${hrs(bulk)} logged in bulk` : ""}.`}>
        {Array.from({ length: ceil / step + 1 }, (_, i) => i * step).map((g) => (
          <g key={g}>
            <line x1={axis} x2={width} y1={top + plot - y(g)} y2={top + plot - y(g)} stroke="oklch(1 0 0 / 0.06)" />
            <text x={axis - 8} y={top + plot - y(g) + 4} textAnchor="end" className="fill-fg-faint text-caption tabular-nums">{Math.round(g / 60)} h</text>
          </g>
        ))}
        {bulk > 0 && <g>
          <rect x={axis + 6} y={top} width={lead - 22} height={plot} rx={6} fill="oklch(1 0 0 / 0.05)" />
          <text x={axis + 6 + (lead - 22) / 2} y={top + 20} textAnchor="middle" className="fill-fg text-[12px] font-semibold">Before</text>
          <text x={axis + 6 + (lead - 22) / 2} y={top + 36} textAnchor="middle" className="fill-fg-faint text-caption tabular-nums">{hrs(bulk)}</text>
          <text x={axis + 6 + (lead - 22) / 2} y={top + 50} textAnchor="middle" className="fill-fg-faint text-caption">logged</text>
          <text x={axis + 6 + (lead - 22) / 2} y={top + 64} textAnchor="middle" className="fill-fg-faint text-caption">at once</text>
        </g>}
        {months.map((m, i) => {
          const x = axis + lead + i * bw + 2, w = Math.max(2, bw - 4);
          let acc = 0;
          const parts = SERIES.map((s) => ({ ...s, v: m[s.key] })).filter((p) => p.v > 0);
          const [yy, mm] = m.month.split("-").map(Number);
          return (
            <g key={m.month} opacity={hover === null || hover === i ? 1 : 0.4}>
              {parts.length === 0 && <rect x={x} y={top + plot - 2} width={w} height={2} rx={1} fill="oklch(1 0 0 / 0.12)" />}
              {parts.map((p, j) => {
                const h = y(p.v);
                const r = <rect key={p.key} x={x} y={top + plot - acc - h} width={w} height={Math.max(1, h - 2)} rx={j === parts.length - 1 ? 3 : 1} fill={p.color} />;
                acc += h;
                return r;
              })}
              {(i % (width < 500 ? 6 : 3) === 0 || i === months.length - 1) && <text x={x + w / 2} y={height - 20} textAnchor="middle" className="fill-fg-faint text-caption">{monthName(mm - 1).slice(0, 3)}</text>}
              {(mm === 1 || i === 0) && <text x={x} y={height - 4} className="fill-fg-muted text-caption font-semibold">{yy}</text>}
              <rect x={x - 2} y={top} width={bw} height={plot} fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
            </g>
          );
        })}
      </svg>}
      {hover !== null && width > 0 && (() => {
        const m = months[hover];
        const [yy, mm] = m.month.split("-").map(Number);
        return <Tip x={axis + lead + hover * bw + bw / 2} y={top + plot - y(m.anime + m.show + m.movie)} width={width}>
          <p className="font-medium text-fg">{monthName(mm - 1)} {yy}</p>
          {SERIES.map((s) => <p key={s.key} className="flex justify-between text-fg-muted"><span>{s.label}</span><span className="tabular-nums">{hrs(m[s.key])}</span></p>)}
        </Tip>;
      })()}
    </div>
  );
}

/** How you score, 1 to 10. Your most common score is the one drawn in white. */
export function ScoreHistogram({ hist, height = 150 }: { hist: number[]; height?: number }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...hist);
  const mode = hist.indexOf(max);
  const plot = height - 40, bw = width / 10;
  return (
    <div ref={ref} className="relative" style={{ height }}>
      {width > 0 && <svg width={width} height={height} role="img" aria-label={`Your scores: ${hist.map((n, i) => `${n} scored ${i + 1}`).join(", ")}.`}>
        {hist.map((n, i) => {
          const h = Math.max(2, (n / max) * plot);
          return <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <rect x={i * bw + 4} y={18 + plot - h} width={bw - 8} height={h} rx={3} fill={i === mode ? "var(--color-fg)" : "oklch(1 0 0 / 0.22)"} opacity={hover === null || hover === i ? 1 : 0.5} />
            {(i === mode || hover === i) && <text x={(i + 0.5) * bw} y={12 + plot - h} textAnchor="middle" className="fill-fg text-[12px] font-semibold tabular-nums">{n}</text>}
            <text x={(i + 0.5) * bw} y={height - 6} textAnchor="middle" className="fill-fg-faint text-caption tabular-nums">{i + 1}</text>
            <rect x={i * bw} y={0} width={bw} height={height} fill="transparent" />
          </g>;
        })}
      </svg>}
    </div>
  );
}

/** A thin bar for a share, with its label and number. */
export function ShareBar({ label, value, max, suffix = "" }: { label: string; value: number; max: number; suffix?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 truncate text-body text-fg-muted">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/6">
        <div className={cx("h-full rounded-full bg-white/30")} style={{ width: `${Math.max(1, (value / Math.max(1, max)) * 100)}%` }} />
      </div>
      <span className="w-12 shrink-0 text-right text-body font-medium tabular-nums">{value.toLocaleString()}{suffix}</span>
    </div>
  );
}
