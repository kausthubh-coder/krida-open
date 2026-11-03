// The party's menu (copy the link, back to picking, leave) and the small menu it's built from.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import {
  ChatTextIcon,
  CheckIcon,
  DotsThreeIcon,
  LinkIcon,
  SignOutIcon,
  SquaresFourIcon,
} from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { toast } from "../../ui/toast";
import { errorMessage } from "../play";
import { useAuthed } from "../../data/session";
import { playAdd } from "../../ui/sound";
import { Sheet } from "../../ui/sheet";
import { Button, cx, IconButton } from "../../ui/ui";
import { mediaLabel, ONLINE_MS, serverNow, type RoomData } from "./shared";
import { names } from "./presence";
import { HEADER_ICON } from "./panels";
import { useChatOverlayPref } from "./chat";


/**
 * A menu that drops down from its button: focus moves in, arrows move between the options, and Escape, Tab or a
 * click outside closes it. Solid, since it opens inside the panel's glass.
 */
function Menu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])];
  // Choosing something hands focus back to the button, since the option it was on disappears.
  useLayoutEffect(() => {
    if (!open && menu.current?.contains(document.activeElement)) trigger.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    // Capture first, so Escape closes the menu without also closing the panel underneath.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <div
      ref={root}
      className="relative"
      onBlur={(e) => {
        // Only when focus went somewhere: Safari and Firefox on macOS don't focus a clicked button, so a click
        // inside blurs to nothing, and clicks outside are already handled on pointerdown.
        if (open && e.relatedTarget && !root.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <IconButton
        ref={trigger}
        label={label}
        size="sm"
        className={cx(HEADER_ICON, open && "fill-raised bg-white/10 text-fg")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <DotsThreeIcon weight="bold" />
      </IconButton>
      <div
        ref={menu}
        role="menu"
        aria-label={label}
        data-open={open || undefined}
        onKeyDown={(e) => {
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
          "absolute top-full right-0 z-10 mt-2 w-60 origin-top-right rounded-menu bg-overlay p-1 shadow-overlay",
          "invisible scale-95 opacity-0 transition-[opacity,scale,visibility] duration-100 ease-in",
          // Visible at once on open (only the fade and scale animate), or focus can't move in.
          "data-open:visible data-open:scale-100 data-open:opacity-100 data-open:transition-[opacity,scale] data-open:duration-200 data-open:ease-snappy",
        )}
      >
        {children(() => setOpen(false))}
      </div>
    </div>
  );
}

function MenuItem({
  icon,
  children,
  onClick,
  danger,
  checked,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  checked?: boolean;
}) {
  return (
    <button
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      onClick={onClick}
      className={cx(
        "flex h-10 w-full items-center gap-3 rounded-control px-3 text-left text-body text-fg-muted pointer-coarse:h-11",
        "hover:bg-white/8 hover:text-fg focus-visible:bg-white/8 focus-visible:text-fg",
        danger && "hover:text-danger focus-visible:text-danger",
      )}
    >
      <span className="text-[18px]">{icon}</span>
      <span className="flex-1">{children}</span>
      {checked && <CheckIcon weight="bold" className="text-accent" />}
    </button>
  );
}

/** Back to picking, chat over video, leave: the things you do rarely. */
export function PartyMenu({ room, inPlayer }: { room: RoomData; inPlayer?: boolean }) {
  const { token } = useAuthed();
  const navigate = useNavigate();
  const leave = useMutation(api.rooms.leave);
  const stop = useMutation(api.rooms.stop);
  const [overlay, setOverlay] = useChatOverlayPref();
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const backToPicking = () => void stop({ token, roomId: room._id });
  return (
    <>
      <Menu label="More party options">
        {(close) => (
          <>
            {inPlayer && (
              <MenuItem icon={<ChatTextIcon />} checked={overlay} onClick={() => setOverlay(!overlay)}>
                Show chat over the video
              </MenuItem>
            )}
            {room.kind === "party" && room.status !== "idle" && (
              <MenuItem
                icon={<SquaresFourIcon />}
                onClick={() => {
                  close();
                  // It stops the film on every screen: one tap mustn't do that to someone watching.
                  const now = serverNow();
                  const watching = room.members.filter((m) => !m.isMe && m.watching && now - m.lastSeenAt < ONLINE_MS);
                  if (watching.length > 0) setConfirming(watching.map((m) => m.name));
                  else backToPicking();
                }}
              >
                Back to picking
              </MenuItem>
            )}
            {room.kind === "party" && (
              <>
                {(inPlayer || room.status !== "idle") && <div className="my-1 h-px bg-line" />}
                <MenuItem
                  icon={<SignOutIcon />}
                  danger
                  onClick={async () => {
                    close();
                    await leave({ token, roomId: room._id, announce: true });
                    if (inPlayer) navigate("/");
                  }}
                >
                  Leave party
                </MenuItem>
              </>
            )}
          </>
        )}
      </Menu>
      <Sheet
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        variant="center"
        title="Stop for everyone?"
        description={
          confirming &&
          `${names(confirming)} ${confirming.length > 1 ? "are" : "is"} watching${room.media ? ` ${mediaLabel(room.media)}` : ""}. It stops on every screen and you all pick something new.`
        }
      >
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" className="min-h-11" onClick={() => setConfirming(null)}>
            Keep watching
          </Button>
          <Button
            className="min-h-11"
            onClick={() => {
              setConfirming(null);
              backToPicking();
            }}
          >
            Back to picking
          </Button>
        </div>
      </Sheet>
    </>
  );
}

/**
 * The party's invite link (`/party#<code>`, rooms.shareLink): anyone signed in to Krida who opens it joins, from any
 * account, until the party ends. Guests can't share it.
 */
export function CopyLinkButton({ roomId }: { roomId: Id<"rooms"> }) {
  const { token, me } = useAuthed();
  const share = useMutation(api.rooms.shareLink);
  const [copied, setCopied] = useState(false);
  if (me.temporary) return null;
  return (
    <IconButton
      size="sm"
      className={HEADER_ICON}
      label={copied ? "Link copied" : "Copy invite link (anyone signed in who opens it joins)"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(`${location.origin}/party#${await share({ token, roomId })}`);
        } catch (e) {
          return toast.error(errorMessage(e, "Couldn't copy the link"));
        }
        playAdd();
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      <span className="relative grid size-[1em] place-items-center">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={copied ? "ok" : "link"}
            initial={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
            transition={{ type: "spring", duration: 0.3, bounce: 0 }}
            className="grid place-items-center"
          >
            {copied ? <CheckIcon weight="bold" className="text-accent" /> : <LinkIcon />}
          </motion.span>
        </AnimatePresence>
      </span>
    </IconButton>
  );
}
