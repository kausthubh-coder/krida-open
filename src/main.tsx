// Krida's entry. A visitor opening / who has never signed in here gets only the landing page, in a small chunk of its
// own; everyone else gets the app (src/app/main.tsx), which shows the landing page too when nobody is signed in.
import "./styles.css";
import { inApp, signedInHere } from "./data/hint";

if (location.pathname === "/" && !signedInHere() && !inApp()) void import("./app/landingOnly");
else void import("./app/main");
