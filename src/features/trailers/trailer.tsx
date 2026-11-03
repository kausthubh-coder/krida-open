import { useEffect, useRef, useState, type ReactNode } from "react";
import { useModalMark } from "../../ui/modal";
import { ArrowUpRightIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { loadYouTube, youtubeError } from "./youtube";
import { Art } from "../../ui/artwork";
import { ButtonLink, IconButton, Spinner } from "../../ui/ui";

/**
 * A title's trailer, full screen over the page. It plays for this viewer only, even in a party, and
 * never touches watch history. `action` (Play) sits under the video so the next step is one press away.
 */
export function TrailerDialog({
  open,
  onClose,
  name,
  ids,
  backdrop,
  action,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  /** YouTube ids, best first. */
  ids: string[];
  backdrop?: string;
  action: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setShown(false);
    const t = setTimeout(() => {
      ref.current?.close();
      setMounted(false);
    }, 120);
    return () => clearTimeout(t);
  }, [open]);

  useModalMark(mounted);
  useEffect(() => {
    const el = ref.current;
    if (!mounted || !open || !el) return;
    if (!el.open) el.showModal();
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [mounted, open]);

  if (!mounted) return null;

  return (
    <dialog
      ref={ref}
      aria-label={`${name} trailer`}
      data-shown={shown || undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={
        // Nearly opaque instead of blurred: a blur here would redraw under the playing video every frame. Opaque
        // enough that the page's own words don't show through under the trailer's.
        "group fixed inset-0 m-0 flex h-dvh max-h-none w-full max-w-none flex-col bg-black/97 p-0 text-fg backdrop:bg-transparent " +
        "opacity-0 transition-opacity duration-120 ease-in data-shown:opacity-100 data-shown:duration-240 data-shown:ease-snappy"
      }
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 pr-2 pl-4 md:h-16 md:pr-6 md:pl-12">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-subhead font-semibold">{name}</span>
          <span className="shrink-0 text-body text-fg-faint">Trailer</span>
        </p>
        <IconButton label="Close trailer" onClick={onClose} className="size-11 bg-white/8">
          <XIcon />
        </IconButton>
      </header>
      {/* The dark space around the video closes it, like a click outside any preview. */}
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center pb-8 md:px-12 md:pb-6"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div
          className={
            "flex w-full flex-col gap-5 md:w-[min(100%,calc((100dvh-11rem)*16/9))] md:gap-4 " +
            "scale-[0.96] transition-[scale] duration-240 ease-snappy group-data-shown:scale-100 motion-reduce:scale-100"
          }
        >
          <TrailerPlayer key={ids.join()} ids={ids} name={name} backdrop={backdrop} />
          <div className="flex flex-col items-stretch gap-2 px-4 md:flex-row md:items-center md:gap-4 md:px-0">{action}</div>
        </div>
      </div>
    </dialog>
  );
}

/**
 * YouTube's own player with its controls. If YouTube refuses a trailer (removed, or not allowed
 * outside YouTube), the next one is tried before anything is shown as an error.
 */
function TrailerPlayer({ ids, name, backdrop }: { ids: string[]; name: string; backdrop?: string }) {
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | { error: number }>("loading");
  const frame = useRef<HTMLIFrameElement>(null);
  const id = ids[index];

  useEffect(() => {
    let alive = true;
    loadYouTube().then(
      (YT) => {
        if (!alive || !frame.current) return;
        new YT.Player(frame.current, {
          events: {
            onError: ({ data }) => {
              if (!alive) return;
              if (index + 1 < ids.length) {
                setIndex(index + 1);
                setStatus("loading");
              } else setStatus({ error: data });
            },
          },
        });
      },
      // Without the API the trailer still plays; only falling back to another one is lost.
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [index, ids.length]);

  const origin = encodeURIComponent(location.origin);
  return (
    <div className="relative isolate aspect-video w-full overflow-hidden bg-black md:rounded-card md:shadow-overlay">
      {typeof status !== "object" && (
        <iframe
          key={id}
          ref={frame}
          title={`${name} trailer`}
          src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1&rel=0&enablejsapi=1&origin=${origin}`}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          // The site sends no referrer at all, and YouTube refuses to play embeds that don't say where they are.
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={() => setStatus((s) => (s === "loading" ? "ready" : s))}
          className={`absolute inset-0 size-full border-0 ${status === "ready" ? "" : "opacity-0"}`}
        />
      )}
      {status !== "ready" && (
        <Art src={backdrop} alt="" className="absolute inset-0 -z-10 bg-black" imgClassName="brightness-[0.35] saturate-[0.8]" />
      )}
      {status === "loading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-body text-fg-muted">
          <Spinner />
          Loading trailer…
        </div>
      )}
      {typeof status === "object" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <WarningCircleIcon className="text-[28px] text-fg-muted" />
          <div>
            <p className="text-subhead font-semibold">This trailer won’t play here</p>
            <p className="text-body text-fg-muted">{youtubeError(status.error)}</p>
          </div>
          <ButtonLink
            to={`https://www.youtube.com/watch?v=${id}`}
            target="_blank"
            rel="noreferrer"
            className="mt-1"
          >
            <span className="inline-flex items-center gap-2">
              <span className="-mb-px inline-flex text-[1.15em]">
                <ArrowUpRightIcon />
              </span>
              Watch on YouTube
            </span>
          </ButtonLink>
        </div>
      )}
    </div>
  );
}
