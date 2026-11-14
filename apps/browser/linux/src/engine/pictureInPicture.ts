import { app, type WebFrameMain } from "electron";
import { guestOf, tell, type Guest } from "./guests";
import { definePageCall } from "./pageCalls";

export const PICTURE_IN_PICTURE_CHANNEL = "ardia:page-picture-in-picture";

const ENTER = `(async () => {
  const shown = (video) => video.readyState > 0 && !video.disablePictureInPicture && (video.currentSrc || video.srcObject);
  const videos = [...document.querySelectorAll("video")].filter(shown);
  const area = (video) => video.clientWidth * video.clientHeight;
  const pick = videos.filter((video) => !video.paused).sort((a, b) => area(b) - area(a))[0] || videos.sort((a, b) => area(b) - area(a))[0];
  if (!pick || !document.pictureInPictureEnabled) return false;
  try {
    await pick.requestPictureInPicture();
    return true;
  } catch {
    return false;
  }
})()`;

async function enterIn(frame: WebFrameMain): Promise<boolean> {
  try {
    return (await frame.executeJavaScript(ENTER, true)) === true;
  } catch {
    return false;
  }
}

async function requestPictureInPicture(guest: Guest): Promise<boolean> {
  const main = guest.contents.mainFrame;
  if (await enterIn(main)) return true;
  for (const frame of main.framesInSubtree) if (frame !== main && (await enterIn(frame))) return true;
  return false;
}

definePageCall("requestPictureInPicture", (guest) => requestPictureInPicture(guest));

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.on("ipc-message", (_event, channel, active: unknown) => {
    if (channel !== PICTURE_IN_PICTURE_CHANNEL) return;
    const guest = guestOf(contents);
    if (guest) tell(guest, "pictureInPicture", { kind: "video", active: active === true });
  });
});
