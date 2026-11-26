import { errorFor } from "../../browser/src/state/telemetry/consoleConsent";

export function showStartupFailure(error: unknown) {
  errorFor(null, "[ardia linux] startup failed", error);
  const root = document.getElementById("root");
  if (root) {
    root.setAttribute("role", "alert");
    root.textContent = `Ardia could not start: ${error instanceof Error ? error.message : String(error)}`;
  }
}
