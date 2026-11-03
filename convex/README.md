# convex/

Krida's backend. Build every mutation from `./functions` (`mutation`, `internalMutation`), never from
`./_generated/server`; lint enforces it. Public files keep their names and exports, because they are the live
frontend's API. Shared helpers live in `lib/`. See `docs/architecture.md`.
