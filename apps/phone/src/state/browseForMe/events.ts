import { browseForMe, type BrowseForMeEvent } from "../../platform/browseForMe";
import { openPage, searchFor } from "../browse/store";
import { closeSettings } from "../settings/nav";
import { browseForMeOffered } from "./offer";
import { noteBrowseForMe, refreshChatGPTConnected } from "./store";

let subscription: { remove(): void } | null = null;

function handle(event: BrowseForMeEvent) {
  noteBrowseForMe(event);
  if (event.name === "openSource") openPage(event.url, "search");
  if (event.name === "searchWeb") searchFor(event.query);
  if (event.name === "openLink") {
    closeSettings();
    openPage(event.url, "typed");
  }
}

export function listenForBrowseForMe() {
  if (subscription || !browseForMeOffered()) return;
  subscription = browseForMe.addListener(handle);
  void refreshChatGPTConnected();
}
