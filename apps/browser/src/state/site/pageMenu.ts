import { useMemo } from "react";
import { runPluginPageMenu, usePluginPageMenuItems } from "../plugins/hooks";
import { consentToken } from "../telemetry/client";
import { defaultTarget, languageName, revertPage, translatePage, translation, useTranslateState } from "./translate";
import { translatePageMenuItems } from "./translateMenu";

export function usePageMenuItems(tabId: string) {
  const translateState = useTranslateState(tabId);
  const base = useMemo(() => (translation ? translatePageMenuItems(translateState, languageName(defaultTarget())) : []), [translateState]);
  return usePluginPageMenuItems(tabId, base);
}

export function runPageMenuCommand(tabId: string, command: string, text = "", document = ""): boolean {
  if (command === "translatePage") void translatePage(tabId, defaultTarget(), "page_menu");
  else if (command === "showOriginal") void revertPage(tabId);
  else if (command.startsWith("plugin-menu:")) void runPluginPageMenu(tabId, command, text, document, consentToken());
  else return false;
  return true;
}
