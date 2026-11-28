import { createContext, useContext, useEffect, type DependencyList, type EffectCallback } from "react";

export const SettingsPageOpenedContext = createContext(true);

export function useWhenOpened(effect: EffectCallback, deps: DependencyList = []) {
  const opened = useContext(SettingsPageOpenedContext);
  useEffect(() => (opened ? effect() : undefined), [opened, ...deps]);
}
