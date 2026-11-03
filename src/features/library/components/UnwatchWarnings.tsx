import { useState } from "react";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { toast } from "../../../ui/toast";
import { api } from "../../../../convex/_generated/api";
import { useAuthed } from "../../../data/session";
import { Button, ButtonLink } from "../../../ui/ui";

export function UnwatchWarnings() {
  const { token } = useAuthed();
  const warnings = useQuery(api.library.unwatchWarnings, { token });
  const simkl = useQuery(api.simkl.syncState, { token });
  const retry = useMutation(api.library.markUnwatched);
  const [busy, setBusy] = useState<string | null>(null);
  return warnings?.length ? <div className="mb-6 space-y-3">{warnings.map(({ error, ...item }) => <div key={item.id} role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-warning/10 p-4">
    <p className="text-body"><span className="font-medium">{item.name}.</span> {error}</p>
    {simkl?.writeBack && simkl.canWrite && !simkl.needsReconnect ? <Button loading={busy === item.id} disabled={busy !== null && busy !== item.id} onClick={() => {
      if (busy) return;
      setBusy(item.id);
      void retry({ token, item }).then(() => toast("Removal queued. Simkl write-back must be enabled."))
        .catch(() => toast.error("Couldn't retry. Try again.")).finally(() => setBusy(null));
    }}>Retry Simkl removal</Button> : <ButtonLink to="/settings/taste">Check Simkl connection</ButtonLink>}
  </div>)}</div> : null;
}
