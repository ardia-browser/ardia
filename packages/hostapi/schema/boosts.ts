import { defineDomain } from "../define.ts";

export const boosts = defineDomain({
  kind: "engine",
  imports: {
    "../wire": ["Profile"],
  },
  calls: {
    setProfileBoosts: {
      args: "Profile & { json: string }",
      result: "null",
      desktop: "absent",
      mac: "custom",
      windows: "absent",
    },
    previewBoost: {
      args: "{ tabId: string; json: string }",
      result: "null",
      desktop: "absent",
      mac: "custom",
      windows: "absent",
    },
    clearBoostPreview: {
      args: "{ tabId: string }",
      result: "null",
      desktop: "absent",
      mac: "custom",
      windows: "absent",
    },
  },
  events: {},
});
