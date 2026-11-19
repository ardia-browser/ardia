import type { WebViewHandle } from "@ardia/ardiacore";

export const reloadToPlay = (handle: Pick<WebViewHandle, "reload">) => handle.reload();
