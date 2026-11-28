import type { Profile } from "../wire";

export type BoostsCalls = {
  "boosts.setProfileBoosts": [Profile & { json: string }, null];
  "boosts.previewBoost": [{ tabId: string; json: string }, null];
  "boosts.clearBoostPreview": [{ tabId: string }, null];
};

export type BoostsEvents = {};
