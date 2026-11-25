import type { AddedFilterList, ContentBlockerState, ContentBlockerStats } from "../../contentBlocker";

export type ContentBlockerCalls = {
  "contentBlocker.state": [{}, ContentBlockerState];
  "contentBlocker.setEnabled": [{ enabled: boolean }, null];
  "contentBlocker.setListEnabled": [{ id: string; enabled: boolean }, null];
  "contentBlocker.addList": [{ url: string }, AddedFilterList];
  "contentBlocker.removeList": [{ id: string }, null];
  "contentBlocker.isAllowed": [{ host: string }, boolean];
  "contentBlocker.setAllowed": [{ host: string; allowed: boolean }, null];
  "contentBlocker.removeAllowed": [{ host: string }, { removed: boolean }];
  "contentBlocker.hiddenElements": [{ profile: string }, string[]];
  "contentBlocker.hideElements": [{ profile: string; filters: string[] }, null];
  "contentBlocker.restoreElements": [{ profile: string; filters: string[] }, null];
  "contentBlocker.devFailNextMessage": [{}, null];
  "contentBlocker.devDelayNextLoad": [{ ms: number }, null];
};

export type ContentBlockerEvents = {
  "contentBlocker.changed": ContentBlockerStats;
};
