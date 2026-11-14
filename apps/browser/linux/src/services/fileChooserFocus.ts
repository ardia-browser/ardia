import { ipcMain } from "electron";
import { guestOf, windowOf } from "../engine/guests";
import { returnFocus } from "../focusReturn";
import { acceptsPage } from "../ipcSenders";
import { definePageScript } from "./guests";

function fileChooserPage(ipc: Electron.IpcRenderer) {
  const closed = (event: Event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "file") ipc.send("ardia:file-chooser-closed");
  };
  window.addEventListener("change", closed, true);
  window.addEventListener("cancel", closed, true);
}

definePageScript("ardia-file-chooser", fileChooserPage);

ipcMain.on("ardia:file-chooser-closed", (event) => {
  if (!acceptsPage(event, "ardia:file-chooser-closed")) return;
  const guest = guestOf(event.sender);
  if (guest) returnFocus(windowOf(guest));
});
