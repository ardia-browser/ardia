import { cancelDownload } from "../../platform/downloads";
import { endWebKitPrivateSession } from "../../platform/webkit";
import { useBrowser, type BrowserState } from "../browser/store";
import { privateSession } from "../browser/model";
import { downloadSession } from "../downloads/downloadsSlice";
import { forgetThumbnails } from "../app/thumbnails";

function endClosedPrivateSessions(s: BrowserState, prev: BrowserState) {
  for (const w of Object.values(prev.windows)) {
    if (w.kind !== "private" || s.windows[w.id]) continue;
    const session = privateSession(s, w.profileId);
    if (Object.values(s.windows).some((o) => o.kind === "private" && privateSession(s, o.profileId) === session)) continue;
    const ended = s.downloads.filter((d) => downloadSession(s, d) === session);
    for (const d of ended) if (d.state === "downloading") void cancelDownload(d.id);
    s.forgetDownloads(w.profileId);
    forgetThumbnails(ended.map((d) => d.path));
    if (session !== null) void endWebKitPrivateSession(session);
  }
}

export const startPrivateSessions = () =>
  useBrowser.subscribe((s, prev) => {
    if (s.windows !== prev.windows) endClosedPrivateSessions(s, prev);
  });
