import { copyText } from "../../platform/clipboard";
import { fileExists, moveToTrash, revealFile } from "../../platform/files";
import { openDownload } from "./openDownload";
import { showMenu, type MenuItem } from "../../platform/menus";
import { menuSections } from "../app/menuSections";
import { openInternalPage } from "../pages/urls";
import { removeDownload } from "../windows/actions";
import { opensWhenDone, toggleOpenWhenDone } from "../windows/downloadWatch";
import { cancelDownload, keepDownload, pauseDownload, resumeDownload, type Download } from "./actions";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { awaitsKeep } from "./status";
import { t } from "../../lib/uiLanguage";


export type DownloadMenuState = { held: boolean; downloading: boolean; paused: boolean; opensWhenDone: boolean; fileExists: boolean };

export function downloadMenuItems(d: DownloadMenuState): MenuItem[] {
  const lead: MenuItem[] = d.held
    ? [
        { id: "keep", title: t(`Keep`), symbol: "checkmark.circle" },
        { id: "cancel", title: t(`Discard`), symbol: "xmark.circle" },
      ]
    : d.downloading
      ? [
          { id: "whenDone", title: t(`Open When Done`), checked: d.opensWhenDone },
          d.paused ? { id: "resume", title: t(`Resume`), symbol: "play" } : { id: "pause", title: t(`Pause`), symbol: "pause" },
          { id: "cancel", title: t(`Cancel`), symbol: "xmark.circle" },
        ]
      : [
          { id: "open", title: t(`Open`), symbol: "arrow.up.forward.app", enabled: d.fileExists },
          { id: "reveal", title: `Show in ${PLATFORM_TERMS.fileManager}`, symbol: "folder", enabled: d.fileExists },
        ];
  return menuSections(
    lead,
    [
      { id: "copy", title: t(`Copy Link`), symbol: "link" },
      { id: "page", title: t(`Show All Downloads`), symbol: "arrow.down.circle" },
    ],
    [
      { id: "remove", title: t(`Remove from List`), symbol: "minus.circle", enabled: !d.downloading },
      d.fileExists && { id: "trash", title: `Move to ${PLATFORM_TERMS.trash}`, symbol: "trash" },
    ],
  );
}

export async function downloadMenu(d: Download, windowId: string) {
  const exists = d.state === "finished" && fileExists(d.path);
  const choice = await showMenu(
    downloadMenuItems({ held: awaitsKeep(d), downloading: d.state === "downloading", paused: d.paused, opensWhenDone: opensWhenDone(d.id), fileExists: exists }),
  );
  if (choice === "whenDone") toggleOpenWhenDone(d.id);
  if (choice === "pause") void pauseDownload(d.id);
  if (choice === "resume") void resumeDownload(d.id);
  if (choice === "keep") void keepDownload(d.id);
  if (choice === "cancel") void cancelDownload(d.id);
  if (choice === "open") void openDownload(d.path);
  if (choice === "reveal") void revealFile(d.path);
  if (choice === "copy") copyText(d.url);
  if (choice === "page") openInternalPage("downloads", windowId);
  if (choice === "trash") void trashDownload(d);
  if (choice === "remove") removeDownload(d.id);
}

async function trashDownload(d: Download) {
  if (await moveToTrash(d.path)) removeDownload(d.id);
}
