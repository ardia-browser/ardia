import { app, dialog, type WebContents } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { note } from "../log";
import { isBackground } from "../paths";
import { downloadFolderOf } from "./downloads";
import { guestOf, windowOf, type Guest } from "./guests";

export const PAGE_PRINT_CHANNEL = "ardia:page-print";

export type PrintOutcome = "systemDialog" | "savedPdf" | "cancelled" | "failed";

const printing = new Set<number>();

const fileNameOf = (guest: Guest) => `${(guest.title || guest.contents.getTitle() || "page").replace(/[\\/:*?"<>|\n\r\t]+/g, " ").trim().slice(0, 120) || "page"}.pdf`;

async function hasPrinters(contents: WebContents): Promise<boolean> {
  try {
    return (await contents.getPrintersAsync()).length > 0;
  } catch {
    return false;
  }
}

function systemPrint(contents: WebContents): Promise<PrintOutcome> {
  return new Promise((resolve) => {
    contents.print({}, (printed, reason) => {
      if (!printed && reason && reason !== "Print job canceled" && reason !== "cancelled") note("print", `the system print dialog failed: ${reason}`);
      resolve(printed ? "systemDialog" : reason === "Print job canceled" || reason === "cancelled" ? "cancelled" : "failed");
    });
  });
}

async function chooseDestination(guest: Guest): Promise<string | null> {
  const folder = downloadFolderOf(guest.profile);
  await mkdir(folder, { recursive: true }).catch(() => {});
  const suggested = join(folder, fileNameOf(guest));
  if (isBackground()) return suggested;
  const window = windowOf(guest);
  const options = { title: "Save as PDF", defaultPath: suggested, buttonLabel: "Save", filters: [{ name: "PDF", extensions: ["pdf"] }] };
  const chosen = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  return chosen.canceled || !chosen.filePath ? null : chosen.filePath;
}

async function saveAsPdf(guest: Guest): Promise<PrintOutcome> {
  const destination = await chooseDestination(guest);
  if (!destination) return "cancelled";
  const pdf = await guest.contents.printToPDF({ printBackground: true, generateDocumentOutline: true });
  await writeFile(destination, pdf);
  note("print", `no printers: saved the page as a ${pdf.length} byte PDF${isBackground() ? ` at ${destination}` : ""}`);
  return "savedPdf";
}

export async function printPage(guest: Guest): Promise<PrintOutcome> {
  const id = guest.contents.id;
  if (printing.has(id)) return "cancelled";
  printing.add(id);
  try {
    if (await hasPrinters(guest.contents)) return await systemPrint(guest.contents);
    return await saveAsPdf(guest);
  } catch (error) {
    note("print", `printing failed: ${String((error as Error)?.message ?? error)}`);
    return "failed";
  } finally {
    printing.delete(id);
  }
}

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.on("ipc-message", (_event, channel) => {
    if (channel !== PAGE_PRINT_CHANNEL) return;
    const guest = guestOf(contents);
    if (guest) void printPage(guest);
  });
});
