import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { backgroundInstance } from "./appSettings";

const subscribe = (changed: () => void) => {
  const sub = AppState.addEventListener("change", changed);
  return () => sub.remove();
};
const appActive = () => backgroundInstance || AppState.currentState === "active";

export const useAppActive = () => useSyncExternalStore(subscribe, appActive);
