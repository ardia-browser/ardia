import type { ReactNode } from "react";
import { useWindowId } from "../../state/browser/hooks";
import { useWindowUiOf } from "../../state/windows/hooks";
import { useBookmarkDialog } from "../../state/bookmarks/actions";
import { useBookmarkEditor } from "../../state/bookmarks/edit";
import { useCreateProfileRequest } from "../../state/profiles/createProfileRequest";
import { useExtensions } from "../../state/extensions/actions";
import { DownloadMagnet, DownloadsPopover, useDownloadFlight } from "../downloads/Downloads";
import { ExtensionOverlays } from "../extensions/ExtensionOverlays";
import { BookmarkDialog } from "../bookmarks/BookmarkDialog";
import { EditBookmarkDialog } from "../bookmarks/EditBookmarkDialog";
import { CreateProfileHost } from "../profiles/CreateProfile";
import { useOpenedOnce } from "../ui/useOpenedOnce";

export function WindowPopups({ plugins }: { plugins: ReactNode }) {
  const windowId = useWindowId();
  const downloads = useOpenedOnce(useWindowUiOf(windowId, (ui) => !!ui?.downloadsOpen));
  const extension = useExtensions((e) => e.popup?.windowId === windowId || e.install?.windowId === windowId || e.pinDialog?.windowId === windowId);
  const [flight, landed] = useDownloadFlight(windowId);
  const bookmark = useBookmarkDialog((d) => d.open?.windowId === windowId);
  const editor = useBookmarkEditor((e) => e.open?.windowId === windowId);
  const profile = useCreateProfileRequest((r) => r.request?.windowId === windowId);
  return (
    <>
      {downloads ? <DownloadsPopover /> : null}
      {extension ? <ExtensionOverlays /> : null}
      {plugins}
      {flight ? <DownloadMagnet key={flight.id} flight={flight} onLanded={landed} /> : null}
      {bookmark ? <BookmarkDialog /> : null}
      {editor ? <EditBookmarkDialog /> : null}
      {profile ? <CreateProfileHost /> : null}
    </>
  );
}
