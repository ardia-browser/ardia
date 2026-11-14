import { BrowserWindow } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { isBackground } from "../paths";
import { showSaveDialog } from "../systemDialogs";

export async function askSavePath(defaultName: string, filters: Electron.FileFilter[], message?: string): Promise<string | null> {
  const owner = BrowserWindow.getFocusedWindow();
  const options: Electron.SaveDialogOptions = { defaultPath: join(homedir(), defaultName), filters, ...(message ? { message } : {}) };
  if (isBackground()) {
    console.info(`[ardia dialogs] save panel for ${defaultName}`);
    return null;
  }
  const { canceled, filePath } = await showSaveDialog(owner, options);
  return canceled || !filePath ? null : filePath;
}
