import { Menu, app, nativeImage, type BrowserWindow } from "electron";
import { join } from "node:path";
import { appDocumentUrl } from "./appDocument";
import { installBridge } from "./bridge";
import { pruneCrashDumps, startCrashReporter } from "./crashes";
import "./engine";
import "./menus/keyboard";
import "./modules";
import "./services";
import { iconPath } from "./modules/ardiaApp";
import { installLaunchLinks } from "./launchLinks";
import { launchConfig } from "./launch";
import { note } from "./log";
import { dataDirectory, hostEnvironment } from "./paths";
import { installQuitLifecycle } from "./quit";
import { DESKTOP_FILE } from "./system/desktopEntry";
import { createHost } from "./windows";

app.setName("Ardia");
app.setDesktopName(DESKTOP_FILE);
app.setPath("userData", join(dataDirectory(), "Engine"));
startCrashReporter();
if (hostEnvironment.remoteDebuggingPort) app.commandLine.appendSwitch("remote-debugging-port", hostEnvironment.remoteDebuggingPort);

const sandboxed = !app.commandLine.hasSwitch("no-sandbox");
note("launch", `${sandboxed ? "sandboxed with" : "no sandbox:"} ${hostEnvironment.sandboxReason ?? (sandboxed ? "Chromium's default" : "--no-sandbox was passed")}`);

async function loadUi(host: BrowserWindow) {
  await host.loadURL(appDocumentUrl());
}

if (!app.requestSingleInstanceLock({ dataDirectory: dataDirectory() })) {
  note("launch", "Ardia is already running with this data folder; the links went to it");
  app.exit(0);
} else {
  launchConfig();
  installQuitLifecycle();
  installLaunchLinks();
  app.on("browser-window-created", (_event, window) => {
    const icon = nativeImage.createFromPath(iconPath());
    if (!icon.isEmpty()) window.setIcon(icon);
  });
  Menu.setApplicationMenu(null);
  app.whenReady().then(() => {
    pruneCrashDumps();
    installBridge();
    createHost(loadUi);
  });
}
