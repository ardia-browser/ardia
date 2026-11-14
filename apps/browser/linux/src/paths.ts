import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;
const xdg = (variable: string, fallback: string) => env[variable] || join(homedir(), fallback);

export const xdgDataHome = (): string => xdg("XDG_DATA_HOME", ".local/share");
export const xdgConfigHome = (): string => xdg("XDG_CONFIG_HOME", ".config");
export const dataDirectory = (): string => env.ARDIA_DATA_DIR || join(xdgDataHome(), "ardia");
export const configDirectory = (): string => (env.ARDIA_DATA_DIR ? join(env.ARDIA_DATA_DIR, "config") : join(xdgConfigHome(), "ardia"));
export const isBackground = (): boolean => env.ARDIA_BACKGROUND === "1";

export const hostEnvironment = {
  remoteDebuggingPort: env.ARDIA_REMOTE_DEBUGGING_PORT || null,
  devServer: env.ARDIA_DEV_SERVER || null,
  uiDirectory: env.ARDIA_UI_DIR || null,
  sandboxReason: env.ARDIA_SANDBOX_REASON || null,
  appImage: env.APPIMAGE || null,
  launcher: env.ARDIA_LAUNCHER || null,
  currentDesktop: (env.XDG_CURRENT_DESKTOP ?? "").toLowerCase(),
};
