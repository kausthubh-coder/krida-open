import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession } from "../../data/session";
import { CONVEX_URL } from "../../data/backend";
import { errorMessage } from "../play";
import { Button } from "../../ui/ui";
import { Wordmark } from "../../ui/wordmark";

/** Only a backend on this machine or dev answers QA sign-in (convex/lib/deployment.ts); production never shows this. */
const offered = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(CONVEX_URL) || CONVEX_URL.includes("fastidious-oyster-35");

const field =
  "h-12 w-full rounded-full fill-quiet bg-white/6 px-5 text-subhead text-fg ring-1 ring-line ring-inset placeholder:text-fg-faint hover:bg-white/8 focus:bg-white/8 focus:ring-white/25 focus-visible:outline-transparent";

/**
 * `/qa`: scripts (and you, testing) sign in as a QA profile by name and password, without a Clerk login. The session
 * is the same one choosing a profile gives, so everything after this is the real app. `/qa?name=…&password=…&next=…`
 * signs in at once and goes to `next`: Krida for Mac's page can't be typed into by a script (docs/desktop.md).
 */
export function QaSignIn() {
  const { setToken } = useSession();
  const signIn = useMutation(api.profiles.qaSignIn);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (as: string, secret: string, next = "/") => {
    setBusy(true);
    setError(null);
    try {
      const result = await signIn({ name: as.trim(), password: secret });
      if (!result.ok) return setError(result.message);
      setToken(result.token);
      // Only a path in this app, never another site.
      navigate(next.startsWith("/") && !next.startsWith("//") ? next : "/", { replace: true });
    } catch (err) {
      setError(errorMessage(err, "Couldn't sign in. Try again."));
    } finally {
      setBusy(false);
    }
  };
  const asked = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const as = params.get("name");
    if (!offered || asked.current || !as) return;
    asked.current = true;
    void submit(as, params.get("password") ?? "", params.get("next") ?? "/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!offered)
    return (
      <main className="grid min-h-dvh place-items-center px-6 text-center">
        <p className="text-subhead text-fg-muted">QA sign-in is only on local and dev backends.</p>
      </main>
    );

  return (
    <main className="grid min-h-dvh place-items-center px-6 py-16">
      <form
        className="flex w-full max-w-sm flex-col items-center gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(name, password);
        }}
      >
        <Wordmark className="text-display" />
        <h1 className="text-title font-medium text-fg-muted">QA sign-in</h1>
        <input aria-label="QA profile" placeholder="Regress-QA-one" autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} className={field} />
        <input aria-label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          Sign in as QA profile
        </Button>
        <p role="alert" className="min-h-5 text-body text-danger">
          {error}
        </p>
      </form>
    </main>
  );
}
