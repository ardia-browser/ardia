import { defineDomain } from "../define.ts";

export const profiles = defineDomain({
  kind: "engine",
  imports: {
    "../../profiles": ["BrowsingDataType"],
    "../wire": ["Profile"],
  },
  calls: {
    loaded: {
      args: "{}",
      result: "{ profiles: string[] }",
      desktop: "custom",
      mac: "custom",
      windows: "absent",
    },
    release: {
      args: "Profile",
      result: "null",
      desktop: "custom",
      mac: "custom",
      windows: "custom",
    },
    unloadIdle: {
      args: "Profile",
      result: '{ status: "released" | "pending" | "busy"; tabs: string[]; heldBy?: string }',
      desktop: "custom",
      mac: "custom",
      windows: "absent",
    },
    deleteData: {
      args: "Profile",
      result: "{ remaining: string[] }",
      desktop: "custom",
      mac: "custom",
      windows: "custom",
    },
    clearBrowsingData: {
      args: "Profile & { types: BrowsingDataType[]; since: number | null }",
      result: "null",
      desktop: "custom",
      mac: "custom",
      windows: "custom",
    },
  },
  events: {
    loaded: {
      payload: "{ profile: string }",
      desktop: "custom",
      mac: "custom",
      windows: "absent",
    },
  },
});
