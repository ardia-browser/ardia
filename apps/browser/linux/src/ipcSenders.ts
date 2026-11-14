import { session, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import { isAppDocument } from "./appDocument";
import { note } from "./log";

type IpcEvent = IpcMainEvent | IpcMainInvokeEvent;

const COMMIT_WAIT_MS = 5000;

let host: WebContents | null = null;
const hostDocumentStarted = new Set<() => void>();
const refusedSenders = new Set<number>();

const announceHostDocumentStarted = () => {
  for (const listener of hostDocumentStarted) listener();
};

export function trustHost(contents: WebContents): void {
  host = contents;
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) announceHostDocumentStarted();
  });
  contents.on("render-process-gone", announceHostDocumentStarted);
  contents.once("destroyed", () => {
    if (host === contents) host = null;
  });
}

export function onHostDocumentStarted(listener: () => void): void {
  hostDocumentStarted.add(listener);
}

function isHost(event: IpcEvent): boolean {
  const frame = event.senderFrame;
  return !!host && event.sender === host && !!frame && frame === host.mainFrame && isAppDocument(frame.url);
}

function isPage(event: IpcEvent): boolean {
  return !!event.senderFrame && event.sender !== host && event.sender.session !== session.defaultSession;
}

function refuse(channel: string, event: IpcEvent): false {
  const sender = event.sender;
  if (refusedSenders.has(sender.id)) return false;
  refusedSenders.add(sender.id);
  const frame = event.senderFrame;
  const where = !frame ? "no frame" : `${frame.url || "nothing committed"}${sender === host ? (frame === host.mainFrame ? ", the host's main frame" : frame.parent ? ", a host subframe" : ", a host main frame not yet current") : ""}`;
  note("ipc", `refused ${channel} from ${sender.getType()} ${sender.id} (${where}); later refusals of this sender aren't logged`);
  return false;
}

function maybeCommitting(event: IpcEvent): boolean {
  const frame = event.senderFrame;
  return !!host && event.sender === host && !!frame && !frame.parent && (frame !== host.mainFrame || !frame.url);
}

function hostNavigated(contents: WebContents): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      contents.off("did-navigate", done);
      resolve();
    };
    const timer = setTimeout(done, COMMIT_WAIT_MS);
    contents.on("did-navigate", done);
  });
}

export const acceptsHostNow = (event: IpcEvent): boolean => isHost(event);

export async function acceptsHost(event: IpcEvent, channel: string): Promise<boolean> {
  if (isHost(event)) return true;
  if (host && maybeCommitting(event)) {
    await hostNavigated(host);
    if (isHost(event)) return true;
  }
  return refuse(channel, event);
}
export const acceptsPage = (event: IpcEvent, channel: string): boolean => isPage(event) || refuse(channel, event);
