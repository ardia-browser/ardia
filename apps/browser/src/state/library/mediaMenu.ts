import type { Download } from "../../platform/downloads";
import { showMenu } from "../../platform/menus";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { menuSections } from "../app/menuSections";
import { fileExists, moveToTrash, openFile, revealFile } from "../app/system";
import { downloadMenu } from "../downloads/downloadMenu";
import { folderItemPath } from "./items";

export async function mediaItemMenu(d: Download, windowId: string) {
  const path = folderItemPath(d.id);
  if (path === null) return downloadMenu(d, windowId);
  const exists = fileExists(path);
  const choice = await showMenu(
    menuSections(
      [
        { id: "open", title: "Open", symbol: "arrow.up.forward.app", enabled: exists },
        { id: "reveal", title: `Show in ${PLATFORM_TERMS.fileManager}`, symbol: "folder", enabled: exists },
      ],
      [exists && { id: "trash", title: `Move to ${PLATFORM_TERMS.trash}`, symbol: "trash" }],
    ),
  );
  if (choice === "open") void openFile(path);
  if (choice === "reveal") void revealFile(path);
  if (choice === "trash") void moveToTrash(path);
}
