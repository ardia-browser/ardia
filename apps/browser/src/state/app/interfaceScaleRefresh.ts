import { onInterfaceScaleChange } from "../settings/interfaceScale";
import { closeEveryPopover } from "../tabs/popoverDismiss";
import { closeExtensionPopup } from "../extensions/actions";
import { closeFolderMenus } from "../bookmarks/folderMenus";
import { closeFolderPanel } from "../sidebar/tileFolderUi";
import { dismissHover } from "../sidebar/hover";
import { dismissStripHover } from "../tabs/stripHover";
import { closeProfileIconPicker } from "../profiles/iconPicker";

function closeAnchoredUi() {
  closeEveryPopover();
  closeExtensionPopup();
  closeFolderMenus();
  closeFolderPanel();
  dismissHover();
  dismissStripHover();
  closeProfileIconPicker();
}

let stop: (() => void) | null = null;

export function startInterfaceScaleRefresh(): () => void {
  stop ??= onInterfaceScaleChange(closeAnchoredUi);
  return stop;
}
