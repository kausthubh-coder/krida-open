import { lazy, StrictMode, Suspense, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { ConvexReactClient, useAction, useConvex, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { MotionConfig } from "motion/react";
import { Toaster } from "sonner";
import { SessionProvider, useSession } from "../data/session";
import { MineProvider } from "../data/mine";
import { SyncProvider } from "../data/sync";
import { SeeAll, useRecsRefresh } from "../features/home";
import { ConvexQueryCacheProvider } from "convex-helpers/react/cache/provider";
import { useScrollMemory } from "./scroll";
import { setSoundsEnabled, unlockAudioOnFirstGesture } from "../ui/sound";
import { applySurfaces } from "../ui/surfaces";
import { BubliScene } from "bubli";
import { KridaBubbles } from "../ui/bubbles";
import { startKeyboardRepair } from "../ui/keyboard";
import { startInstallPrompt } from "../ui/install";
import { startAndroid } from "../ui/android";
import { useAppUpdateNotice, useNewBuildNotice, useOfflineNotice, useOnline, useWhatsNew } from "../ui/appStatus";
import { ProfileGate, QaSignIn, Settings, ConnectSimkl } from "../features/settings";
import { JoinTemporary, InviteListener, keepPartyLink, PartyLink, PartyUIProvider, PartyProvider, PartyDock, usePendingPartyLink } from "../features/party";
import { useAccount } from "../data/account";
import { AccountProviders } from "../data/accountProviders";
import { Search, SearchDraftProvider, useSearchShortcut } from "../features/search";
import { Title } from "../features/title";
import { Person } from "../features/person";
import { NotFound } from "./NotFound";
import { BottomEdge, BottomNav, EdgeBack, NavDock, TopNav } from "./nav";
import { useFullscreenShortcut } from "../ui/fullscreen";
import { SHORT, useMedia } from "../ui/media";
import { Spinner } from "../ui/ui";
import { reloadOntoNewBuild } from "../ui/lazyPage";
import { CONVEX_URL } from "../data/backend";
import { startLogs } from "../data/log";
import { identify, startTelemetry } from "../data/telemetry";
import { warmPlace } from "../data/prefetch";
import { keptPlace } from "./places";
import { Pages } from "./Pages";
import { Landing } from "./lazyLanding";
import { exemptFromOnboarding, Onboarding, route, signedOutScreen } from "../features/onboarding";
import { useOnboardingStatus } from "../data/keys";
import { KEY_REFUSED } from "../data/api";
import { inApp } from "../data/hint";

// The player (and hls.js) loads only when someone starts watching.
const Watch = lazy(() => import("../features/player").then((m) => ({ default: m.Watch }), reloadOntoNewBuild));

keepPartyLink();
const convex = new ConvexReactClient(CONVEX_URL);
startLogs(convex);
startTelemetry();
unlockAudioOnFirstGesture();
applySurfaces();
startKeyboardRepair();
startInstallPrompt();
startAndroid();
// Installable, and opening at once like an app (public/sw.js). Not in dev, where Vite's files change under one name.
if (import.meta.env.PROD && "serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => {});

function Gate() {
  const { token, me, setToken } = useSession();
  const online = useOnline();
  useOfflineNotice();
  const path = useLocation().pathname;
  const watching = path.startsWith("/watch/");
  useNewBuildNotice(watching);
  useAppUpdateNotice(watching);
  useWhatsNew(watching);
  // Opening on Home or the Library, its first queries go out with the session check rather than after it.
  const convex = useConvex();
  useEffect(() => {
    const opened = keptPlace(location.pathname);
    if (token && opened) warmPlace(convex, token, opened);
  }, [convex, token]);
  // A token the server no longer knows (signed out elsewhere, a PIN set on another device) goes back to the gate.
  useEffect(() => {
    if (token && me === null) setToken(null);
  }, [token, me, setToken]);
  // The account signed out (in another tab, or its Clerk session ended): the profile it chose goes with it.
  const account = useAccount();
  const signOutProfile = useMutation(api.profiles.signOut);
  useEffect(() => {
    if (!account.enabled || !account.loaded || account.signedIn || !token || !me?.viaAccount) return;
    void signOutProfile({ token }).catch(() => {});
    setToken(null);
  }, [account.enabled, account.loaded, account.signedIn, token, me?.viaAccount, signOutProfile, setToken]);
  useEffect(() => {
    setSoundsEnabled(me?.prefs.sounds ?? true);
  }, [me?.prefs.sounds]);
  // PostHog ties what follows to the profile, once the session check has answered.
  const profileId = me === undefined ? undefined : (me?._id ?? null);
  const profileName = me?.name;
  useEffect(() => {
    if (profileId !== undefined) identify(profileId && profileName ? { _id: profileId, name: profileName } : null);
  }, [profileId, profileName]);
  // Opening Krida, or coming back to it, catches up with Simkl. The server decides whether it's due
  // (at most every ten minutes); this only avoids asking more than once a minute.
  const touchSimkl = useMutation(api.simkl.touch);
  const signedIn = !!me;
  usePendingPartyLink(signedIn);
  useEffect(() => {
    if (!token || !signedIn) return;
    let last = 0;
    const touch = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 60_000) return;
      last = Date.now();
      void touchSimkl({ token }).catch(() => {});
    };
    touch();
    document.addEventListener("visibilitychange", touch);
    window.addEventListener("focus", touch);
    return () => {
      document.removeEventListener("visibilitychange", touch);
      window.removeEventListener("focus", touch);
    };
  }, [token, signedIn, touchSimkl]);

  // Onboarding (docs/models/Onboarding.tla): Home shows only once the profile's steps are done. Once it starts it stays
  // until its last step says so, so an addon installed half way through doesn't jump to Home.
  const status = useOnboardingStatus();
  const needsSteps = !!me && !!status && route({ signedIn: true, profile: true, status }) !== "home";
  const [onboarding, setOnboarding] = useState(false);
  if (needsSteps && !onboarding) setOnboarding(true);
  const onboarded = useCallback(() => setOnboarding(false), []);
  // Keys can stop working after they were checked: ask the providers again on opening (the server keeps it to every
  // few hours), and at once when /api says TMDB refused the key.
  const recheck = useAction(api.onboarding.recheck);
  const hasAccount = !!status;
  useEffect(() => {
    if (!token || !hasAccount) return;
    void recheck({ token }).catch(() => {});
    const refused = () => void recheck({ token, force: true }).catch(() => {});
    window.addEventListener(KEY_REFUSED, refused);
    return () => window.removeEventListener(KEY_REFUSED, refused);
  }, [token, hasAccount, recheck]);

  if (!token) {
    if (account.loaded && !account.signedIn && signedOutScreen(path) === "landing" && !inApp())
      return (
        <Suspense fallback={<div className="min-h-dvh" />}>
          <Landing />
        </Suspense>
      );
    return <ProfileGate />;
  }
  if (me === undefined || (me && status === undefined))
    return (
      <div className="grid min-h-dvh place-items-center">
        {/* Opened from the home screen with no connection: say so, rather than wait without end. */}
        {online ? (
          <Spinner className="text-fg-faint" />
        ) : (
          <p className="max-w-[30ch] px-4 text-center text-body text-fg-muted">You’re offline. Krida opens once you’re back online.</p>
        )}
      </div>
    );
  if (me === null) return <ProfileGate />;
  if (status && (needsSteps || onboarding) && !exemptFromOnboarding(path))
    return (
      <SyncProvider key={token}>
        <Onboarding status={status} onDone={onboarded} />
      </SyncProvider>
    );
  return (
    <PartyProvider>
      <PartyUIProvider>
        <InviteListener />
        <SyncProvider key={token}>
          <MineProvider>
            <RecsRefresh />
            <Outlet />
          </MineProvider>
        </SyncProvider>
      </PartyUIProvider>
    </PartyProvider>
  );
}

/** Keeps this profile's picks up to date while it's signed in. */
function RecsRefresh() {
  useRecsRefresh();
  return null;
}

function Shell() {
  useScrollMemory();
  useSearchShortcut();
  useFullscreenShortcut();
  // Only the nav this screen shows is mounted: a hidden one would still measure and re-render on every page.
  const wide = useMedia("(min-width: 768px)");
  const short = useMedia(SHORT);
  return (
    <SearchDraftProvider>
      <TopNav />
      <EdgeBack />
      {/* The bottom keeps clear of the floating dock (the tab bar on phones); a sideways phone's rail is at the left
          instead, and the right keeps clear of its far edge. The top starts below the status bar; artwork at the top
          of a page pulls back up under it (-mt-(--inset-top)) and out to the right edge (-mr-(--inset-right)). The page is the scene the nav's bubbles bend in Firefox. */}
      <BubliScene className="pt-(--inset-top) pb-[calc(84px+var(--dock-bottom))] pr-(--inset-right) pl-(--rail-pad,0px) md:pb-24 short:pb-8">
        <Pages />
      </BubliScene>
      <PartyDock />
      <BottomEdge />
      {wide && !short ? <NavDock /> : <BottomNav rail={short} />}
    </SearchDraftProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AccountProviders client={convex}>
      {/* Pages keep their queries for a few minutes after you leave them, so going back is instant. */}
      <ConvexQueryCacheProvider expiration={3 * 60_000}>
        <SessionProvider>
          <MotionConfig reducedMotion="user">
            <KridaBubbles>
            <BrowserRouter>
              <Routes>
                <Route path="/join" element={<JoinTemporary />} />
                <Route path="/qa" element={<QaSignIn />} />
                <Route element={<Gate />}>
                  <Route
                    path="/watch/:roomId"
                    element={
                      <Suspense fallback={<div className="h-dvh bg-black" />}>
                        <Watch />
                      </Suspense>
                    }
                  />
                  <Route element={<Shell />}>
                    {/* Home and Library are drawn by Pages, which keeps them; these only claim their paths. */}
                    <Route index element={null} />
                    <Route path="search" element={<Search />} />
                    <Route path="title/:type/:id" element={<Title />} />
                    <Route path="person/:id" element={<Person />} />
                    <Route path="browse/:addon/:type/:catalog" element={<SeeAll />} />
                    <Route path="library" element={null} />
                    <Route path="settings/:section?" element={<Settings />} />
                    <Route path="connect/simkl" element={<ConnectSimkl />} />
                    <Route path="party" element={<PartyLink />} />
                    {/* Signed in already: the sign-in page has nothing to do. */}
                    <Route path="sign-in" element={<Navigate to="/" replace />} />
                    <Route path="*" element={<NotFound />} />
                  </Route>
                </Route>
              </Routes>
            </BrowserRouter>
            <Toaster
              theme="dark"
              position="bottom-right"
              offset={{ bottom: "var(--toast-bottom, 96px)", right: "var(--toast-right, 24px)" }}
              mobileOffset={{ bottom: "calc(84px + var(--dock-bottom))" }}
            />
            </KridaBubbles>
          </MotionConfig>
        </SessionProvider>
      </ConvexQueryCacheProvider>
    </AccountProviders>
  </StrictMode>,
);
