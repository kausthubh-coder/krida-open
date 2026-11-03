import { Link } from "react-router";

/** Said where a party would start, instead of letting the start fail: parties play the host's TorBox stream. */
export function NeedsTorBox() {
  return (
    <p className="rounded-card bg-white/5 p-3 text-body text-pretty text-fg-muted">
      Parties need TorBox: everyone watches the host’s TorBox stream. Add a TorBox key in{" "}
      <Link to="/settings/connections" className="font-medium text-fg underline underline-offset-2">
        Settings → Connections
      </Link>{" "}
      to start one. You can still join a party someone else hosts.
    </p>
  );
}
