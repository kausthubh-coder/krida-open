import { createContext, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

type Draft = [string, Dispatch<SetStateAction<string>>];
const DraftContext = createContext<Draft | null>(null);

/**
 * What's typed in search. The nav's field and the Search page's own field (phones) edit the same text,
 * so moving between them never loses a keystroke.
 */
export function SearchDraftProvider({ children }: { children: ReactNode }) {
  const draft = useState("");
  return <DraftContext.Provider value={draft}>{children}</DraftContext.Provider>;
}

export function useSearchDraft(): Draft {
  const draft = useContext(DraftContext);
  if (!draft) throw new Error("useSearchDraft needs a SearchDraftProvider");
  return draft;
}
