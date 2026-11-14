import { app } from "electron";
import { count } from "../counts";
import { resolvePageWindowsWith } from "../menus/keyboard";
import { guestOf, tell } from "./guests";
import { appWindow } from "../windows";

resolvePageWindowsWith((contents) => {
  const guest = guestOf(contents);
  return guest?.windowId ? appWindow(guest.windowId) : null;
});

export const PAGE_ESCAPE_CHANNEL = "ardia:page-escape";

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.on("ipc-message", (_event, channel) => {
    if (channel !== PAGE_ESCAPE_CHANNEL) return;
    const guest = guestOf(contents);
    if (!guest) return;
    count("page_escapes");
    tell(guest, "command", { command: "escape", text: "" });
  });
});
