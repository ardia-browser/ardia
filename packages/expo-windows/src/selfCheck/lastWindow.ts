import type { AppWindowsModule } from "../nativeModuleTypes";
import { requireNativeModule } from "../modules";

export const LAST_WINDOW_ID = "self-check-last-settings";
const STILL_RUNNING_MS = 8000;

const windows = () => requireNativeModule<Pick<AppWindowsModule, "quit" | "windowIds" | "openWindow" | "closeWindow" | "requestClose">>("ArdiaAppWindows");

export async function endByClosingTheLastWindow() {
  try {
    await windows().openWindow(LAST_WINDOW_ID, { kind: "settings", title: "Self check", focus: false });
    for (const id of await windows().windowIds()) if (id !== LAST_WINDOW_ID) await windows().closeWindow(id);
    console.info("[ardia windows] self-check: closing Settings, the last window, the way a user closes it");
    await windows().requestClose(LAST_WINDOW_ID);
  } catch (error) {
    console.info(`[ardia windows] self-check: couldn't end by closing the last window (${String(error)}); quitting`);
    return void windows().quit();
  }
  setTimeout(() => {
    console.error(`[ardia windows] self-check: the app was still running ${STILL_RUNNING_MS} ms after its last window, Settings, was closed the way a user closes it`);
    void windows().quit();
  }, STILL_RUNNING_MS);
}
