import { app, components } from "electron";
import { count } from "../counts";
import { note } from "../log";

type WidevineState = "unavailable" | "pending" | "ready" | "failed";

let state: WidevineState = "unavailable";

export const widevineState = (): WidevineState => state;

const contentModules = (): typeof components | undefined => (typeof components === "object" && components && typeof components.whenReady === "function" ? components : undefined);

app.whenReady().then(() => {
  const modules = contentModules();
  if (!modules) {
    note("widevine", "this Electron has no Widevine CDM (stock build); protected video won't play");
    return;
  }
  state = "pending";
  const started = Date.now();
  modules
    .whenReady()
    .then(() => {
      state = "ready";
      const versions = Object.values(modules.status()).map((entry) => `${entry.title} ${entry.version} (${entry.status})`);
      note("widevine", `ready in ${Date.now() - started} ms: ${versions.join(", ")}`);
    })
    .catch((error: unknown) => {
      state = "failed";
      count("widevine_failures");
      note("widevine", `the CDM didn't install: ${error instanceof Error ? error.message : String(error)}`);
    });
});
