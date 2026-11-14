import type * as ChromeExtensions from "electron-chrome-extensions";
import type * as ChromeWebStore from "electron-chrome-web-store";

const extensions = require("electron-chrome-extensions") as typeof ChromeExtensions;
const webStore = require("electron-chrome-web-store") as typeof ChromeWebStore;

export const { ElectronChromeExtensions } = extensions;
export const { installChromeWebStore } = webStore;
export type ElectronChromeExtensions = ChromeExtensions.ElectronChromeExtensions;
