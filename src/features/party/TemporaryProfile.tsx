import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAuthed } from "../../data/session";
import { errorMessage } from "../play";
import { Sheet } from "../../ui/sheet";
import { Button } from "../../ui/ui";

export function TemporaryProfile({ roomId }: { roomId: Id<"rooms"> }) {
  const { token } = useAuthed();
  const create = useMutation(api.profiles.inviteTemporary);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);

  return (
    <>
      <Button variant="ghost" className="mt-2 min-h-11 self-start" onClick={() => {
        setName(""); setLink(""); setError(null); setCopied(false); setOpen(true);
      }}>Add temporary profile</Button>
      <Sheet open={open} onClose={() => setOpen(false)} variant="center" title="Add temporary profile"
        description="Send a friend a one-use join link. Their profile and link expire after 24 hours.">
        {link ? (
          <div className="flex flex-col gap-4">
            <p className="break-words text-body text-fg-muted">Send this link to {name.trim()} to join the party.</p>
            <label htmlFor="temporary-link" className="text-body font-medium">Join link</label>
            <input id="temporary-link" readOnly value={link} onFocus={(e) => e.target.select()}
              className="h-12 w-full rounded-control fill-quiet bg-white/8 px-4 text-body" />
            <Button className="min-h-11" onClick={() => void navigator.clipboard.writeText(link).then(() => {
              setCopied(true); setError(null);
            }).catch(() => setError("Couldn't copy. Select the link and copy it manually."))}>
              {copied ? "Copied" : "Copy join link"}
            </Button>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true); setError(null);
            void create({ token, roomId, name }).then((result) => {
              setLink(`${window.location.origin}/join#code=${result.code}`);
            }).catch((err) => setError(errorMessage(err, "Couldn't create the link. Try again.")))
              .finally(() => setBusy(false));
          }}>
            <label htmlFor="temporary-name" className="text-body font-medium">Profile name</label>
            <input id="temporary-name" autoComplete="off" maxLength={24} required value={name}
              onChange={(e) => setName(e.target.value)} aria-describedby="temporary-error"
              className="h-12 w-full rounded-control fill-quiet bg-white/8 px-4 text-body" />
            <Button type="submit" loading={busy} disabled={busy || !name.trim()} className="min-h-11">Create join link</Button>
          </form>
        )}
        <p id="temporary-error" role="alert" className="mt-3 text-body text-danger">{error}</p>
      </Sheet>
    </>
  );
}
