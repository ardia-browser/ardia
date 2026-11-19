import type { WebViewHandle } from "@ardia/ardiacore";

type WindowsPageHandle = Pick<WebViewHandle, "reload"> & { reloadToPlay?: () => Promise<void> };

export const reloadToPlay = (handle: WindowsPageHandle) => (handle.reloadToPlay ? handle.reloadToPlay() : handle.reload());
