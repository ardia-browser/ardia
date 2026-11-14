import { app, type WebFrameMain } from "electron";
import { count } from "../counts";
import { guestOf, tell, type Guest } from "./guests";
import { isHiddenPage, notePictureInPicture } from "./memorySaver";
import { definePageCall } from "./pageCalls";

export const PICTURE_IN_PICTURE_CHANNEL = "ardia:page-picture-in-picture";

const enterScript = (playingOnly: boolean) => `(async () => {
  const shown = (video) => video.readyState > 0 && !video.disablePictureInPicture && (video.currentSrc || video.srcObject);
  const videos = [...document.querySelectorAll("video")].filter(shown);
  const area = (video) => video.clientWidth * video.clientHeight;
  const playing = videos.filter((video) => !video.paused && !video.ended).sort((a, b) => area(b) - area(a))[0];
  const pick = playing || (${playingOnly} ? null : videos.sort((a, b) => area(b) - area(a))[0]);
  if (!pick || !document.pictureInPictureEnabled) return false;
  try {
    await pick.requestPictureInPicture();
    return true;
  } catch {
    return false;
  }
})()`;

const EXIT = `(async () => {
  if (!document.pictureInPictureElement) return false;
  await document.exitPictureInPicture().catch(() => {});
  return true;
})()`;

const autoOpened = new Set<number>();
const leavingOnOurOwn = new Set<number>();

async function runIn(frame: WebFrameMain, code: string): Promise<boolean> {
  try {
    return (await frame.executeJavaScript(code, true)) === true;
  } catch {
    return false;
  }
}

async function inEveryFrame(guest: Guest, code: string): Promise<boolean> {
  const main = guest.contents.mainFrame;
  if (await runIn(main, code)) return true;
  for (const frame of main.framesInSubtree) if (frame !== main && (await runIn(frame, code))) return true;
  return false;
}

const requestPictureInPicture = (guest: Guest, playingOnly = false) => inEveryFrame(guest, enterScript(playingOnly));

async function popOutOnLeaving(guest: Guest) {
  const id = guest.contents.id;
  if (await requestPictureInPicture(guest, true)) {
    autoOpened.add(id);
    count("auto_pip_opened");
    return;
  }
  tell(guest, "autoPictureInPictureKept", { reason: "nothingPlaying" });
}

async function closeOnReturning(guest: Guest) {
  const id = guest.contents.id;
  if (!autoOpened.delete(id)) return;
  leavingOnOurOwn.add(id);
  if (!(await inEveryFrame(guest, EXIT))) leavingOnOurOwn.delete(id);
}

function left(guest: Guest, playing: boolean) {
  const id = guest.contents.id;
  autoOpened.delete(id);
  if (leavingOnOurOwn.delete(id) || !playing || !isHiddenPage(id)) return;
  count("pip_back_to_tab");
  tell(guest, "activateRequest", { reason: "pictureInPicture" });
}

definePageCall("requestPictureInPicture", (guest) => requestPictureInPicture(guest));
definePageCall("autoPictureInPicture", (guest, args) => (args.on === true ? popOutOnLeaving(guest) : closeOnReturning(guest)));

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.on("ipc-message", (_event, channel, active: unknown, playing: unknown) => {
    if (channel !== PICTURE_IN_PICTURE_CHANNEL) return;
    const guest = guestOf(contents);
    if (!guest) return;
    notePictureInPicture(contents.id, active === true);
    tell(guest, "pictureInPicture", { kind: "video", active: active === true });
    if (active !== true) left(guest, playing === true);
  });
  contents.once("destroyed", () => {
    autoOpened.delete(contents.id);
    leavingOnOurOwn.delete(contents.id);
  });
});
