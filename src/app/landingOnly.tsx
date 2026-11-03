import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Landing } from "../features/landing";

// The landing page alone, for a visitor who has never signed in here: no Convex, Clerk or bubbles load. Its links to
// /sign-in load the app.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
