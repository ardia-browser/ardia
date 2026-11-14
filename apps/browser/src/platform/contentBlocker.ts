import { call, on, type ContentBlockerState, type ContentBlockerStats, type FilterList, type FilterListCategory } from "@ardia/ardiacore";

export type { ContentBlockerState, FilterList, FilterListCategory };

export const getContentBlocker = () => call("contentBlocker.state");
export const setContentBlockerEnabled = (enabled: boolean) => call("contentBlocker.setEnabled", { enabled });
export const setFilterListEnabled = (id: string, enabled: boolean) => call("contentBlocker.setListEnabled", { id, enabled });
export const isContentBlockerAllowed = (host: string) => call("contentBlocker.isAllowed", { host });
export const setContentBlockerAllowed = (host: string, allowed: boolean) => call("contentBlocker.setAllowed", { host, allowed });
export const onContentBlockerChange = (listener: (stats: ContentBlockerStats) => void) => on("contentBlocker.changed", listener);
export const getHiddenElements = (profile: string) => call("contentBlocker.hiddenElements", { profile });
export const hideElements = (profile: string, filters: string[]) => call("contentBlocker.hideElements", { profile, filters });
export const restoreElements = (profile: string, filters: string[]) => call("contentBlocker.restoreElements", { profile, filters });
