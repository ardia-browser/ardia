import { emitCommand, showMenu } from "@ardia/shell";
import { ardiaHost } from "./host";
import { isLinuxUtility } from "./session";
import { createWindowMenu } from "./windowMenu";
import { useBrowser } from "../../browser/src/state/browser/store";
import { windowTitle } from "../../browser/src/state/browser/model";

export const linuxWindowMenu = ardiaHost
  ? createWindowMenu(ardiaHost, { state: () => useBrowser.getState(), title: windowTitle, utility: isLinuxUtility, show: showMenu, command: emitCommand })
  : null;
