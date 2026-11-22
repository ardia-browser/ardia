import { call } from "@ardia/ardiacore";
import type { SearchEngine } from "@ardia/core";

export const setPeekModifier = (modifier: "alt" | "shift" | "off") => call("webView.setPeekModifier", { modifier });
export const setSplitLinkModifier = (modifier: "alt" | "altShift") => call("webView.setSplitLinkModifier", { modifier });
export const setPeekOtherSiteTabs = (tabIds: string[]) => call("webView.setPeekOtherSiteTabs", { tabIds });
export const setInAppLinkRoutes = (profile: string, routes: [string, string, string][]) => call("webView.setInAppLinkRoutes", { profile, routes });
export const setSelectionPopover = (enabled: boolean) => call("webView.setSelectionPopover", { enabled });
export const setBlockAutoplayEverywhere = (enabled: boolean) => call("webView.setBlockAutoplayEverywhere", { enabled });
export type SearchEngineIdentity = Pick<SearchEngine, "name" | "keyword" | "url">;

export const setSearchEngineName = ({ name, keyword, url }: SearchEngineIdentity) =>
  call("search.setEngineName", { name, keyword, url });
export const setLittleArdiaOpensNewTabLinks = (enabled: boolean) => call("webView.setLittleArdiaOpensNewTabLinks", { enabled });
export const setPopupsOpenAsTabs = (enabled: boolean) => call("webView.setPopupsOpenAsTabs", { enabled });
