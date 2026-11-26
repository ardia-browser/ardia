import { ardiaHost } from "./host";
import { entryKind } from "./popoverSurface";
import { showStartupFailure } from "./startupFailure";

const entry = entryKind(ardiaHost, location.search);
void (entry.kind === "popover"
  ? import("./popoverEntry").then(({ startPopover }) => startPopover(ardiaHost!, entry.boot))
  : entry.kind === "shell"
    ? import("./shellEntry").then(({ startShell }) => startShell())
    : Promise.reject(new Error(entry.reason))
).catch(showStartupFailure);
