import type { WebContents } from "electron";
import { isAppDocument } from "./appDocument";
import { note } from "./log";

type Preventable = { url: string; isMainFrame?: boolean; preventDefault(): void };

const BLANK = "about:blank";
const EMBEDDED_DOCUMENTS = new Set([BLANK, "about:srcdoc"]);

const withoutFragment = (url: string) => url.split("#", 1)[0] ?? url;
export const isBlank = (url: string) => withoutFragment(url) === BLANK;
const isHostFrameDocument = (url: string) => isAppDocument(url) || EMBEDDED_DOCUMENTS.has(withoutFragment(url));

function keepOn(contents: WebContents, who: string, mainFrameMay: (url: string) => boolean, subframeMay: (url: string) => boolean): void {
  const check = (kind: string) => (details: Preventable) => {
    const may = details.isMainFrame === false ? subframeMay : mainFrameMay;
    if (may(details.url)) return;
    details.preventDefault();
    note("navigation", `kept the ${who} on its document: refused a ${kind} to a ${details.url.split(":", 1)[0]}: URL`);
  };
  contents.on("will-navigate", check("navigation"));
  contents.on("will-frame-navigate", check("frame navigation"));
  contents.on("will-redirect", check("redirect"));
}

export function guardHost(contents: WebContents): void {
  keepOn(contents, "host", isAppDocument, isHostFrameDocument);
}

export function guardAppWindow(contents: WebContents, name: string): void {
  keepOn(contents, `window ${name}`, isBlank, (url) => EMBEDDED_DOCUMENTS.has(withoutFragment(url)));
  contents.setWindowOpenHandler(({ url }) => {
    note("navigation", `window ${name} may not open windows: refused a ${url.split(":", 1)[0]}: URL`);
    return { action: "deny" };
  });
}

export function mayOpenFromHost(url: string, name: string, shaped: boolean): boolean {
  if (url === BLANK && shaped) return true;
  note("navigation", `the host may only open about:blank windows shaped through ArdiaAppWindows: refused ${shaped ? "shaped" : "unshaped"} window ${JSON.stringify(name)} to a ${url.split(":", 1)[0]}: URL`);
  return false;
}
