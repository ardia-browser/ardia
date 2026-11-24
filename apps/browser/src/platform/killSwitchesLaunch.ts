import { updaterState } from "./app";
import { afterFirstWindow } from "../lib/afterFirstWindow";
import { refreshSwitches } from "./killSwitches";

export function startKillSwitches(fetchFn?: typeof fetch, refreshed?: (result: Awaited<ReturnType<typeof refreshSwitches>>) => void) {
  afterFirstWindow(() => {
    void updaterState().then(
      (state) => {
        if (state.available && state.configured && state.automaticChecks) void refreshSwitches(fetchFn).then(refreshed);
      },
      () => {},
    );
  });
}
