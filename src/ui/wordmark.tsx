export function Wordmark({ className }: { className?: string }) {
  return (
    // No ui.tsx here: the landing page draws this without loading bubli.
    <span className={["inline-flex items-center gap-[0.3em] font-[650] tracking-[-0.035em] text-fg", className].filter(Boolean).join(" ")}>
      {/* Two plays, one a step behind: watching together. Same shapes as public/favicon.svg. */}
      <svg aria-hidden viewBox="12 17 38 30" className="h-[0.78em] w-auto flex-none">
        <g fill="currentColor" stroke="currentColor" strokeWidth="5" strokeLinejoin="round">
          <polygon points="15,20 35,32 15,44" opacity=".32" />
          <polygon points="27,20 47,32 27,44" />
        </g>
      </svg>
      krida
    </span>
  );
}
