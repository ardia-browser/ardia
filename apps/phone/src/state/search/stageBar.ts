import { create } from "zustand";
import type { SearchEnding } from "./store";

export const SEARCH_ANCHOR_ID = "searchStageAnchor";
export const SEARCH_FACE_ID = "searchStageFace";
export const SEARCH_FIELD_ID = "searchStageField";
export const SEARCH_REVEAL_ID = "searchStageReveal";
export const SEARCH_ROWS_REVEAL_ID = "searchStageRowsReveal";

export type StageExit = "morph" | "depart" | "drop";

type StageBar = { onScreen: boolean; presented: boolean; morphs: boolean; landed: boolean; pills: number };

export const useStageBar = create<StageBar>()(() => ({ onScreen: false, presented: false, morphs: false, landed: false, pills: 0 }));

export function reportBarPill(): () => void {
  useStageBar.setState((state) => ({ pills: state.pills + 1 }));
  return () => useStageBar.setState((state) => ({ pills: Math.max(state.pills - 1, 0) }));
}

export const searchLandsInBar = (ending: SearchEnding, morphs: boolean) => ending === "cancelled" && morphs;

export function stageExit(ending: SearchEnding, morphs: boolean): StageExit {
  if (searchLandsInBar(ending, morphs)) return "morph";
  return ending === "submitted" ? "depart" : "drop";
}

export const barCentreShown = (open: boolean, ending: SearchEnding, bar: Pick<StageBar, "onScreen" | "presented" | "morphs">) => (open ? !bar.presented : !(bar.onScreen && searchLandsInBar(ending, bar.morphs)));

export const stageOpened = () => useStageBar.setState({ onScreen: true, presented: false, landed: false });

export const stagePresented = () => useStageBar.setState({ presented: true });

export const stageSettled = (landed: boolean) => useStageBar.setState({ onScreen: false, presented: false, landed });

export const setStageMorphs = (morphs: boolean) => {
  if (useStageBar.getState().morphs !== morphs) useStageBar.setState({ morphs });
};
