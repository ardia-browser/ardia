import { Platform } from "react-native";
import { listenToPages } from "../state/pages/store";
import { countUsage } from "../state/telemetry/telemetry";

let started = false;

export function startFullPageCapture() {
  if (started || Platform.OS !== "ios") return;
  started = true;
  listenToPages((event) => {
    if (event.name === "pages.fullPagePdf") countUsage("full_page_pdf_provided");
  });
}
