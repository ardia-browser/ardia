import { BrowserWindow, dialog, type MessageBoxOptions, type MessageBoxReturnValue, type MessageBoxSyncOptions, type OpenDialogOptions, type OpenDialogReturnValue, type SaveDialogOptions, type SaveDialogReturnValue } from "electron";
import { returnFocus } from "./focusReturn";

type Parent = BrowserWindow | null | undefined;

const shownParent = (parent: Parent) => (parent && !parent.isDestroyed() ? parent : undefined);

async function returningFocus<T>(parent: Parent, show: (parent: BrowserWindow | undefined) => Promise<T>): Promise<T> {
  const owner = shownParent(parent);
  const behind = owner ?? BrowserWindow.getFocusedWindow();
  try {
    return await show(owner);
  } finally {
    returnFocus(behind);
  }
}

export const showMessageBox = (parent: Parent, options: MessageBoxOptions): Promise<MessageBoxReturnValue> =>
  returningFocus(parent, (owner) => (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options)));

export const showOpenDialog = (parent: Parent, options: OpenDialogOptions): Promise<OpenDialogReturnValue> =>
  returningFocus(parent, (owner) => (owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options)));

export const showSaveDialog = (parent: Parent, options: SaveDialogOptions): Promise<SaveDialogReturnValue> =>
  returningFocus(parent, (owner) => (owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options)));

export function showMessageBoxSync(parent: Parent, options: MessageBoxSyncOptions): number {
  const owner = shownParent(parent);
  const behind = owner ?? BrowserWindow.getFocusedWindow();
  try {
    return owner ? dialog.showMessageBoxSync(owner, options) : dialog.showMessageBoxSync(options);
  } finally {
    returnFocus(behind);
  }
}
