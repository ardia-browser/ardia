import { defineDomain } from "../define.ts";

export const windows = defineDomain({
  kind: "engine",
  imports: {
    "../../windows": ["ChromeWindowState"],
  },
  calls: {
    list: {
      args: "{}",
      result: "ChromeWindowState[]",
      desktop: "custom",
      mac: "custom",
      windows: "absent",
    },
    dev: {
      args: "{ window: number; action: string }",
      result: "string",
      desktop: "absent",
      mac: "custom",
      windows: "absent",
    },
  },
  events: {},
});
