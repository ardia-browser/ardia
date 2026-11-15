import { withLinuxShortcuts } from "./chromium/keys/menuShortcuts";
import * as shared from "./tsModules.ts";

type Call = (...values: unknown[]) => unknown;
type Around = Record<string, Record<string, (main: Call | null) => unknown>>;

export const writtenInTs: Record<string, Record<string, unknown>> = shared.writtenInTs;

const sharedAround: Around = shared.aroundMain;

export const aroundMain: Around = {
  ...sharedAround,
  ArdiaMenus: {
    ...sharedAround.ArdiaMenus,
    showMenu: (main) => (items: unknown) => (main ? main(withLinuxShortcuts(items)) : Promise.resolve(null)),
  },
};
