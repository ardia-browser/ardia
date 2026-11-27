import { SyncNative } from "@ardia/sync";
import { ardiaHost, hostSupports, invokeHost } from "./host.ts";

export * from "../../browser/src/platform/sharedFolders";

export const REVEAL_SHARED_FOLDER = "ArdiaSharedFolders.revealFolder";

export const revealSharedFolder = (path: string): Promise<void> => {
  if (SyncNative) return SyncNative.revealFolder(path);
  if (ardiaHost && hostSupports(REVEAL_SHARED_FOLDER, ardiaHost)) return invokeHost<void>(REVEAL_SHARED_FOLDER, { args: [path] }, ardiaHost);
  return Promise.reject(Object.assign(new Error("Showing a folder isn't available in this build"), { code: "ERR_UNAVAILABLE" }));
};
