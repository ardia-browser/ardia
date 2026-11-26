import { ardiaHost } from "./host";
import { entryKind } from "./popoverSurface";

function showStartupFailure(error: unknown) {
  console.error("[ardia linux] startup failed", error);
  const root = document.getElementById("root");
  if (root) {
    root.setAttribute("role", "alert");
    root.textContent = `Ardia could not start: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const entry = entryKind(ardiaHost, location.search);
void (entry.kind === "popover"
  ? import("./popoverEntry").then(({ startPopover }) => startPopover(ardiaHost!, entry.boot))
  : entry.kind === "shell"
    ? import("./shellEntry").then(({ startShell }) => startShell())
    : Promise.reject(new Error(entry.reason))
).catch(showStartupFailure);
