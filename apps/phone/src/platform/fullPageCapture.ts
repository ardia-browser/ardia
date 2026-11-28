import { scrollCaptureCount } from "../lib/telemetrySchema";
import { listenToPages } from "../state/pages/store";
import { countUsage } from "../state/telemetry/telemetry";

let started = false;

export function startFullPageCapture() {
  if (started) return;
  started = true;
  listenToPages((event) => {
    if (event.name === "pages.fullPagePdf") countUsage("full_page_pdf_provided");
    if (event.name === "pages.scrollCapture") for (const field of scrollCaptureCount(event.outcome)) countUsage(field);
  });
}
